/**
 * Runs the real extraction and renderer against saved backend payloads.
 *
 * Payloads are not committed - they are personal conversations. Point the
 * suite at a directory of `*.raw.json` files saved with the popup's debug link:
 *
 *   SAVEGPT_FIXTURES=/path/to/dir npm run payloads
 *
 * With no fixtures present it skips, so it never fails a clean checkout.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { conversationFromPayload, branchFromMapping } from '../src/extract/mapping.js';
import { renderMarkdown } from '../src/render/markdown.js';

const dir = process.env.SAVEGPT_FIXTURES;
if (!dir || !fs.existsSync(dir)) {
  console.log('skip - set SAVEGPT_FIXTURES to a directory containing *.raw.json');
  process.exit(0);
}

const files = fs.readdirSync(dir).filter((name) => name.endsWith('.raw.json'));
if (files.length === 0) {
  console.log(`skip - no *.raw.json in ${dir}`);
  process.exit(0);
}

/** The reference parser from README.md. */
function parse(markdown) {
  const marker = markdown.match(/^savegpt_marker: (\S+)$/m)[1];
  const frame = new RegExp(
    `^<!-- savegpt:${marker} begin ([^>]*?) -->\\n(.*?)\\n<!-- savegpt:${marker} end index=(\\d+) -->$`,
    'gms'
  );
  return [...markdown.matchAll(frame)].map(([, attrText, block, endIndex]) => {
    const attrs = Object.fromEntries(
      [...attrText.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)].map(([, k, v]) => [
        k,
        v.startsWith('"') ? JSON.parse(v) : v,
      ])
    );
    return {
      attrs,
      endIndex: Number(endIndex),
      body: block.split('\n').slice(2).join('\n').trim(),
    };
  });
}

/** What a body should contain, straight from the payload. */
function expectedBody(message) {
  return message.parts
    .map((part) => {
      if (part.kind === 'markdown') return part.text;
      if (part.kind === 'image') return part.text ? `> [image: ${part.text}]` : '> [image]';
      return null;
    })
    .filter((text) => text !== null)
    .join('\n\n')
    .trim();
}

let checked = 0;

for (const name of files) {
  const payload = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const conversation = conversationFromPayload(payload);
  const markdown = renderMarkdown(conversation);
  const frames = parse(markdown);
  const label = name.replace('.raw.json', '');

  assert.equal(frames.length, conversation.messages.length, `${label}: one frame per message`);

  frames.forEach((frame, i) => {
    const message = conversation.messages[i];
    assert.equal(Number(frame.attrs.index), i + 1, `${label}: begin index`);
    assert.equal(frame.endIndex, i + 1, `${label}: end index`);
    assert.equal(frame.attrs.role, message.role, `${label}: role of frame ${i + 1}`);

    // Bodies come back exactly, minus any declared fence repair.
    const body = frame.attrs.fence_repaired
      ? frame.body.split('\n').slice(0, -1).join('\n')
      : frame.body;
    assert.equal(body, expectedBody(message), `${label}: body of frame ${i + 1} is verbatim`);
  });

  // Every visible node on the current branch is either exported or declared.
  const visible = branchFromMapping(payload).filter(
    (node) =>
      node.message &&
      !node.message.metadata?.is_visually_hidden_from_conversation &&
      node.message.author?.role !== 'system'
  );
  const declared =
    conversation.omissions.tools || conversation.omissions.thoughts
      ? 'declared'
      : 'none';
  assert.ok(
    conversation.messages.length === visible.length || declared === 'declared',
    `${label}: dropped ${visible.length - conversation.messages.length} visible nodes without declaring it`
  );

  // No two consecutive turns from the same speaker: that is the signature of a
  // dropped reply, which is how the missing generated images were found.
  const runs = [];
  frames.forEach((frame) => {
    const last = runs[runs.length - 1];
    if (last && last.role === frame.attrs.role) last.count += 1;
    else runs.push({ role: frame.attrs.role, count: 1, at: frame.endIndex });
  });
  const doubled = runs.filter((run) => run.count > 1 && run.role === 'user');
  assert.equal(
    doubled.length,
    0,
    `${label}: ${doubled.length} run(s) of consecutive user turns - a reply was dropped (first near turn ${doubled[0]?.at})`
  );

  // No private-use codepoints may reach the file: those are ChatGPT's internal
  // citation markers, which render as garbage outside its own client.
  const stray = [...markdown].filter((char) => {
    const point = char.codePointAt(0);
    return point >= 0xe000 && point <= 0xf8ff;
  });
  assert.equal(stray.length, 0, `${label}: ${stray.length} private-use marker chars leaked`);
  assert.ok(!/citeturn\d/.test(markdown), `${label}: unresolved citation marker text`);
  assert.ok(!/entity\["/.test(markdown), `${label}: unresolved entity marker text`);

  const images = conversation.messages.filter((m) => m.parts.some((p) => p.kind === 'image'));
  console.log(
    `ok - ${label}: ${frames.length} turns, ${images.length} with images, ` +
      `omitted=[${Object.entries(conversation.omissions).filter(([, v]) => v).map(([k]) => k).join(',') || 'none'}]`
  );
  checked += 1;
}

console.log(`\nok - ${checked} payload(s) verified`);
