import { renderMarkdown } from '../render/markdown.js';
import { buildFilename, sanitizeStem } from '../render/filename.js';
import { toDateStamp } from '../render/timestamp.js';
import { loadSettings, saveSettings } from '../settings.js';
import { saveText } from '../download.js';

const ui = {
  save: document.getElementById('save'),
  saveJson: document.getElementById('saveJson'),
  status: document.getElementById('status'),
  timestamps: document.getElementById('timestamps'),
  frontmatter: document.getElementById('frontmatter'),
  saveAs: document.getElementById('saveAs'),
  convertMath: document.getElementById('convertMath'),
  formatRow: document.querySelector('label.nested'),
  debugRow: document.getElementById('debugRow'),
  timestampFormat: document.getElementById('timestampFormat'),
};

const MESSAGES = {
  NO_TAB: 'No active tab.',
  NOT_CHATGPT: 'Not a ChatGPT tab. Open a conversation on chatgpt.com first.',
  NO_CONTENT_SCRIPT: 'Could not reach the page. Reload the ChatGPT tab and try again.',
  MESSAGE_FAILED: 'Could not receive the conversation from the page.',
  NO_CONVERSATION: 'This conversation has no id yet. Send a message so it gets saved, then retry.',
  NOT_SIGNED_IN: 'Not signed in to ChatGPT, or the session expired. Reload the tab and try again.',
  FETCH_FAILED: 'ChatGPT rejected the request. The backend may have changed, or the session expired.',
  SERVER_ERROR: 'ChatGPT returned a server error after retries. Try again later or try another conversation.',
  EMPTY: 'Nothing exportable found in this conversation.',
};

let settings = null;

function setStatus(text, kind = '') {
  ui.status.textContent = text;
  ui.status.className = `status ${kind}`.trim();
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function isChatGptUrl(url) {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url || '');
}

/**
 * Ask the content script for the conversation. If the tab was loaded before the
 * extension was installed or reloaded, no content script is there yet - inject
 * it once and retry.
 */
async function requestExtraction(tabId, includeRaw) {
  const request = { type: 'SAVEGPT_EXTRACT', includeRaw };
  try {
    return await chrome.tabs.sendMessage(tabId, request);
  } catch (error) {
    if (!String(error.message || error).includes('Receiving end does not exist')) {
      return { ok: false, code: 'MESSAGE_FAILED', message: error.message || String(error) };
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/content.js'] });
    } catch (injectionError) {
      return { ok: false, code: 'NO_CONTENT_SCRIPT', message: injectionError.message || String(injectionError) };
    }
    try {
      return await chrome.tabs.sendMessage(tabId, request);
    } catch (retryError) {
      return { ok: false, code: 'MESSAGE_FAILED', message: retryError.message || String(retryError) };
    }
  }
}

async function extract(includeRaw = false) {
  const tab = await activeTab();
  if (!tab) throw new Error(MESSAGES.NO_TAB);
  if (!isChatGptUrl(tab.url)) throw new Error(MESSAGES.NOT_CHATGPT);

  const response = await requestExtraction(tab.id, includeRaw);
  if (!response || !response.ok) {
    const code = (response && response.code) || 'UNKNOWN';
    const detail = response && response.message ? `\n${response.message}` : '';
    throw new Error((MESSAGES[code] || 'Extraction failed.') + detail);
  }
  return response;
}

async function run(action, busyLabel) {
  ui.save.disabled = true;
  setStatus(busyLabel);
  try {
    await action();
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  } finally {
    ui.save.disabled = false;
  }
}

async function onSave() {
  await run(async () => {
    const { conversation } = await extract();
    const markdown = renderMarkdown(conversation, settings);
    const filename = buildFilename(conversation);

    await saveText(filename, markdown, { saveAs: settings.saveAs });

    const count = conversation.messages.length;
    const dropped = Object.entries(conversation.omissions || {})
      .filter(([, was]) => was)
      .map(([kind]) => kind);
    const note = dropped.length ? `\nOmitted: ${dropped.join(', ')}.` : '';
    setStatus(`Saved ${count} message${count === 1 ? '' : 's'} to ${filename}.${note}`, 'ok');
  }, 'Reading conversation...');
}

async function onSaveJson(event) {
  event.preventDefault();
  await run(async () => {
    const { conversation, raw } = await extract(true);
    const filename = `${sanitizeStem(conversation.title)}-${toDateStamp(conversation.createTime)}.raw.json`;
    await saveText(filename, JSON.stringify(raw, null, 2), {
      saveAs: settings.saveAs,
      mimeType: 'application/json',
    });
    setStatus(`Saved raw payload to ${filename}.`, 'ok');
  }, 'Reading conversation...');
}

function bindSetting(element, key, property = 'checked', onChange) {
  element[property] = settings[key];
  element.addEventListener('change', async () => {
    settings = { ...settings, [key]: element[property] };
    await saveSettings(settings);
    if (onChange) onChange();
  });
}

/** The format control only does anything while timestamps are on. */
function syncFormatRow() {
  ui.timestampFormat.disabled = !settings.timestamps;
  ui.formatRow.classList.toggle('disabled', !settings.timestamps);
}

/**
 * The raw JSON dump is a debugging aid, not a feature. Show it only for an
 * unpacked install - `management.getSelf` needs no permission for this.
 */
async function isDeveloperInstall() {
  try {
    const self = await chrome.management.getSelf();
    return self.installType === 'development';
  } catch {
    return false;
  }
}

async function init() {
  settings = await loadSettings();
  bindSetting(ui.timestamps, 'timestamps', 'checked', syncFormatRow);
  bindSetting(ui.frontmatter, 'frontmatter');
  bindSetting(ui.saveAs, 'saveAs');
  bindSetting(ui.convertMath, 'convertMath');
  bindSetting(ui.timestampFormat, 'timestampFormat', 'value');
  syncFormatRow();

  ui.save.addEventListener('click', onSave);
  ui.saveJson.addEventListener('click', onSaveJson);

  if (await isDeveloperInstall()) ui.debugRow.hidden = false;

  const tab = await activeTab();
  if (!isChatGptUrl(tab && tab.url)) setStatus(MESSAGES.NOT_CHATGPT);
}

init();
