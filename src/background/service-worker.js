/**
 * Service worker.
 *
 * v0.1 does almost nothing: the popup drives extraction, rendering, and the
 * download. This exists so the extension has a stable place for work that must
 * outlive the popup, and to keep the manifest honest about it.
 */

chrome.runtime.onInstalled.addListener(() => {
  // Placeholder for future migrations of stored settings.
});
