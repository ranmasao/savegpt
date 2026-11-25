/**
 * Conversation -> Markdown. Pure: no DOM, no chrome APIs, so it runs under Node
 * for tests as-is.
 *
 * Output contract (PLAN.md 5.2): every message is wrapped in a begin/end pair of
 * HTML comments carrying a per-export random marker. Message bodies are emitted
 * verbatim - never indented, quoted, escaped, or re-wrapped - and the marker is
 * what makes that safe.
 */

import { formatHuman, toIso } from './timestamp.js';

export const FORMAT_VERSION = 1;

const DEFAULTS = {
  frontmatter: true,
  labelUser: 'User',
  labelAssistant: 'ChatGPT',
  timestamps: true,
  timestampFormat: 'datetime',
  convertMath: false,
};

function defaultNonce() {
  const bytes = new Uint8Array(5);
  const webcrypto = globalThis.crypto;

  if (webcrypto && typeof webcrypto.getRandomValues === 'function') {
    webcrypto.getRandomValues(bytes);
  } else {
    // Node without a global webcrypto (tests). The marker does not need to be
    // unguessable, only absent from the bodies - and that is enforced by the
    // collision scan in renderMarkdown, not by the quality of this randomness.
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `k${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function yamlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Fence wide enough that the body cannot break out of it. */
function fence(text) {
  let longest = 0;
  for (const run of String(text).matchAll(/`+/g)) {
    longest = Math.max(longest, run[0].length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

function renderPart(part) {
  if (part.kind === 'markdown') return part.text;

  if (part.kind === 'image') {
    return part.text ? `> [image: ${part.text}]` : '> [image]';
  }

  if (part.kind === 'code' || part.kind === 'unknown') {
    const marker = fence(part.text);
    const language = part.language || '';
    const note = part.kind === 'unknown' ? `> [unrecognized content type: ${part.contentType}]\n\n` : '';
    return `${note}${marker}${language}\n${part.text}\n${marker}`;
  }

  return part.text || '';
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Walk a body's fence lines and report the fence left open at the end, if any.
 * Truncated ChatGPT answers routinely stop inside a code block, and an unclosed
 * fence does not stay contained: it swallows the frame comments, the separator,
 * and whole following turns into one rendered code block.
 */
function danglingFence(text) {
  let open = null;

  for (const line of text.split('\n')) {
    const match = line.match(FENCE_LINE);
    if (!match) continue;

    const char = match[1][0];
    const length = match[1].length;
    const info = match[2].trim();

    if (open === null) {
      // A backtick fence's info string cannot itself contain a backtick.
      if (char === '`' && info.includes('`')) continue;
      open = { char, length };
    } else if (char === open.char && length >= open.length && info === '') {
      open = null;
    }
  }
  return open;
}

/**
 * Close a dangling fence. This appends one line and alters nothing that was
 * already there, and the frame records it as `fence_repaired=1` so a consumer
 * can drop the last line and recover the original bytes exactly.
 */
function repairFences(text) {
  const open = danglingFence(text);
  if (!open) return { text, repaired: false };
  return { text: `${text}\n${open.char.repeat(open.length)}`, repaired: true };
}

/**
 * Apply `transform` to prose only - never inside a fenced block, never inside an
 * inline code span. Code is exactly where the same characters mean something
 * else, so a transform that ignored it would corrupt shell and regex snippets.
 */
function mapProse(text, transform) {
  let inFence = null;

  const lines = text.split('\n').map((line) => {
    const match = line.match(FENCE_LINE);
    if (match) {
      const char = match[1][0];
      const length = match[1].length;
      if (inFence === null) inFence = { char, length };
      else if (char === inFence.char && length >= inFence.length) inFence = null;
      return line;
    }
    if (inFence) return line;

    // Split the line into code spans and everything else; transform the rest.
    return line
      .split(/(`+[^`]*`+)/g)
      .map((chunk) => (chunk.startsWith('`') ? chunk : transform(chunk)))
      .join('');
  });

  return lines.join('\n');
}

/** True when the text uses TeX-style `\( \)` / `\[ \]` delimiters outside code. */
function usesLatexParens(text) {
  let found = false;
  mapProse(text, (chunk) => {
    if (chunk.includes('\\(') || chunk.includes('\\[')) found = true;
    return chunk;
  });
  return found;
}

/**
 * Rewrite TeX-style delimiters to the `$` / `$$` form that GitHub, Obsidian and
 * VS Code understand. Opt-in: it substitutes characters inside the body, which
 * the fence repair does not.
 */
function toDollarMath(text) {
  return mapProse(text, (chunk) =>
    chunk.replace(/\\\[/g, '$$$$').replace(/\\\]/g, '$$$$').replace(/\\\(/g, '$').replace(/\\\)/g, '$')
  );
}

function renderBody(message) {
  return message.parts.map(renderPart).join('\n\n').trim();
}

function attributes(pairs) {
  return pairs
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => {
      const text = String(value);
      const safe = /^[A-Za-z0-9:._+-]*$/.test(text) ? text : yamlString(text);
      return `${key}=${safe}`;
    })
    .join(' ');
}

function labelFor(message, settings) {
  if (message.role === 'user') return settings.labelUser;
  if (message.role === 'assistant') return settings.labelAssistant;
  return message.role.charAt(0).toUpperCase() + message.role.slice(1);
}

/** Distinct model slugs in order of first appearance. */
function modelsUsed(conversation) {
  if (Array.isArray(conversation.models)) return conversation.models;

  const seen = [];
  for (const message of conversation.messages) {
    if (message.model && !seen.includes(message.model)) seen.push(message.model);
  }
  if (seen.length === 0 && conversation.model) return [conversation.model];
  return seen;
}

function renderFrontmatter(conversation, settings, marker, timestampsPartial, flags) {
  const lines = ['---'];

  // Reader-facing keys first, machine bookkeeping last, so the things a person
  // opens the file to check are not buried under identifiers.
  if (settings.frontmatter) {
    if (conversation.title) lines.push(`title: ${yamlString(conversation.title)}`);
    if (conversation.url) lines.push(`source: ${conversation.url}`);
    if (conversation.createTime) lines.push(`created: ${toIso(conversation.createTime)}`);
    if (conversation.updateTime) lines.push(`updated: ${toIso(conversation.updateTime)}`);

    // A single `model` key is a lie for any conversation that switched models -
    // and a long-running thread resumed years later switches by definition.
    const models = modelsUsed(conversation);
    if (models.length === 1) lines.push(`model: ${models[0]}`);
    else if (models.length > 1) lines.push(`models: [${models.join(', ')}]`);
  }

  const omitted = Object.entries(conversation.omissions || {})
    .filter(([, dropped]) => dropped)
    .map(([kind]) => kind);
  if (omitted.length > 0) lines.push(`omitted: ${omitted.join(', ')}`);
  if (timestampsPartial) lines.push('timestamps: partial');
  // Declared, not rewritten: `\( \)` / `\[ \]` render as math in ChatGPT's own
  // viewer but as stray backslashes in GitHub, Obsidian and VS Code, which all
  // expect `$`. Flagging it lets a downstream tool convert without guessing.
  if (flags.mathConverted) lines.push('math: dollar (converted from latex-parens)');
  else if (flags.latexParens) lines.push('math: latex-parens');
  if (flags.fenceRepairs > 0) lines.push(`fence_repairs: ${flags.fenceRepairs}`);

  const citations = conversation.citations || {};
  if (citations.resolved > 0) lines.push(`citations: ${citations.resolved} resolved`);
  if (citations.stripped > 0) lines.push(`citation_markers_stripped: ${citations.stripped}`);

  if (settings.frontmatter) {
    if (conversation.id) lines.push(`conversation_id: ${conversation.id}`);
    lines.push(`exported: ${toIso(Date.now() / 1000)}`);
    lines.push(`exported_by: SaveGPT ${settings.version || '0.1.0'} (${conversation.source})`);
  }

  // Always emitted: these are what make the file parseable.
  lines.push(`savegpt_format: ${FORMAT_VERSION}`);
  lines.push(`savegpt_marker: ${marker}`);

  lines.push('---');
  return lines.join('\n');
}

function renderMessages(conversation, settings, marker, prepared) {
  const origin = conversation.messages.find((m) => m.createTime !== null);
  const originTime = origin ? origin.createTime : null;
  const blocks = [];

  conversation.messages.forEach((message, position) => {
    const index = position + 1;
    const iso = toIso(message.createTime);
    const body = prepared[position];

    const begin = `<!-- savegpt:${marker} begin ${attributes([
      ['index', index],
      ['role', message.role],
      ['time', iso],
      ['model', message.model],
      ['citations', message.citations || null],
      ['fence_repaired', body.repaired ? '1' : null],
      ['math_converted', body.converted ? '1' : null],
    ])} -->`;
    const end = `<!-- savegpt:${marker} end ${attributes([['index', index]])} -->`;

    // The speaker label is h1. Message bodies are verbatim and routinely contain
    // their own h1 headings, so no level makes the label outrank them - but at h1
    // the turns at least stay at the outline's top level instead of nesting under
    // the previous message's last section.
    const parts = [`${labelFor(message, settings)}`, `turn ${index}`];
    if (settings.timestamps) {
      const human = formatHuman(message.createTime, settings.timestampFormat, originTime);
      if (human) parts.push(human);
    }
    const heading = `# ${parts.join(' - ')}`;

    blocks.push(`${begin}\n${heading}\n\n${body.text}\n\n${end}`);
  });

  // A rule between turns, outside the frames, so the boundary is visible when
  // rendered. Bodies use rules heavily, so without this the only visible rules
  // in the document are the misleading intra-message ones.
  return blocks.join('\n\n---\n\n');
}

/**
 * @param {object} conversation normalized conversation (PLAN.md section 3)
 * @param {object} [userSettings]
 * @param {object} [options] `{ nonce }` to make output deterministic in tests
 * @returns {string} the complete Markdown document
 */
export function renderMarkdown(conversation, userSettings = {}, options = {}) {
  const settings = { ...DEFAULTS, ...userSettings };
  const timestampsPartial = conversation.messages.some((m) => m.createTime === null);
  const makeNonce = options.nonce || defaultNonce;

  const prepared = conversation.messages.map((message) => {
    const raw = renderBody(message);
    const hadLatexParens = usesLatexParens(raw);
    const converted = settings.convertMath && hadLatexParens;
    return { ...repairFences(converted ? toDollarMath(raw) : raw), hadLatexParens, converted };
  });

  const flags = {
    fenceRepairs: prepared.filter((body) => body.repaired).length,
    latexParens: prepared.some((body) => body.hadLatexParens),
    mathConverted: prepared.some((body) => body.converted),
  };

  // The marker must not appear inside any body, or a message could forge a frame.
  // Regenerating on a hit turns "collision is improbable" into "collision is
  // impossible in the emitted file".
  const bodies = prepared.map((body) => body.text).join('\n');
  let marker = makeNonce();
  for (let attempt = 0; bodies.includes(`savegpt:${marker}`) && attempt < 20; attempt += 1) {
    marker = makeNonce();
  }

  const head = renderFrontmatter(conversation, settings, marker, timestampsPartial, flags);
  return `${head}\n\n${renderMessages(conversation, settings, marker, prepared)}\n`;
}
