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
    const { requestWithRetry } = await import(chrome.runtime.getURL('src/extract/request.js'));
    const request = async (path, token) =>
      fetch(path, {
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });

    async function getResponse(path) {
      let token = await getAccessToken(false);
      let response = await requestWithRetry(() => request(path, token));
      if (response.status === 401 || response.status === 403) {
        token = await getAccessToken(true);
        response = await requestWithRetry(() => request(path, token));
      }
      return response;
    }
    function checkResponse(response) {
      if (!response.ok) {
        throw new SaveGptError(
          response.status >= 500 ? 'SERVER_ERROR' : 'FETCH_FAILED',
          `Conversation request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ''}).`
        );
      }
      return response.json();
    }

    const response = await getResponse(`/backend-api/conversation/${id}`);
    if (response.status >= 500) {
      const { fetchPaginatedConversation } = await import(chrome.runtime.getURL('src/extract/pagination.js'));
      return fetchPaginatedConversation(id, async (path) => checkResponse(await getResponse(path)));
    }
    return checkResponse(response);
  }

  async function extract(includeRaw) {
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
    return includeRaw ? { conversation, raw: payload } : { conversation };
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (!request || request.type !== 'SAVEGPT_EXTRACT') return false;

    extract(request.includeRaw === true)
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
