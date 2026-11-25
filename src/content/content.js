/**
 * SaveGPT content script.
 *
 * Runs in the page origin, so fetches to chatgpt.com carry the session cookies.
 * Its only jobs are authentication and fetching; turning the payload into the
 * normalized Conversation lives in ../extract/mapping.js, which is a plain
 * module so tests can run it under Node against saved payloads.
 *
 * A declared content script cannot use static `import`, but it can dynamically
 * import an extension URL listed in web_accessible_resources - which is how
 * production and the test suite end up sharing one implementation.
 */

(() => {
  if (window.__savegptContentLoaded) return;
  window.__savegptContentLoaded = true;

  const CONVERSATION_ID_PATTERNS = [
    /^\/c\/([0-9a-f-]{36})/i,
    /^\/g\/[^/]+\/c\/([0-9a-f-]{36})/i,
  ];

  let cachedToken = null;
  let mappingModule = null;

  class SaveGptError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  async function loadMapping() {
    if (!mappingModule) {
      mappingModule = await import(chrome.runtime.getURL('src/extract/mapping.js'));
    }
    return mappingModule;
  }

  function conversationIdFromUrl() {
    for (const pattern of CONVERSATION_ID_PATTERNS) {
      const match = location.pathname.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  async function getAccessToken(forceRefresh) {
    if (cachedToken && !forceRefresh) return cachedToken;

    const response = await fetch('/api/auth/session', { credentials: 'include' });
    if (!response.ok) {
      throw new SaveGptError('NOT_SIGNED_IN', `Session request failed (${response.status}).`);
    }
    const session = await response.json();
    if (!session || !session.accessToken) {
      throw new SaveGptError('NOT_SIGNED_IN', 'No access token in the session response.');
    }
    cachedToken = session.accessToken;
    return cachedToken;
  }

  async function fetchConversation(id) {
    const request = async (token) =>
      fetch(`/backend-api/conversation/${id}`, {
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });

    let response = await request(await getAccessToken(false));
    if (response.status === 401 || response.status === 403) {
      // Tokens are short-lived; refresh once before giving up.
      response = await request(await getAccessToken(true));
    }
    if (!response.ok) {
      throw new SaveGptError(
        'FETCH_FAILED',
        `Conversation request failed (${response.status} ${response.statusText}).`
      );
    }
    return response.json();
  }

  async function extract() {
    const conversationId = conversationIdFromUrl();
    if (!conversationId) {
      throw new SaveGptError(
        'NO_CONVERSATION',
        'No conversation id in the URL. Open a saved conversation (the URL should look like /c/<id>).'
      );
    }

    const { conversationFromPayload } = await loadMapping();
    const payload = await fetchConversation(conversationId);
    const conversation = conversationFromPayload(payload, {
      conversationId,
      origin: location.origin,
    });

    if (conversation.messages.length === 0) {
      throw new SaveGptError('EMPTY', 'No exportable messages found in this conversation.');
    }
    return { conversation, raw: payload };
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (!request || request.type !== 'SAVEGPT_EXTRACT') return false;

    extract()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          code: error.code || 'UNKNOWN',
          message: error.message || String(error),
        })
      );

    return true; // keep the message channel open for the async response
  });
})();
