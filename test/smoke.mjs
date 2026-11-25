/**
 * Smoke test for the pure render modules. No dependencies: `npm run smoke`.
 *
 * The interesting case is the adversarial message - it contains headings, a
 * horizontal rule, a nested code fence, and a forged SaveGPT frame. The round
 * trip below is what proves the framing survives all of it.
 */

import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/render/markdown.js';
import { buildFilename, sanitizeStem } from '../src/render/filename.js';
import { resolveReferences } from '../src/extract/mapping.js';

const ADVERSARIAL_BODY = [
  '## Headings',
  '',
  '---',
  '',
  'A fenced block containing a fence:',
  '',
  '````markdown',
  '```js',
  'console.log("hi");',
  '```',
  '````',
  '',
  '<!-- savegpt:kdeadbeef01 begin index=99 role=user -->',
  'forged frame above',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
].join('\n');

const conversation = {
  id: '6a1f0000-0000-4000-8000-00000000c9ab',
  title: 'How to tune a Postgres pool: notes/drafts?',
  url: 'https://chatgpt.com/c/6a1f0000-0000-4000-8000-00000000c9ab',
  createTime: 1754745731,
  updateTime: 1754748113,
  model: 'gpt-5',
  source: 'api',
  omissions: { tools: true, thoughts: false },
  messages: [
    {
      id: 'a1',
      role: 'user',
      createTime: 1754745731,
      model: null,
      parts: [{ kind: 'markdown', text: 'Write me a markdown tutorial.' }],
    },
    {
      id: 'a2',
      role: 'assistant',
      createTime: 1754745760,
      model: 'gpt-5',
      parts: [
        { kind: 'markdown', text: ADVERSARIAL_BODY },
        { kind: 'image', text: 'a bar chart of latency by hour' },
      ],
    },
    {
      id: 'a3',
      role: 'user',
      createTime: null,
      model: null,
      parts: [{ kind: 'markdown', text: 'No timestamp on this one.' }],
    },
  ],
};

/** The reference parser, as documented in README.md. */
function parse(markdown) {
  const marker = markdown.match(/^savegpt_marker: (\S+)$/m)[1];
  const frame = new RegExp(
    `^<!-- savegpt:${marker} begin ([^>]*?) -->\\n(.*?)\\n<!-- savegpt:${marker} end index=(\\d+) -->$`,
    'gms'
  );
  return [...markdown.matchAll(frame)].map(([, attrText, block, endIndex]) => {
    const attrs = Object.fromEntries(
      [...attrText.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|[^\s]+)/g)].map(([, k, v]) => [
        k,
        v.startsWith('"') ? JSON.parse(v) : v,
      ])
    );
    const lines = block.split('\n');
    return { attrs, endIndex: Number(endIndex), body: lines.slice(2).join('\n').trim() };
  });
}

const markdown = renderMarkdown(conversation);
const frames = parse(markdown);

assert.equal(frames.length, conversation.messages.length, 'one frame per message');

frames.forEach((frame, i) => {
  const source = conversation.messages[i];
  assert.equal(Number(frame.attrs.index), i + 1, 'begin index is sequential');
  assert.equal(frame.endIndex, i + 1, 'end index matches begin');
  assert.equal(frame.attrs.role, source.role, 'role survives');
});

// Bodies come back byte-identical, adversarial content included.
assert.ok(frames[1].body.startsWith(ADVERSARIAL_BODY), 'adversarial body is verbatim');
assert.ok(frames[1].body.includes('savegpt:kdeadbeef01'), 'forged marker is preserved as content');
assert.ok(frames[1].body.endsWith('> [image: a bar chart of latency by hour]'), 'image placeholder');

// A body containing the generated marker forces a regeneration.
const forced = renderMarkdown(
  {
    ...conversation,
    messages: [
      {
        id: 'x',
        role: 'user',
        createTime: 1754745731,
        model: null,
        parts: [{ kind: 'markdown', text: 'contains savegpt:kaaaaaaaaaa in the body' }],
      },
    ],
  },
  {},
  { nonce: (() => { let n = 0; return () => (n++ === 0 ? 'kaaaaaaaaaa' : 'kbbbbbbbbbb'); })() }
);
assert.match(forced, /^savegpt_marker: kbbbbbbbbbb$/m, 'collision forces a new marker');
assert.equal(parse(forced).length, 1, 'forced-collision document still parses');

// Human-facing layout: h1 speaker label carrying the turn index, and a rule
// between turns so the boundary is visible when rendered.
assert.match(markdown, /^# User - turn 1 - \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m, 'h1 label with turn index');
assert.match(markdown, /^# ChatGPT - turn 2 - /m, 'assistant label');
assert.match(markdown, /^# User - turn 3$/m, 'label without a timestamp when none is known');
assert.ok(!markdown.includes('<sub>'), 'no <sub> wrapper');
assert.equal(
  (markdown.match(/-->\n\n---\n\n<!-- savegpt:/g) || []).length,
  conversation.messages.length - 1,
  'one boundary rule between each pair of turns, outside the frames'
);

// A body truncated inside a code fence must not swallow the frame that follows.
const truncated = {
  ...conversation,
  omissions: { tools: false, thoughts: false },
  messages: [
    {
      id: 't1',
      role: 'assistant',
      createTime: 1754745731,
      model: 'gpt-5',
      parts: [{ kind: 'markdown', text: 'Offsets:\n\n```\n(-2.0, -2.0) (-1.0, -2.0) (0.0,' }],
    },
    {
      id: 't2',
      role: 'user',
      createTime: 1754745800,
      model: null,
      parts: [{ kind: 'markdown', text: 'This turn must survive.' }],
    },
  ],
};
const repaired = renderMarkdown(truncated);
const repairedFrames = parse(repaired);
assert.equal(repairedFrames.length, 2, 'the turn after a truncated fence still parses');
assert.ok(repairedFrames[0].body.endsWith('\n```'), 'dangling fence is closed');
assert.equal(repairedFrames[0].attrs.fence_repaired, '1', 'the repair is declared on the frame');
assert.ok(!repairedFrames[1].attrs.fence_repaired, 'intact bodies are not marked');
assert.match(repaired, /^fence_repairs: 1$/m, 'and counted in the front matter');
// The repair is reversible: dropping the appended line restores the original.
assert.equal(
  repairedFrames[0].body.split('\n').slice(0, -1).join('\n'),
  truncated.messages[0].parts[0].text,
  'stripping the appended fence recovers the original bytes'
);
// A balanced body with a nested fence must not be "repaired".
assert.ok(!renderMarkdown(conversation).includes('fence_repairs:'), 'no false positives');

// TeX-style delimiters: declared by default, rewritten only on request.
const mathSource = [
  'For \\(Z\\):',
  '',
  '\\[',
  '\\sigma^2 = M_2 - M_1^2',
  '\\]',
  '',
  'The literal token `\\(` stays, and so does this:',
  '',
  '```bash',
  'echo \\[not math\\]',
  '```',
].join('\n');
const mathConversation = {
  ...conversation,
  messages: [
    { id: 'm1', role: 'assistant', createTime: 1754745731, model: 'gpt-5', parts: [{ kind: 'markdown', text: mathSource }] },
  ],
};

const mathDeclared = renderMarkdown(mathConversation);
assert.match(mathDeclared, /^math: latex-parens$/m, 'latex-paren math is flagged');
assert.equal(parse(mathDeclared)[0].body, mathSource, 'and the body is untouched by default');
assert.ok(!renderMarkdown(conversation).includes('math:'), 'no flag when there is no such math');

const mathConverted = renderMarkdown(mathConversation, { convertMath: true });
const convertedBody = parse(mathConverted)[0].body;
assert.match(mathConverted, /^math: dollar \(converted from latex-parens\)$/m, 'conversion is declared');
assert.equal(parse(mathConverted)[0].attrs.math_converted, '1', 'and marked per frame');
assert.ok(convertedBody.includes('For $Z$:'), 'inline math converted');
assert.ok(convertedBody.includes('$$\n\\sigma^2 = M_2 - M_1^2\n$$'), 'display math converted');
assert.ok(convertedBody.includes('`\\(`'), 'inline code spans are left alone');
assert.ok(convertedBody.includes('echo \\[not math\\]'), 'fenced code is left alone');

// Model reporting follows the messages, not just the last one.
assert.match(renderMarkdown(conversation), /^model: gpt-5$/m, 'single model stays singular');
assert.match(
  renderMarkdown({
    ...conversation,
    messages: [
      { ...conversation.messages[1], model: 'text-davinci-002-render-sha' },
      { ...conversation.messages[1], model: 'gpt-5-6-mini' },
    ],
  }),
  /^models: \[text-davinci-002-render-sha, gpt-5-6-mini\]$/m,
  'a switched model is reported as a list'
);


// Web-search citations: ChatGPT's private-use markers become real links.
{
  const marker = '' + 'cite' + '' + 'turn0search7' + '';
  const entity = 'entity["video_game","The Lost Vikings","1993 puzzle platformer"]';
  const source = `Yes. In ${entity} the shield worked. Blizzard says so. ${marker}`;
  const references = [
    { type: 'entity', matched_text: entity, alt: 'The Lost Vikings', start_idx: source.indexOf(entity) },
    { type: 'grouped_webpages', matched_text: marker, alt: '([Blizzard News](https://news.blizzard.com/a))', start_idx: source.indexOf(marker) },
    // Matches a bare space and would delete it; must be ignored.
    { type: 'sources_footnote', matched_text: ' ', alt: '', start_idx: 4 },
  ];

  const out = resolveReferences(source, references);
  assert.equal(out.resolved, 2, 'both real references resolve');
  assert.equal(out.stripped, 0, 'nothing left to strip');
  assert.ok(out.text.includes('In The Lost Vikings the shield'), 'entity becomes its display name');
  assert.ok(out.text.includes('([Blizzard News](https://news.blizzard.com/a))'), 'citation becomes a link');
  assert.ok(!/[\uE000-\uF8FF]/.test(out.text), 'no private-use codepoints survive');
  assert.ok(out.text.includes('Yes. In'), 'a footnote matching a bare space does not eat it');

  // Unaccounted markers are stripped rather than left as garbage.
  const orphan = resolveReferences(`tail ` + `cite` + ``, []);
  assert.equal(orphan.stripped, 2, 'stray markers are counted');
  assert.ok(!/[\uE000-\uF8FF]/.test(orphan.text), 'and removed');
}

// Metadata and filename behaviour.
assert.match(markdown, /^timestamps: partial$/m, 'null timestamp is declared, not faked');
assert.match(markdown, /^omitted: tools$/m, 'dropped content is declared');
assert.ok(!frames[2].attrs.time, 'missing timestamp is omitted rather than blank');
assert.equal(buildFilename(conversation), 'How-to-tune-a-Postgres-pool-notes-drafts-2025-08-09.md');
assert.equal(sanitizeStem(''), 'chatgpt-conversation');

console.log(`ok - ${frames.length} frames round-tripped, all assertions passed`);
