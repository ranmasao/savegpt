import assert from 'node:assert/strict';
import { fetchPaginatedConversation } from '../src/extract/pagination.js';
import { conversationFromPayload } from '../src/extract/mapping.js';

const message = (id, role, text) => ({
  id, author: { role }, content: { content_type: 'text', parts: [text] },
});
const first = {
  conversation_id: 'chat', title: 'Test',
  messages: [message('3', 'user', 'second question'), message('4', 'assistant', 'second answer')],
  page_info: { has_previous_page: true, has_next_page: false, start_cursor: '3' },
};
const older = {
  messages: [message('1', 'user', 'first question'), message('2', 'assistant', 'first answer')],
  page_info: { has_previous_page: false, has_next_page: true, start_cursor: '1' },
};
const urls = [];
const result = await fetchPaginatedConversation('chat', async (url) => {
  urls.push(url);
  return urls.length === 1 ? first : older;
});
assert.match(urls[0], /^\/backend-api\/conversations\/chat\?/);
assert.match(urls[1], /^\/backend-api\/conversations\/chat\/messages\?before=3&/);
assert.deepEqual(conversationFromPayload(result).messages.map((m) => m.parts[0].text), [
  'first question', 'first answer', 'second question', 'second answer',
]);
await assert.rejects(fetchPaginatedConversation('chat', async () => first), /duplicate message/);
await assert.rejects(fetchPaginatedConversation('chat', async () => ({ ...first, page_info: {} })), /pagination response/);
await assert.rejects(fetchPaginatedConversation('chat', async () => ({
  ...first, page_info: { ...first.page_info, start_cursor: 'wrong' },
})), /did not reach the beginning/);
await assert.rejects(fetchPaginatedConversation('chat', async () => ({
  ...first, page_info: { ...first.page_info, has_next_page: true },
})), /latest page/);
console.log('ok - paginated conversation exports all pages and rejects incomplete history');
