/**
 * The only place that knows how bytes reach disk.
 *
 * Runs in the popup, which is a real document and therefore has
 * URL.createObjectURL - an MV3 service worker does not (PLAN.md 6.2).
 *
 * Revocation has to happen here too: a blob URL can only be revoked by the
 * context that created it, so the service worker cannot do it on our behalf.
 * We wait for the download to settle, then revoke. If the popup is closed
 * first, its context is torn down and the URL goes with it - harmless for the
 * small text files this extension produces, which settle in milliseconds.
 */

const SETTLE_TIMEOUT_MS = 15000;

function whenSettled(downloadId) {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, SETTLE_TIMEOUT_MS);

    function onChanged(delta) {
      if (delta.id !== downloadId) return;
      const state = delta.state && delta.state.current;
      if (state === 'complete' || state === 'interrupted') finish(state);
    }

    function finish(state) {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(state || 'timeout');
    }

    chrome.downloads.onChanged.addListener(onChanged);
  });
}

export async function saveText(filename, text, { saveAs = false, mimeType = 'text/markdown' } = {}) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mimeType};charset=utf-8` }));

  let downloadId;
  try {
    downloadId = await chrome.downloads.download({ url, filename, saveAs });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }

  const state = await whenSettled(downloadId);
  URL.revokeObjectURL(url);

  if (state === 'interrupted') {
    throw new Error('The browser interrupted the download.');
  }
  return downloadId;
}
