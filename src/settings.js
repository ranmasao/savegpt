/** Settings storage. v0.1 keeps only what the popup exposes. */

export const DEFAULT_SETTINGS = {
  schemaVersion: 1,
  frontmatter: true,
  timestamps: true,
  timestampFormat: 'datetime',
  labelUser: 'User',
  labelAssistant: 'ChatGPT',
  saveAs: false,
  // Off by default: it is the only setting that substitutes characters inside a
  // message body, so opting in has to be deliberate.
  convertMath: false,
};

export async function loadSettings() {
  const stored = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

export async function saveSettings(settings) {
  await chrome.storage.sync.set({ settings });
}
