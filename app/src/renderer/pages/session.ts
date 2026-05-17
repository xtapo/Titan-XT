/**
 * Session Page — Remote desktop view with toolbar, chat, file transfer
 */

import { showToast } from '../components/toast';
import { navigateTo } from '../main';
import { QUALITY_PROFILES, QualityPreset, DEFAULT_QUALITY } from '../../shared/constants';

type DisplayFit = 'contain' | 'cover' | 'fill';
let currentFit: DisplayFit = 'contain';
let isHostMode = false;
let hostPanelCollapsed = false;
const hostViewers = new Map<string, { id: string; name: string }>();

/**
 * Render session page structure
 */
export function renderSessionPage() {
  const page = document.getElementById('page-session');
  if (!page) return;

  page.innerHTML = `
    <div class="session-container">
      <div class="video-wrapper" id="video-wrapper">
        <video id="remote-video" autoplay playsinline></video>
        <div class="video-overlay" id="video-overlay">
          <div class="connecting-spinner">
            <div class="spinner"></div>
            <p id="session-status-text">Đang kết nối...</p>
          </div>
        </div>
      </div>

      <!-- Collapsed handle: a thin tab at the top center to expand the toolbar -->
      <button class="toolbar-handle visible" id="toolbar-handle" title="Mở thanh công cụ">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      <!-- Toolbar (TeamViewer-style: grouped dropdowns, hidden by default) -->
      <div class="session-toolbar collapsed" id="session-toolbar">
        <div class="toolbar-left">
          <button class="toolbar-btn btn-danger toolbar-close" id="btn-disconnect" title="Ngắt kết nối">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
          <span class="toolbar-partner" id="toolbar-partner-name">Đang kết nối...</span>
        </div>

        <div class="toolbar-center">
          <!-- Home group -->
          <div class="toolbar-group" id="group-home">
            <button class="toolbar-group-btn" id="btn-group-home" title="Trang chủ">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 12l9-9 9 9M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10"/>
              </svg>
              <span>Home</span>
            </button>
          </div>

          <!-- Actions group -->
          <div class="toolbar-group" id="group-actions">
            <button class="toolbar-group-btn" id="btn-group-actions" title="Hành động">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
              </svg>
              <span>Actions</span>
              <svg class="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="dropdown-menu hidden" id="menu-actions">
              <button class="dropdown-item" data-action="ctrl-alt-del">Gửi Ctrl+Alt+Del</button>
              <button class="dropdown-item" data-action="lock">Khóa máy</button>
              <button class="dropdown-item" data-action="signout">Đăng xuất</button>
              <button class="dropdown-item" data-action="task-manager">Mở Task Manager</button>
              <div class="dropdown-divider"></div>
              <button class="dropdown-item dropdown-item-danger" data-action="restart">Khởi động lại</button>
              <button class="dropdown-item dropdown-item-danger" data-action="shutdown">Tắt máy</button>
            </div>
          </div>

          <!-- View group: monitor select + fullscreen + quality + display fit -->
          <div class="toolbar-group" id="group-view">
            <button class="toolbar-group-btn" id="btn-group-view" title="Hiển thị">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
              </svg>
              <span>View</span>
              <svg class="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="dropdown-menu hidden" id="menu-view">
              <button class="dropdown-item" data-view="fullscreen">Toàn màn hình</button>
              <button class="dropdown-item" data-view="monitor">Chọn màn hình…</button>
              <div class="dropdown-divider"></div>
              <div class="dropdown-section-label">Chất lượng</div>
              ${(Object.keys(QUALITY_PROFILES) as QualityPreset[])
                .map((k) => `<button class="dropdown-item" data-quality="${k}">${QUALITY_PROFILES[k].label}</button>`)
                .join('')}
              <div class="dropdown-divider"></div>
              <div class="dropdown-section-label">Hiển thị</div>
              <button class="dropdown-item" data-fit="contain">Vừa khung</button>
              <button class="dropdown-item" data-fit="cover">Lấp đầy (cắt)</button>
              <button class="dropdown-item" data-fit="fill">Kéo dãn</button>
            </div>
          </div>

          <!-- Communicate group: chat -->
          <div class="toolbar-group" id="group-communicate">
            <button class="toolbar-group-btn" id="btn-group-communicate" title="Liên lạc">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
              </svg>
              <span>Communicate</span>
              <span class="badge hidden" id="chat-badge">0</span>
              <svg class="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="dropdown-menu hidden" id="menu-communicate">
              <button class="dropdown-item" data-comm="chat">Mở chat</button>
            </div>
          </div>

          <!-- Files & Extras group -->
          <div class="toolbar-group" id="group-files">
            <button class="toolbar-group-btn" id="btn-group-files" title="File &amp; Extras">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/>
              </svg>
              <span>Files &amp; Extras</span>
              <svg class="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="dropdown-menu hidden" id="menu-files">
              <button class="dropdown-item" data-files="open">Mở khung truyền file</button>
            </div>
          </div>
        </div>

        <div class="toolbar-right">
          <span class="toolbar-stats" id="toolbar-stats">
            <span class="stat-latency" id="stat-latency">--ms</span>
            <span class="stat-fps" id="stat-fps">--fps</span>
            <span class="stat-bitrate" id="stat-bitrate">--</span>
          </span>
          <button class="toolbar-btn toolbar-collapse" id="btn-toolbar-collapse" title="Thu thanh công cụ">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="18 15 12 9 6 15"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Chat Panel -->
      <div class="chat-panel hidden" id="chat-panel">
        <div class="chat-header">
          <h3>Chat</h3>
          <button class="btn-icon" id="btn-close-chat">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="chat-messages" id="chat-messages"></div>
        <div class="chat-input-area">
          <input type="text" id="chat-input" placeholder="Nhập tin nhắn..."
                 autocomplete="off" spellcheck="false" />
          <button class="btn-send" id="btn-send-chat">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- File Panel -->
      <div class="file-panel hidden" id="file-panel">
        <div class="file-header">
          <h3>Truyền file</h3>
          <button class="btn-icon" id="btn-close-file">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="file-drop-zone" id="file-drop-zone">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <p>Kéo thả file vào đây</p>
          <button class="btn-secondary" id="btn-select-files">Chọn file</button>
        </div>
        <div class="file-list" id="file-list"></div>
      </div>
    </div>
  `;

  setupSessionEvents();
}

/**
 * Setup session event listeners
 */
function setupSessionEvents() {
  // Disconnect
  document.getElementById('btn-disconnect')?.addEventListener('click', () => {
    handleDisconnect();
  });

  // Toolbar collapse / expand
  document.getElementById('btn-toolbar-collapse')?.addEventListener('click', () => {
    setToolbarCollapsed(true);
  });
  document.getElementById('toolbar-handle')?.addEventListener('click', () => {
    setToolbarCollapsed(false);
  });

  // Group dropdowns: Actions / View / Communicate / Files & Extras
  setupGroupDropdown('group-actions', 'btn-group-actions', 'menu-actions');
  setupGroupDropdown('group-view', 'btn-group-view', 'menu-view');
  setupGroupDropdown('group-communicate', 'btn-group-communicate', 'menu-communicate');
  setupGroupDropdown('group-files', 'btn-group-files', 'menu-files');

  // Home — return to dashboard without disconnecting
  document.getElementById('btn-group-home')?.addEventListener('click', () => {
    navigateTo('home');
  });

  // Actions menu
  document.querySelectorAll('#menu-actions .dropdown-item').forEach((item) => {
    item.addEventListener('click', () => {
      const action = (item as HTMLElement).dataset.action;
      document.getElementById('menu-actions')?.classList.add('hidden');
      if (!action) return;
      runRemoteAction(action);
    });
  });

  // View menu — fullscreen + monitor + quality + display fit (consolidated)
  document.querySelectorAll('#menu-view .dropdown-item').forEach((item) => {
    item.addEventListener('click', () => {
      const el = item as HTMLElement;
      const view = el.dataset.view;
      const quality = el.dataset.quality as QualityPreset | undefined;
      const fit = el.dataset.fit as DisplayFit | undefined;
      document.getElementById('menu-view')?.classList.add('hidden');

      if (view === 'fullscreen') {
        const wrapper = document.getElementById('video-wrapper');
        if (wrapper) {
          if (document.fullscreenElement) {
            document.exitFullscreen();
          } else {
            wrapper.requestFullscreen();
          }
        }
      } else if (view === 'monitor') {
        showToast('Chọn màn hình: tính năng sẽ sớm có', 'info');
      } else if (quality) {
        const ok = window.connectionManager?.requestQuality(quality);
        if (ok === false) {
          showToast('Chưa kết nối — chưa thể đổi chất lượng', 'info');
        } else {
          showToast(`Đã yêu cầu chất lượng: ${QUALITY_PROFILES[quality].label}`, 'success');
        }
      } else if (fit) {
        currentFit = fit;
        const video = document.getElementById('remote-video') as HTMLVideoElement | null;
        if (video) video.style.objectFit = fit;
      }
    });
  });

  // Communicate menu — chat
  document.querySelectorAll('#menu-communicate .dropdown-item').forEach((item) => {
    item.addEventListener('click', () => {
      const comm = (item as HTMLElement).dataset.comm;
      document.getElementById('menu-communicate')?.classList.add('hidden');
      if (comm === 'chat') openChatPanel();
    });
  });

  // Files menu — open transfer panel
  document.querySelectorAll('#menu-files .dropdown-item').forEach((item) => {
    item.addEventListener('click', () => {
      const action = (item as HTMLElement).dataset.files;
      document.getElementById('menu-files')?.classList.add('hidden');
      if (action === 'open') openFilePanel();
    });
  });

  document.getElementById('btn-close-chat')?.addEventListener('click', () => {
    document.getElementById('chat-panel')?.classList.add('hidden');
  });
  document.getElementById('btn-close-file')?.addEventListener('click', () => {
    document.getElementById('file-panel')?.classList.add('hidden');
  });

  // Chat send
  const chatInput = document.getElementById('chat-input') as HTMLInputElement;
  document.getElementById('btn-send-chat')?.addEventListener('click', () => sendChat());
  chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  // File select
  document.getElementById('btn-select-files')?.addEventListener('click', async () => {
    try {
      if (window.titanAPI?.file) {
        const files = await window.titanAPI.file.selectFiles();
        if (files && files.length > 0) {
          for (const f of files) {
            await window.connectionManager?.sendFile(f.path, f.name, f.size);
          }
        }
      }
    } catch (e) {
      showToast('Lỗi chọn file', 'error');
    }
  });

  // File drag & drop
  const dropZone = document.getElementById('file-drop-zone');
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      // Drag-and-drop in Electron exposes the absolute path on File via
      // (file as any).path, which is what file:readChunk expects.
      for (const f of Array.from(files)) {
        const filePath = (f as any).path as string | undefined;
        if (!filePath) {
          showToast('Không lấy được đường dẫn file — hãy dùng nút Chọn file', 'error');
          continue;
        }
        await window.connectionManager?.sendFile(filePath, f.name, f.size);
      }
    });
  }

  // Listen for session start
  window.addEventListener('start-session', ((e: CustomEvent) => {
    const { partnerId, password, mode } = e.detail;
    const partnerName = document.getElementById('toolbar-partner-name');
    if (partnerName) {
      const fmtId = `${partnerId.substring(0, 3)} ${partnerId.substring(3, 6)} ${partnerId.substring(6, 9)}`;
      partnerName.textContent = `Đang kết nối đến ${fmtId}...`;
    }

    // Start real WebRTC connection
    if (window.connectionManager) {
      window.connectionManager.connectToPartner(partnerId, password, mode).catch((err) => {
        console.error('[Session] Connection failed:', err);
        showToast('Kết nối thất bại', 'error');
        const statusText = document.getElementById('session-status-text');
        if (statusText) statusText.textContent = 'Kết nối thất bại';
      });
    } else {
      console.error('[Session] ConnectionManager not initialized');
      showToast('Lỗi hệ thống', 'error');
    }
  }) as EventListener);
}

/**
 * Toolbar groups behave like menu buttons: clicking the trigger toggles
 * the menu and closes any other open group.
 */
function setupGroupDropdown(rootId: string, triggerId: string, menuId: string) {
  const trigger = document.getElementById(triggerId);
  const menu = document.getElementById(menuId);
  if (!trigger || !menu) return;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.session-toolbar .dropdown-menu').forEach((m) => {
      if (m.id !== menuId) m.classList.add('hidden');
    });
    menu.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    const root = document.getElementById(rootId);
    if (root && !root.contains(e.target as Node)) {
      menu.classList.add('hidden');
    }
  });
}

/**
 * Toggle the TeamViewer-style toolbar between collapsed (just a thin
 * handle) and expanded (full bar). Default state on a new session is
 * collapsed so the remote screen has maximum room.
 */
function setToolbarCollapsed(collapsed: boolean) {
  const toolbar = document.getElementById('session-toolbar');
  const handle = document.getElementById('toolbar-handle');
  if (!toolbar || !handle) return;
  toolbar.classList.toggle('collapsed', collapsed);
  handle.classList.toggle('visible', collapsed);
  if (collapsed) {
    document
      .querySelectorAll('.session-toolbar .dropdown-menu')
      .forEach((m) => m.classList.add('hidden'));
  }
}

function openChatPanel() {
  const chatPanel = document.getElementById('chat-panel');
  const filePanel = document.getElementById('file-panel');
  chatPanel?.classList.remove('hidden');
  filePanel?.classList.add('hidden');
  const badge = document.getElementById('chat-badge');
  if (badge) {
    badge.classList.add('hidden');
    badge.textContent = '0';
  }
}

function openFilePanel() {
  const chatPanel = document.getElementById('chat-panel');
  const filePanel = document.getElementById('file-panel');
  filePanel?.classList.remove('hidden');
  chatPanel?.classList.add('hidden');
}

/**
 * Send a remote system action to the host. Destructive ones (sign-out,
 * restart, shutdown) ask for explicit confirmation first because they
 * cannot be undone — once the host disconnects, you've lost the session.
 */
function runRemoteAction(action: string): void {
  const labels: Record<string, string> = {
    'ctrl-alt-del': 'gửi Ctrl+Alt+Del',
    'lock': 'khóa máy đối tác',
    'signout': 'đăng xuất tài khoản đối tác',
    'restart': 'khởi động lại máy đối tác',
    'shutdown': 'tắt máy đối tác',
    'task-manager': 'mở Task Manager',
  };
  const destructive = action === 'restart' || action === 'shutdown' || action === 'signout';
  if (destructive) {
    const ok = window.confirm(
      `Bạn có chắc muốn ${labels[action] || action}?\n` +
        `Thao tác này sẽ làm mất kết nối phiên hiện tại.`,
    );
    if (!ok) return;
  }

  const sent = window.connectionManager?.sendRemoteAction(action);
  if (sent === false) {
    showToast('Chưa kết nối — không thể gửi lệnh', 'error');
  } else {
    showToast(`Đã gửi lệnh: ${labels[action] || action}`, 'info');
  }
}

/**
 * Send chat message
 */
function sendChat() {
  const input = document.getElementById('chat-input') as HTMLInputElement;
  if (!input || !input.value.trim()) return;

  const text = input.value.trim();
  input.value = '';

  addChatMessage(text, 'sent');

  // Send via WebRTC data channel
  if (window.connectionManager) {
    const sent = window.connectionManager.sendChat(text);
    if (!sent) {
      showToast('Không thể gửi tin nhắn — chưa kết nối', 'error');
    }
  }
}

/**
 * Add chat message to UI
 */
export function addChatMessage(text: string, type: 'sent' | 'received') {
  // Host mode renders chat in the mini panel instead of the side drawer.
  if (isHostMode) {
    addHostPanelChat(text, type);
    return;
  }

  const container = document.getElementById('chat-messages');
  if (!container) return;

  const now = new Date();
  const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

  const msg = document.createElement('div');
  msg.className = `chat-msg ${type}`;
  msg.innerHTML = `${text}<div class="chat-msg-time">${time}</div>`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;

  // Show badge if panel is hidden and message is received
  if (type === 'received') {
    const panel = document.getElementById('chat-panel');
    if (panel?.classList.contains('hidden')) {
      const badge = document.getElementById('chat-badge');
      if (badge) {
        const count = parseInt(badge.textContent || '0') + 1;
        badge.textContent = count.toString();
        badge.classList.remove('hidden');
      }
    }
  }
}

/**
 * Append a chat row to the host-mode mini panel.
 * Auto-expands the panel on incoming messages so the host doesn't miss them.
 */
function addHostPanelChat(text: string, type: 'sent' | 'received'): void {
  const list = document.getElementById('host-panel-chat');
  if (!list) return;

  const senderLabel =
    type === 'received'
      ? Array.from(hostViewers.values())[0]?.name || 'Khách'
      : 'Bạn';

  const row = document.createElement('div');
  row.className = `host-panel-chat-row host-panel-chat-${type}`;
  row.innerHTML = `
    <div class="host-panel-chat-sender">${senderLabel}:</div>
    <div class="host-panel-chat-text">${escapeHtml(text)}</div>
  `;
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;

  if (type === 'received' && hostPanelCollapsed) {
    setHostPanelCollapsed(false);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Enter host mode — called when this machine is being controlled.
 * Replaces the full session UI with a compact UltraViewer-style mini panel
 * docked to the bottom-right of the screen. The panel can be collapsed
 * to a thin tab via the chevron button.
 */
export function enterHostMode(viewerId: string): void {
  isHostMode = true;
  hostPanelCollapsed = false;

  // Track this viewer so the panel can list multiple connected viewers.
  const fmtId = formatViewerId(viewerId);
  hostViewers.set(viewerId, { id: viewerId, name: fmtId });

  // Hide the regular titlebar and shrink the OS window into the mini-panel.
  document.body.classList.add('host-mode');
  window.titanAPI?.window?.setHostMode?.(true);

  // Navigate to session page so its container is visible.
  navigateTo('session');

  // Build the mini panel UI in place of the regular session container.
  const page = document.getElementById('page-session');
  if (!page) return;
  page.innerHTML = `
    <div class="host-panel" id="host-panel">
      <div class="host-panel-collapsed-tab" id="host-panel-tab" title="Mở rộng">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </div>
      <div class="host-panel-body">
        <div class="host-panel-header" id="host-panel-drag">
          <div class="host-panel-title">
            <span class="host-panel-brand">Titan-XT</span>
            <span class="host-panel-count" id="host-panel-count">(${hostViewers.size} client)</span>
          </div>
          <div class="host-panel-actions">
            <button class="host-panel-iconbtn" id="host-panel-collapse" title="Thu nhỏ">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </button>
            <button class="host-panel-iconbtn" id="host-panel-min" title="Ẩn xuống tray">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
            <button class="host-panel-iconbtn host-panel-close" id="host-panel-close" title="Ngắt kết nối">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        <div class="host-panel-section">
          <div class="host-panel-section-title">Ai đang xem máy tính bạn</div>
          <div class="host-panel-viewers" id="host-panel-viewers"></div>
        </div>

        <div class="host-panel-section host-panel-section-grow">
          <div class="host-panel-section-title">Lịch sử chat</div>
          <div class="host-panel-chat" id="host-panel-chat"></div>
        </div>

        <div class="host-panel-input">
          <input type="text" id="host-panel-chat-input"
                 placeholder="Nhấn phím F1 để chat nhanh"
                 autocomplete="off" spellcheck="false" />
          <button class="host-panel-send" id="host-panel-send" title="Gửi">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  `;

  renderHostViewers();
  setupHostPanelEvents();
  showToast(`${fmtId} đã kết nối vào máy của bạn`, 'info');
}

/**
 * Exit host mode — restore session page to default state.
 * Called when the session ends on the host side.
 */
export function exitHostMode(): void {
  isHostMode = false;
  hostPanelCollapsed = false;
  hostViewers.clear();

  document.body.classList.remove('host-mode', 'host-mode-collapsed');
  window.titanAPI?.window?.setHostMode?.(false);

  // Re-render the default session structure so a future viewer-side
  // session has a clean DOM to mount onto.
  renderSessionPage();
}

function formatViewerId(viewerId: string): string {
  if (!viewerId) return 'Unknown';
  if (viewerId.length >= 9) {
    return `${viewerId.substring(0, 3)} ${viewerId.substring(3, 6)} ${viewerId.substring(6, 9)}`;
  }
  return viewerId;
}

function renderHostViewers(): void {
  const list = document.getElementById('host-panel-viewers');
  const count = document.getElementById('host-panel-count');
  if (count) count.textContent = `(${hostViewers.size} client)`;
  if (!list) return;
  if (hostViewers.size === 0) {
    list.innerHTML = '<div class="host-panel-viewer-empty">Chưa có ai kết nối</div>';
    return;
  }
  list.innerHTML = Array.from(hostViewers.values())
    .map(
      (v) => `
        <div class="host-panel-viewer">
          <span class="host-panel-viewer-dot"></span>
          <span class="host-panel-viewer-name">${v.name}</span>
        </div>`,
    )
    .join('');
}

function setupHostPanelEvents(): void {
  document.getElementById('host-panel-collapse')?.addEventListener('click', () => {
    setHostPanelCollapsed(true);
  });
  document.getElementById('host-panel-tab')?.addEventListener('click', () => {
    setHostPanelCollapsed(false);
  });
  document.getElementById('host-panel-min')?.addEventListener('click', () => {
    window.titanAPI?.window?.minimize();
  });
  document.getElementById('host-panel-close')?.addEventListener('click', () => {
    try {
      window.connectionManager?.disconnect();
    } catch (e) {
      console.warn('[Host] disconnect error:', e);
    }
    // Return to the home page so the host has a normal UI again.
    navigateTo('home');
    showToast('Đã ngắt kết nối', 'info');
  });

  const input = document.getElementById('host-panel-chat-input') as HTMLInputElement | null;
  const send = document.getElementById('host-panel-send');
  const sendChatFromPanel = () => {
    if (!input || !input.value.trim()) return;
    const text = input.value.trim();
    input.value = '';
    addChatMessage(text, 'sent');
    window.connectionManager?.sendChat(text);
  };
  send?.addEventListener('click', sendChatFromPanel);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatFromPanel();
  });
}

function setHostPanelCollapsed(collapsed: boolean): void {
  hostPanelCollapsed = collapsed;
  document.body.classList.toggle('host-mode-collapsed', collapsed);
  window.titanAPI?.window?.setHostCollapsed?.(collapsed);
}

/**
 * Add file to transfer list. Returns the row element so the caller can
 * update its progress as chunks flow.
 */
export function addFileEntry(
  fileId: string,
  name: string,
  size: number,
  status: 'sending' | 'receiving' | 'complete'
): void {
  const sizeStr = size < 1024 * 1024
    ? `${(size / 1024).toFixed(1)} KB`
    : `${(size / 1024 / 1024).toFixed(1)} MB`;

  if (isHostMode) {
    addHostPanelFile(fileId, name, sizeStr, status);
    return;
  }

  const list = document.getElementById('file-list');
  if (!list) return;

  const item = document.createElement('div');
  item.className = 'file-item';
  item.dataset.fileId = fileId;
  item.innerHTML = `
    <div class="file-item-info">
      <div class="file-item-name">${name}</div>
      <div class="file-item-size" data-size>${sizeStr} — ${status === 'sending' ? 'Đang gửi' : status === 'receiving' ? 'Đang nhận' : 'Hoàn thành'}</div>
      <div class="file-progress"><div class="file-progress-bar" data-bar style="width: ${status === 'complete' ? '100' : '0'}%"></div></div>
    </div>
  `;
  list.appendChild(item);

  // Auto-open file panel so user sees progress.
  document.getElementById('file-panel')?.classList.remove('hidden');
  document.getElementById('btn-file-transfer')?.classList.add('active');
}

/**
 * Render a file transfer entry inside the host mini panel chat list,
 * matching UltraViewer's file row style (icon + name + status + bar).
 */
function addHostPanelFile(
  fileId: string,
  name: string,
  sizeStr: string,
  status: 'sending' | 'receiving' | 'complete',
): void {
  const list = document.getElementById('host-panel-chat');
  if (!list) return;

  const senderLabel =
    status === 'receiving'
      ? Array.from(hostViewers.values())[0]?.name || 'Khách'
      : 'Bạn';
  const statusText =
    status === 'sending'
      ? 'Đang gửi'
      : status === 'receiving'
      ? 'Đang nhận'
      : status === 'complete'
      ? 'File Received'
      : status;

  const row = document.createElement('div');
  row.className = 'host-panel-file-row';
  row.dataset.fileId = fileId;
  row.innerHTML = `
    <div class="host-panel-chat-sender">${senderLabel}:</div>
    <div class="host-panel-file">
      <div class="host-panel-file-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/>
          <polyline points="13 2 13 9 20 9"/>
        </svg>
      </div>
      <div class="host-panel-file-info">
        <div class="host-panel-file-name">${escapeHtml(name)}</div>
        <div class="host-panel-file-status" data-size>${sizeStr} — ${statusText}</div>
        <div class="host-panel-file-progress">
          <div class="host-panel-file-progress-bar" data-bar
               style="width: ${status === 'complete' ? '100' : '0'}%"></div>
        </div>
      </div>
    </div>
  `;
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;

  if (status === 'receiving' && hostPanelCollapsed) {
    setHostPanelCollapsed(false);
  }
}

/**
 * Update progress bar + status label for an in-flight transfer.
 * @param percent 0-100
 * @param status display status text
 */
export function updateFileProgress(
  fileId: string,
  percent: number,
  status: 'sending' | 'receiving' | 'complete' | 'error'
): void {
  const labelMap: Record<string, string> = {
    sending: 'Đang gửi',
    receiving: 'Đang nhận',
    complete: isHostMode ? 'File Received' : 'Hoàn thành',
    error: 'Lỗi',
  };

  if (isHostMode) {
    const list = document.getElementById('host-panel-chat');
    const row = list?.querySelector(`.host-panel-file-row[data-file-id="${fileId}"]`);
    if (!row) return;
    const bar = row.querySelector('[data-bar]') as HTMLElement | null;
    const sizeEl = row.querySelector('[data-size]') as HTMLElement | null;
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (sizeEl) {
      const original = sizeEl.textContent || '';
      const sizePrefix = original.split('—')[0]?.trim() || '';
      sizeEl.textContent = `${sizePrefix} — ${labelMap[status] || status}`;
    }
    return;
  }

  const list = document.getElementById('file-list');
  if (!list) return;
  const row = list.querySelector(`.file-item[data-file-id="${fileId}"]`);
  if (!row) return;
  const bar = row.querySelector('[data-bar]') as HTMLElement | null;
  const sizeEl = row.querySelector('[data-size]') as HTMLElement | null;
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  if (sizeEl) {
    const original = sizeEl.textContent || '';
    const sizePrefix = original.split('—')[0]?.trim() || '';
    sizeEl.textContent = `${sizePrefix} — ${labelMap[status] || status}`;
  }
}

/**
 * Handle disconnect
 */
function handleDisconnect() {
  // Tear down WebRTC peer + input handler so we don't leave a live session behind.
  try {
    window.connectionManager?.disconnect();
  } catch (e) {
    console.warn('[Session] disconnect error:', e);
  }

  // Detach remote video stream
  const videoEl = document.getElementById('remote-video') as HTMLVideoElement | null;
  if (videoEl) {
    const stream = videoEl.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    videoEl.srcObject = null;
  }
  document.getElementById('video-overlay')?.classList.remove('hidden');

  navigateTo('home');
  showToast('Đã ngắt kết nối', 'info');
}
