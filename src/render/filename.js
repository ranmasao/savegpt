/** Download filename construction. Pure. */

import { toDateStamp } from './timestamp.js';

// Filesystem-illegal characters and control characters. Whitespace collapses on
// the next step of the pipeline.
const ILLEGAL = new RegExp('[<>:"/\\\\|?*\\x00-\\x1f]', 'g');

export function sanitizeStem(title) {
  const cleaned = String(title || '')
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
    .replace(/[-.]+$/g, '');

  return cleaned || 'chatgpt-conversation';
}

export function buildFilename(conversation) {
  const stem = sanitizeStem(conversation.title);
  const stamp = toDateStamp(conversation.createTime);
  return `${stem}-${stamp}.md`;
}
