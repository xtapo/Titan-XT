/**
 * Home Page — TeamViewer-style: Your ID/Password + Connect form
 */

import { showToast } from '../components/toast';
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
          <input type="text" id="partner-id" class="input-field input-id"
                 placeholder="Nhập ID đối tác" maxlength="11"
                 autocomplete="off" spellcheck="false" />
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

    <!-- History -->
    <div class="history-section animate-fadeIn" style="animation-delay:0.2s">
      <div class="history-header">
        <h3>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          Kết nối gần đây
        </h3>
      </div>
      <div class="history-list" id="history-list">
        <div class="history-empty">Chưa có lịch sử kết nối</div>
      </div>
    </div>

    <div class="home-footer">
      <button class="btn-text" id="btn-settings">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
        </svg>
        Cài đặt
      </button>
      <span class="version-text">v1.0.0</span>
    </div>
  `;

  setupHomeEvents();
  loadHistory();
  updateStatus('online');
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

/**
 * Load connection history
 */
async function loadHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;

  let history: any[] = [];
  try {
    if (window.titanAPI?.history) {
      history = await window.titanAPI.history.get();
    }
  } catch (e) {
    // ignore
  }

  if (!history || history.length === 0) {
    list.innerHTML = '<div class="history-empty">Chưa có lịch sử kết nối</div>';
    return;
  }

  list.innerHTML = history.map((h: any) => `
    <div class="history-item">
      <div class="history-item-info">
        <span class="history-item-id">${formatId(h.machineId)}</span>
        <span class="history-item-name">${h.machineName || 'Unknown'}</span>
      </div>
      <span class="history-item-time">${timeAgo(h.lastConnected)}</span>
      <button class="btn-reconnect" data-id="${h.machineId}">Kết nối</button>
    </div>
  `).join('');

  // Reconnect buttons
  list.querySelectorAll('.btn-reconnect').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.id || '';
      const input = document.getElementById('partner-id') as HTMLInputElement;
      if (input) {
        input.value = formatIdInput(id);
        input.focus();
        validateConnectForm();
      }
    });
  });
}
