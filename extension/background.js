/**
 * Titan-XT Quick Connect — background service worker.
 *
 * Two responsibilities:
 *   1. Register a context menu so right-clicking selected text that looks
 *      like a Titan-XT ID lets the user open the viewer with that id
 *      pre-filled — same convenience as Telegram's "open chat with this
 *      number" menu.
 *   2. Handle the keyboard shortcut (Ctrl+Shift+Y) declared in manifest.json
 *      via `_execute_action` — Chrome opens the popup automatically; this
 *      worker just exists to keep storage helpers warm.
 *
 * Service workers are short-lived in MV3 — we never store state in
 * module-scope variables, only in chrome.storage.
 */

const SETTINGS_KEY = 'titan-xt:settings';
const DEFAULT_SETTINGS = {
  serverUrl: 'https://titan.xtapo.org',
  viewerUrl: '',
};

/** Read settings from storage, falling back to the defaults. */
async function getSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([SETTINGS_KEY], (res) => {
        const stored = (res && res[SETTINGS_KEY]) || {};
        resolve({ ...DEFAULT_SETTINGS, ...stored });
      });
    } catch {
      resolve(DEFAULT_SETTINGS);
    }
  });
}

function buildViewerUrl(partnerId, settings) {
  const base = (settings.viewerUrl || settings.serverUrl || DEFAULT_SETTINGS.serverUrl).replace(/\/$/, '');
  const url = new URL(base + '/');
  url.searchParams.set('id', partnerId);
  return url.toString();
}

// === Context menu ===
// Match any 9-digit run (with optional spaces) — e.g. "123 456 789".
const ID_REGEX = /\b\d{3}\s?\d{3}\s?\d{3}\b/;

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({
      id: 'titan-xt-connect',
      title: 'Mở Titan-XT với "%s"',
      contexts: ['selection'],
    });
  } catch {
    // contextMenus may already be registered from a previous install — ignore.
  }
});

chrome.contextMenus?.onClicked?.addListener(async (info) => {
  if (info.menuItemId !== 'titan-xt-connect') return;
  const selection = info.selectionText || '';
  const match = selection.match(ID_REGEX);
  if (!match) return;
  const digits = match[0].replace(/\s/g, '');
  if (digits.length !== 9) return;
  const settings = await getSettings();
  await chrome.tabs.create({ url: buildViewerUrl(digits, settings) });
});

// Keep the worker reachable via a no-op message handler. Some host pages
// may want to ping the extension to detect availability — leave the door
// open for future expansion (e.g. content script bridging) without paying
// for it today.
chrome.runtime.onMessage?.addListener?.((msg, _sender, sendResponse) => {
  if (msg?.type === 'ping') {
    sendResponse({ pong: true, version: chrome.runtime.getManifest().version });
  }
  return true;
});
