// Read the active branch from newest to oldest, and reject incomplete exports.
export async function fetchPaginatedConversation(id, getJson) {
  const base = `/backend-api/conversations/${encodeURIComponent(id)}`;
  const query = new URLSearchParams({ num_turns: '10', include_has_versions: 'true' });
  const initial = await getJson(`${base}?${query}`);
  if (initial.conversation_id && initial.conversation_id !== id) {
    throw new Error('Conversation response has a different conversation id.');
  }

  const pages = [];
  const seenCursors = new Set();
  const seenMessages = new Set();
  let page = initial;
  while (true) {
    const info = page && page.page_info;
    if (!Array.isArray(page?.messages) || !info || typeof info.has_previous_page !== 'boolean') {
      throw new Error('Invalid conversation pagination response; export stopped.');
    }
    if (pages.length === 0 && info.has_next_page !== false) {
      throw new Error('Conversation response does not confirm the latest page; export stopped.');
    }
    for (const message of page.messages) {
      if (!message || typeof message.id !== 'string' || !message.id || seenMessages.has(message.id)) {
        throw new Error('Invalid or duplicate message in conversation pages; export stopped.');
      }
      seenMessages.add(message.id);
    }
    pages.push(page.messages);
    if (!info.has_previous_page) break;
    const cursor = info.start_cursor;
    if (!page.messages.length || typeof cursor !== 'string' || !cursor ||
        cursor !== page.messages[0].id || seenCursors.has(cursor) || pages.length >= 1000) {
      throw new Error('Conversation pagination did not reach the beginning; export stopped.');
    }
    seenCursors.add(cursor);
    const params = new URLSearchParams({ before: cursor, num_turns: '10', include_has_versions: 'true' });
    page = await getJson(`${base}/messages?${params}`);
  }
  return { ...initial, messages: pages.reverse().flat(), page_info: page.page_info };
}
