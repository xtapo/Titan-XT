/**
 * Home Page — TeamViewer-style: Your ID/Password + Connect form
 */

import { showToast } from '../components/toast';
import { checkForUpdates } from '../components/update-banner';
import { navigateTo } from '../main';

let myId = '---';
let myPassword = '----';

/**
 * Format ID for display: "847 291 035"
 */
function formatId(id: string): string {
  if (!id || id.length < 9) return id || '--- --- ---';
  return `${id.substring(0, 3)} ${id.substring(3, 6)} ${id.substring(6, 9)}`;
}

/**
 * Format ID input as user types
 */
function formatIdInput(value: string): string {
  const digits = value.replace(/\D/g, '').substring(0, 9);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.substring(0, 3)} ${digits.substring(3)}`;
  return `${digits.substring(0, 3)} ${digits.substring(3, 6)} ${digits.substring(6)}`;
}

/**
 * Parse formatted ID back to digits
 */
function parseId(formatted: string): string {
  return formatted.replace(/\D/g, '');
}

/**
 * Time ago helper
 */
function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Vừa xong';
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  return `${days} ngày trước`;
}

/**
 * Render the home page content
 */
export async function renderHomePage() {
  const page = document.getElementById('page-home');
  if (!page) return;

  // Get identity from main process
  try {
    if (window.titanAPI?.identity) {
      const identity = await window.titanAPI.identity.get();
      if (identity) {
        myId = identity.machineId;
        myPassword = identity.password;
      }
    }
  } catch (e) {
    console.warn('[Home] Could not get identity:', e);
  }

  page.innerHTML = `
    <div class="status-indicator" id="connection-status">
      <span class="status-dot"></span>
      <span class="status-text">Đang khởi tạo...</span>
    </div>

    <div class="home-container">
      <!-- Left: Your Info -->
      <div class="panel panel-info animate-fadeIn">
        <div class="panel-header">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
          </svg>
          <h2>Cho phép điều khiển</h2>
        </div>
        <p class="panel-desc">Gửi ID và mật khẩu cho kỹ thuật viên để được hỗ trợ</p>

        <div class="field-group">
          <label class="field-label">Your ID</label>
          <div class="id-display">
            <span class="id-digits" id="display-my-id">${formatId(myId)}</span>
            <button class="btn-icon" id="btn-copy-id" title="Sao chép ID">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
            </button>
          </div>
        </div>

        <div class="field-group">
          <label class="field-label">Password</label>
          <div class="password-display">
            <span class="password-text" id="display-my-pass">${myPassword}</span>
            <button class="btn-icon" id="btn-refresh-pass" title="Đổi mật khẩu">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- Right: Connect -->
      <div class="panel panel-connect animate-fadeIn" style="animation-delay:0.1s">
        <div class="panel-header">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>
          </svg>
          <h2>Điều khiển máy khác</h2>
        </div>
        <p class="panel-desc">Nhập ID và mật khẩu của đối tác để kết nối</p>

        <div class="field-group">
          <label class="field-label">Partner ID</label>
          <div class="partner-id-wrap">
            <input type="text" id="partner-id" class="input-field input-id"
                   placeholder="Nhập ID đối tác" maxlength="11"
                   autocomplete="off" spellcheck="false" />
            <button type="button" class="btn-id-dropdown" id="btn-id-dropdown" title="Lịch sử & Máy của tôi">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            <div class="id-dropdown" id="id-dropdown"></div>
          </div>
        </div>

        <div class="field-group">
          <label class="field-label">Password</label>
          <input type="text" id="partner-password" class="input-field input-password"
                 placeholder="Mật khẩu" maxlength="4"
                 autocomplete="off" spellcheck="false" />
        </div>

        <div class="connect-options">
          <label class="radio-option active" id="opt-control">
            <input type="radio" name="mode" value="control" checked />
            <span class="radio-dot"></span>
            Điều khiển từ xa
          </label>
          <label class="radio-option" id="opt-view">
            <input type="radio" name="mode" value="view" />
            <span class="radio-dot"></span>
            Chỉ xem
          </label>
        </div>

        <button id="btn-connect" class="btn-primary" disabled>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>
          </svg>
          Kết nối
        </button>
      </div>
    </div>

    <!-- History (legacy slot, kept hidden — dropdown above replaces it). -->
    <div id="history-section" style="display:none"></div>

    <div class="home-footer">
      <button class="btn-text" id="btn-settings">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
        </svg>
        Cài đặt
      </button>
      <button class="btn-text" id="btn-check-update" title="Kiểm tra phiên bản mới">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12a9 9 0 11-3.5-7.1"/><polyline points="21 4 21 10 15 10"/>
        </svg>
        Kiểm tra cập nhật
      </button>
      <span class="version-text" id="app-version-text">v…</span>
    </div>
  `;

  setupHomeEvents();
  updateStatus('online');
  applyAppVersion();
}

/**
 * Pull the real app version from main (electron app.getVersion → package.json)
 * so the home footer doesn't get stuck showing the build-time placeholder.
 */
async function applyAppVersion(): Promise<void> {
  const el = document.getElementById('app-version-text');
  if (!el) return;
  try {
    const info = await window.titanAPI?.app?.getInfo?.();
    const v = info?.version;
    if (v) el.textContent = `v${v}`;
  } catch {
    // Best-effort — leave the placeholder if main is unavailable.
  }
}

/**
 * Setup event listeners
 */
function setupHomeEvents() {
  // Copy ID
  document.getElementById('btn-copy-id')?.addEventListener('click', () => {
    navigator.clipboard.writeText(myId).then(() => {
      showToast('Đã sao chép ID', 'success');
    });
  });

  // Refresh password
  document.getElementById('btn-refresh-pass')?.addEventListener('click', async () => {
    try {
      if (window.titanAPI?.identity) {
        myPassword = await window.titanAPI.identity.regeneratePassword();
      } else {
        // Demo mode
        const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
        myPassword = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      }
      const el = document.getElementById('display-my-pass');
      if (el) el.textContent = myPassword;
      showToast('Đã đổi mật khẩu', 'success');
    } catch (e) {
      showToast('Lỗi đổi mật khẩu', 'error');
    }
  });

  // Partner ID input formatting
  const partnerIdInput = document.getElementById('partner-id') as HTMLInputElement;
  const partnerPassInput = document.getElementById('partner-password') as HTMLInputElement;
  const connectBtn = document.getElementById('btn-connect') as HTMLButtonElement;

  if (partnerIdInput) {
    partnerIdInput.addEventListener('input', () => {
      const raw = parseId(partnerIdInput.value);
      partnerIdInput.value = formatIdInput(raw);
      validateConnectForm();
    });
  }

  if (partnerPassInput) {
    partnerPassInput.addEventListener('input', () => {
      validateConnectForm();
    });

    partnerPassInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        connectBtn?.click();
      }
    });
  }

  // Radio options
  const optControl = document.getElementById('opt-control');
  const optView = document.getElementById('opt-view');

  [optControl, optView].forEach((opt) => {
    opt?.addEventListener('click', () => {
      document.querySelectorAll('.radio-option').forEach((o) => o.classList.remove('active'));
      opt.classList.add('active');
    });
  });

  // Connect button
  connectBtn?.addEventListener('click', handleConnect);

  // ID dropdown — recent history + pinned address book entries
  setupIdDropdown();

  // Settings modal
  document.getElementById('btn-settings')?.addEventListener('click', openSettingsModal);

  // Manual update check
  document.getElementById('btn-check-update')?.addEventListener('click', () => {
    checkForUpdates();
  });
}

/**
 * Wire the Partner-ID dropdown that combines pinned (Address Book) entries
 * and recent connection history. Opens on focus / chevron click / typing,
 * closes on outside click or Escape.
 */
function setupIdDropdown() {
  const wrap = document.querySelector('.partner-id-wrap') as HTMLElement | null;
  const input = document.getElementById('partner-id') as HTMLInputElement | null;
  const btn = document.getElementById('btn-id-dropdown') as HTMLButtonElement | null;
  const dd = document.getElementById('id-dropdown') as HTMLElement | null;
  if (!wrap || !input || !btn || !dd) return;

  const open = () => {
    renderIdDropdown(input.value);
    wrap.classList.add('open');
  };
  const close = () => wrap.classList.remove('open');
  const toggle = () => {
    if (wrap.classList.contains('open')) close();
    else open();
  };

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
    if (wrap.classList.contains('open')) input.focus();
  });

  input.addEventListener('focus', () => open());
  input.addEventListener('input', () => renderIdDropdown(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
      input.blur();
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (!wrap.contains(e.target as Node)) close();
  });
}

interface DropdownItem {
  source: 'pinned' | 'history';
  machineId: string;
  alias?: string;
  machineName?: string;
  group?: string;
  password?: string;
  defaultMode?: 'control' | 'view';
  favorite?: boolean;
  lastConnectedAt?: number;
  abId?: string;
}

/**
 * Build the dropdown body from Address Book + history. Pinned entries first
 * (favorites on top), then recent history that isn't already pinned. Filters
 * by the current input text against id, alias, group, and machine name.
 */
async function renderIdDropdown(filter: string) {
  const dd = document.getElementById('id-dropdown');
  if (!dd) return;

  const q = (filter || '').replace(/\s/g, '').toLowerCase();
  let pinned: any[] = [];
  let history: any[] = [];
  try {
    pinned = (await window.titanAPI?.addressBook?.get()) || [];
  } catch { /* ignore */ }
  try {
    history = (await window.titanAPI?.history?.get()) || [];
  } catch { /* ignore */ }

  const pinnedItems: DropdownItem[] = pinned.map((p: any) => ({
    source: 'pinned',
    machineId: p.machineId,
    alias: p.alias,
    group: p.group,
    password: p.password,
    defaultMode: p.defaultMode || 'control',
    favorite: !!p.favorite,
    lastConnectedAt: p.lastConnectedAt,
    abId: p.id,
  }));
  const pinnedIds = new Set(pinnedItems.map((p) => p.machineId));
  const historyItems: DropdownItem[] = history
    .filter((h: any) => !pinnedIds.has(h.machineId))
    .map((h: any) => ({
      source: 'history',
      machineId: h.machineId,
      machineName: h.machineName,
      lastConnectedAt: h.lastConnected,
    }));

  pinnedItems.sort((a, b) => {
    if ((a.favorite ? 1 : 0) !== (b.favorite ? 1 : 0)) return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
    return (b.lastConnectedAt || 0) - (a.lastConnectedAt || 0);
  });

  const matches = (it: DropdownItem) => {
    if (!q) return true;
    const hay = `${it.machineId} ${it.alias || ''} ${it.group || ''} ${it.machineName || ''}`.toLowerCase();
    return hay.includes(q);
  };

  const filteredPinned = pinnedItems.filter(matches);
  const filteredHistory = historyItems.filter(matches);

  if (filteredPinned.length === 0 && filteredHistory.length === 0) {
    dd.innerHTML = `
      <div class="id-dd-empty">
        ${q ? 'Không tìm thấy máy phù hợp' : 'Chưa có lịch sử kết nối'}
      </div>
    `;
    return;
  }

  const renderItem = (it: DropdownItem) => {
    const idFmt = formatId(it.machineId);
    const title = it.alias || it.machineName || idFmt;
    const subline = it.alias
      ? `${idFmt}${it.group ? ` · ${escapeHtml(it.group)}` : ''}`
      : (it.machineName ? idFmt : timeAgo(it.lastConnectedAt || 0));
    const star = it.source === 'pinned' && it.favorite ? '<span class="id-dd-star" title="Yêu thích">★</span>' : '';
    const lock = it.source === 'pinned'
      ? (it.password ? '<span class="id-dd-lock" title="Đã lưu mật khẩu">🔒</span>' : '<span class="id-dd-lock dim" title="Chưa lưu mật khẩu">🔓</span>')
      : '';
    const connectAttr = it.source === 'pinned' && it.password
      ? `data-action="quick-connect" data-id="${escapeHtml(it.machineId)}" data-pw="${escapeHtml(it.password)}" data-mode="${it.defaultMode || 'control'}" data-ab="${escapeHtml(it.abId || '')}"`
      : `data-action="fill-id" data-id="${escapeHtml(it.machineId)}"`;

    return `
      <button type="button" class="id-dd-item" ${connectAttr}>
        ${star}
        <div class="id-dd-text">
          <span class="id-dd-title">${escapeHtml(title)}</span>
          <span class="id-dd-sub">${subline}</span>
        </div>
        ${lock}
        ${it.source === 'pinned' && it.password
          ? '<span class="id-dd-cta" title="Kết nối ngay">⚡</span>'
          : '<span class="id-dd-cta dim" title="Điền ID">↵</span>'}
      </button>
    `;
  };

  let html = '';
  if (filteredPinned.length > 0) {
    html += `<div class="id-dd-section">Máy của tôi</div>`;
    html += filteredPinned.map(renderItem).join('');
  }
  if (filteredHistory.length > 0) {
    html += `<div class="id-dd-section">Kết nối gần đây</div>`;
    html += filteredHistory.slice(0, 8).map(renderItem).join('');
  }
  dd.innerHTML = html;

  dd.querySelectorAll<HTMLElement>('[data-action]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const action = el.dataset.action;
      const id = el.dataset.id || '';
      if (action === 'fill-id') {
        const input = document.getElementById('partner-id') as HTMLInputElement;
        if (input) {
          input.value = formatIdInput(id);
          validateConnectForm();
          input.focus();
        }
        document.querySelector('.partner-id-wrap')?.classList.remove('open');
        const passInput = document.getElementById('partner-password') as HTMLInputElement | null;
        passInput?.focus();
      } else if (action === 'quick-connect') {
        const password = el.dataset.pw || '';
        const mode = (el.dataset.mode || 'control') as 'control' | 'view';
        const abId = el.dataset.ab || '';
        document.querySelector('.partner-id-wrap')?.classList.remove('open');
        if (abId) {
          window.titanAPI?.addressBook?.touch(abId).catch(() => {});
        }
        showToast(`Đang kết nối đến ${formatId(id)}...`, 'info');
        (window as any).__sessionInfo = { partnerId: id, password, mode };
        navigateTo('session');
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('start-session', {
            detail: { partnerId: id, password, mode },
          }));
        }, 200);
      }
    });
  });
}

function escapeHtml(s: string): string {
  return (s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] as string);
}

/**
 * Build (once) and open the Settings modal. Loads current values from the
 * persistent store on every open so external changes are reflected.
 */
async function openSettingsModal() {
  let modal = document.getElementById('settings-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'settings-modal';
    modal.className = 'settings-modal';
    modal.innerHTML = `
      <div class="settings-backdrop" data-close></div>
      <div class="settings-dialog">
        <div class="settings-header">
          <h2>Cài đặt</h2>
          <button class="btn-icon" id="btn-close-settings" data-close>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="settings-body">
          <div class="settings-section">
            <h3>File nhận được</h3>
            <div class="settings-field">
              <label class="field-label">Thư mục lưu</label>
              <div class="folder-row">
                <input type="text" id="settings-download-folder" class="input-field"
                       placeholder="Mặc định: Downloads/Titan-XT" readonly />
                <button class="btn-secondary" id="btn-pick-folder">Chọn...</button>
                <button class="btn-text" id="btn-reset-folder" title="Dùng mặc định">Mặc định</button>
              </div>
              <p class="field-hint">File nhận được sẽ tự động lưu vào thư mục này.</p>
            </div>
            <div class="settings-field">
              <label class="checkbox-option">
                <input type="checkbox" id="settings-ask-before-save" />
                <span>Hỏi vị trí lưu cho từng file</span>
              </label>
              <p class="field-hint">Khi bật, mỗi file nhận được sẽ mở hộp thoại Save As.</p>
            </div>
          </div>
          <div class="settings-section">
            <h3>Hiệu năng khi được điều khiển</h3>
            <div class="settings-field">
              <label class="checkbox-option">
                <input type="checkbox" id="settings-hide-wallpaper" />
                <span>Tắt hình nền desktop khi có người kết nối</span>
              </label>
              <p class="field-hint">Giúp giảm băng thông và tăng độ mượt khi mạng yếu. Hình nền sẽ tự động phục hồi khi ngắt kết nối.</p>
            </div>
          </div>
        </div>
        <div class="settings-footer">
          <button class="btn-text" data-close>Hủy</button>
          <button class="btn-primary" id="btn-save-settings">Lưu</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Wire close handlers (backdrop + close button + cancel)
    modal.querySelectorAll('[data-close]').forEach((el) =>
      el.addEventListener('click', () => modal!.classList.remove('open'))
    );

    // Folder picker
    document.getElementById('btn-pick-folder')?.addEventListener('click', async () => {
      const picked = await window.titanAPI?.dialog?.selectFolder();
      if (picked) {
        const input = document.getElementById('settings-download-folder') as HTMLInputElement;
        if (input) input.value = picked;
      }
    });

    // Reset folder to default (empty string in storage)
    document.getElementById('btn-reset-folder')?.addEventListener('click', () => {
      const input = document.getElementById('settings-download-folder') as HTMLInputElement;
      if (input) input.value = '';
    });

    // Save
    document.getElementById('btn-save-settings')?.addEventListener('click', async () => {
      const folderInput = document.getElementById('settings-download-folder') as HTMLInputElement;
      const askInput = document.getElementById('settings-ask-before-save') as HTMLInputElement;
      const hideWpInput = document.getElementById('settings-hide-wallpaper') as HTMLInputElement;
      try {
        await window.titanAPI?.settings?.update({
          downloadFolder: folderInput?.value || '',
          askBeforeSave: !!askInput?.checked,
          hideWallpaper: !!hideWpInput?.checked,
        });
        showToast('Đã lưu cài đặt', 'success');
        modal!.classList.remove('open');
      } catch (e) {
        showToast('Lỗi lưu cài đặt', 'error');
      }
    });
  }

  // Load current values
  try {
    const settings = await window.titanAPI?.settings?.get();
    const folderInput = document.getElementById('settings-download-folder') as HTMLInputElement;
    const askInput = document.getElementById('settings-ask-before-save') as HTMLInputElement;
    const hideWpInput = document.getElementById('settings-hide-wallpaper') as HTMLInputElement;
    if (folderInput) folderInput.value = settings?.downloadFolder || '';
    if (askInput) askInput.checked = !!settings?.askBeforeSave;
    if (hideWpInput) hideWpInput.checked = !!settings?.hideWallpaper;
  } catch {
    // best-effort
  }

  modal.classList.add('open');
}

/**
 * Validate connect form
 */
function validateConnectForm() {
  const partnerId = parseId((document.getElementById('partner-id') as HTMLInputElement)?.value || '');
  const password = (document.getElementById('partner-password') as HTMLInputElement)?.value || '';
  const btn = document.getElementById('btn-connect') as HTMLButtonElement;

  if (btn) {
    btn.disabled = partnerId.length < 9 || password.length < 4;
  }
}

/**
 * Reset the Connect button + form back to idle state.
 * Called when navigating back to home (e.g. after disconnect or failed attempt).
 */
export function resetConnectForm() {
  const btn = document.getElementById('btn-connect') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>
      </svg>
      Kết nối
    `;
  }
  const idInput = document.getElementById('partner-id') as HTMLInputElement | null;
  const passInput = document.getElementById('partner-password') as HTMLInputElement | null;
  if (idInput) idInput.value = '';
  if (passInput) passInput.value = '';
  validateConnectForm();
  updateStatus('online');
}

/**
 * Handle connect button click
 */
async function handleConnect() {
  const partnerId = parseId((document.getElementById('partner-id') as HTMLInputElement)?.value || '');
  const password = (document.getElementById('partner-password') as HTMLInputElement)?.value || '';
  const mode = (document.querySelector('input[name="mode"]:checked') as HTMLInputElement)?.value || 'control';

  if (partnerId.length < 9 || password.length < 4) {
    showToast('Vui lòng nhập đầy đủ ID và mật khẩu', 'error');
    return;
  }

  if (partnerId === myId) {
    showToast('Không thể kết nối đến chính mình', 'error');
    return;
  }

  const btn = document.getElementById('btn-connect') as HTMLButtonElement;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px"></div> Đang kết nối...';
  }

  showToast(`Đang kết nối đến ${formatId(partnerId)}...`, 'info');

  // Store partner info for session page
  (window as any).__sessionInfo = { partnerId, password, mode };

  // Navigate to session
  setTimeout(() => {
    navigateTo('session');
    // Trigger connection in session page
    window.dispatchEvent(new CustomEvent('start-session', {
      detail: { partnerId, password, mode }
    }));
  }, 500);
}

/**
 * Update connection status
 */
function updateStatus(status: 'online' | 'offline' | 'connecting') {
  const dot = document.querySelector('.status-dot');
  const text = document.querySelector('.status-text');

  if (dot) {
    dot.className = `status-dot ${status}`;
  }

  if (text) {
    const labels: Record<string, string> = {
      online: 'Sẵn sàng kết nối',
      offline: 'Mất kết nối',
      connecting: 'Đang kết nối...',
    };
    text.textContent = labels[status];
  }
}
