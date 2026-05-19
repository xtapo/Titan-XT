/**
 * Titan-XT Quick Connect — popup logic.
 *
 * Stays standalone (no bundler) so the extension is plain ES modules the
 * browser loads directly. Two responsibilities:
 *   1. Validate ID + password input, hand off to the web viewer in a new tab.
 *   2. Maintain a small recent-partners list in chrome.storage.local so the
 *      user gets one-tap reconnect without retyping.
 *
 * Passwords are NEVER persisted — same security stance as the desktop app.
 */

const RECENTS_KEY = 'titan-xt:recent-partners';
const SETTINGS_KEY = 'titan-xt:settings';
const RECENTS_MAX = 8;

const DEFAULT_SETTINGS = {
  serverUrl: 'https://titan.xtapo.org',
  viewerUrl: '', // empty → derive from serverUrl
};

const $ = (sel) => document.querySelector(sel);

// === Storage helpers (Promise wrappers around chrome.storage.local) ===

function getStorage(key, fallback) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([key], (res) => {
        resolve(res?.[key] ?? fallback);
      });
    } catch {
      resolve(fallback);
    }
  });
}

function setStorage(key, value) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [key]: value }, () => resolve());
    } catch {
      resolve();
    }
  });
}

// === Recent partners ===

async function loadRecents() {
  const list = await getStorage(RECENTS_KEY, []);
  return Array.isArray(list)
    ? list.filter((e) => e && /^\d{9}$/.test(e.id)).slice(0, RECENTS_MAX)
    : [];
}

async function recordSuccessfulConnect(partnerId) {
  const list = await loadRecents();
  const now = Date.now();
  const idx = list.findIndex((e) => e.id === partnerId);
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      lastConnectedAt: now,
      connectCount: (list[idx].connectCount || 0) + 1,
    };
  } else {
    list.unshift({ id: partnerId, lastConnectedAt: now, connectCount: 1 });
  }
  list.sort((a, b) => b.lastConnectedAt - a.lastConnectedAt);
  await setStorage(RECENTS_KEY, list.slice(0, RECENTS_MAX));
}

async function removeRecent(partnerId) {
  const list = (await loadRecents()).filter((e) => e.id !== partnerId);
  await setStorage(RECENTS_KEY, list);
}

// === Formatting ===

function formatId(digits) {
  const d = (digits || '').replace(/\D/g, '').slice(0, 9);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)} ${d.slice(3)}`;
  return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

function fmtRelative(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'vừa xong';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} phút trước`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} giờ trước`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} ngày trước`;
  return new Date(ts).toLocaleDateString();
}

// === Settings ===

async function loadSettings() {
  const stored = await getStorage(SETTINGS_KEY, {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function saveSettings(patch) {
  const merged = { ...(await loadSettings()), ...patch };
  await setStorage(SETTINGS_KEY, merged);
  return merged;
}

// === Connect flow ===

/**
 * Build the URL the new tab should land on. We attach the partner id as a
 * `?id=` query parameter so the viewer can prefill its login form. The
 * password is NEVER serialized into the URL — that would leak through
 * browser history and any reverse proxy access logs.
 */
function buildViewerUrl(partnerId, settings) {
  const base = (settings.viewerUrl || settings.serverUrl || DEFAULT_SETTINGS.serverUrl).replace(/\/$/, '');
  const url = new URL(base + '/');
  url.searchParams.set('id', partnerId);
  return url.toString();
}

async function openSession(partnerId) {
  const settings = await loadSettings();
  const url = buildViewerUrl(partnerId, settings);
  await recordSuccessfulConnect(partnerId);
  try {
    await chrome.tabs.create({ url });
    window.close();
  } catch (err) {
    setStatus(`Không mở được tab: ${err?.message || err}`, 'error');
  }
}

// === UI ===

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

async function renderRecents() {
  const list = await loadRecents();
  const section = $('#recentsSection');
  const listEl = $('#recentsList');
  if (list.length === 0) {
    section.classList.add('hidden');
    listEl.innerHTML = '';
    return;
  }
  section.classList.remove('hidden');
  listEl.innerHTML = list
    .map(
      (r) => `
      <button class="recent" data-id="${r.id}" title="Kết nối ${formatId(r.id)}">
        <span class="recent-id">${formatId(r.id)}</span>
        <span class="recent-meta">
          <span>${fmtRelative(r.lastConnectedAt)}</span>
          <span class="recent-count">${r.connectCount}×</span>
        </span>
        <button class="recent-remove" data-remove="${r.id}" title="Xoá">×</button>
      </button>`,
    )
    .join('');

  listEl.querySelectorAll('.recent').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      if (e.target.closest('[data-remove]')) return;
      const id = btn.dataset.id;
      $('#partnerId').value = formatId(id);
      $('#password').focus();
    });
  });
  listEl.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeRecent(btn.dataset.remove);
      renderRecents();
    });
  });
}

async function init() {
  const settings = await loadSettings();
  $('#serverUrl').value = settings.serverUrl;
  $('#viewerUrl').value = settings.viewerUrl;

  // Format ID as you type — strip non-digits, group in 3s.
  $('#partnerId').addEventListener('input', (e) => {
    e.target.value = formatId(e.target.value);
  });

  // Auto-focus the password field when ID is fully typed.
  $('#partnerId').addEventListener('input', (e) => {
    const digits = e.target.value.replace(/\D/g, '');
    if (digits.length === 9) $('#password').focus();
  });

  $('#connectBtn').addEventListener('click', submit);
  $('#password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  $('#partnerId').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#password').focus();
  });

  // Settings drawer toggle.
  $('#settingsBtn').addEventListener('click', () => {
    $('#settingsPanel').classList.toggle('hidden');
  });
  $('#cancelSettings').addEventListener('click', () => {
    $('#settingsPanel').classList.add('hidden');
  });
  $('#saveSettings').addEventListener('click', async () => {
    const serverUrl = ($('#serverUrl').value || '').trim();
    const viewerUrl = ($('#viewerUrl').value || '').trim();
    if (serverUrl && !/^https?:\/\//.test(serverUrl)) {
      setStatus('Signal server phải bắt đầu bằng https://', 'error');
      return;
    }
    if (viewerUrl && !/^https?:\/\//.test(viewerUrl)) {
      setStatus('Viewer URL phải bắt đầu bằng https://', 'error');
      return;
    }
    await saveSettings({
      serverUrl: serverUrl || DEFAULT_SETTINGS.serverUrl,
      viewerUrl,
    });
    $('#settingsPanel').classList.add('hidden');
    setStatus('Đã lưu cài đặt', 'success');
    setTimeout(() => setStatus(''), 1600);
  });

  $('#clearRecents').addEventListener('click', async () => {
    if (!confirm('Xoá lịch sử kết nối?')) return;
    await setStorage(RECENTS_KEY, []);
    renderRecents();
  });

  renderRecents();

  // Restore the last typed partner id so opening the popup right after a
  // failed attempt doesn't lose what the user just typed.
  const lastPartner = await getStorage('titan-xt:last-typed-id', '');
  if (lastPartner) $('#partnerId').value = formatId(lastPartner);
  $('#password').focus();
}

async function submit() {
  const partnerId = $('#partnerId').value.replace(/\D/g, '');
  const password = $('#password').value.trim();
  if (partnerId.length !== 9) {
    setStatus('Partner ID phải đủ 9 chữ số', 'error');
    return;
  }
  // Password is required for the viewer to authenticate, but we still pass
  // only the ID through the URL — the user types the password again on the
  // landing page. Keeping the password in-memory only matches the desktop
  // app's posture (we never write passwords to disk).
  if (!password) {
    setStatus('Nhập mật khẩu trên tab viewer sau khi mở', 'info');
  } else {
    setStatus('');
  }

  await setStorage('titan-xt:last-typed-id', partnerId);
  await openSession(partnerId);
}

init();
