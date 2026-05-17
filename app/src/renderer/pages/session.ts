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

      <!-- Toolbar -->
      <div class="session-toolbar" id="session-toolbar">
        <div class="toolbar-left">
          <span class="toolbar-partner" id="toolbar-partner-name">Đang kết nối...</span>
        </div>
        <div class="toolbar-center">
          <button class="toolbar-btn" id="btn-monitor-select" title="Chọn màn hình">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
            </svg>
          </button>
          <button class="toolbar-btn" id="btn-fullscreen" title="Toàn màn hình">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/>
            </svg>
          </button>

          <!-- Quality dropdown (viewer side) -->
          <div class="toolbar-dropdown" id="quality-dropdown">
            <button class="toolbar-btn" id="btn-quality" title="Chất lượng">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 12h4l3-9 4 18 3-9h4"/>
              </svg>
              <span id="quality-label" class="toolbar-btn-label">Cao</span>
            </button>
            <div class="dropdown-menu hidden" id="quality-menu">
              ${(Object.keys(QUALITY_PROFILES) as QualityPreset[])
                .map((k) => `<button class="dropdown-item" data-quality="${k}">${QUALITY_PROFILES[k].label}</button>`)
                .join('')}
            </div>
          </div>

          <!-- Display fit dropdown (viewer side, render-only) -->
          <div class="toolbar-dropdown" id="fit-dropdown">
            <button class="toolbar-btn" id="btn-fit" title="Hiển thị">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/>
              </svg>
              <span id="fit-label" class="toolbar-btn-label">Vừa khung</span>
            </button>
            <div class="dropdown-menu hidden" id="fit-menu">
              <button class="dropdown-item" data-fit="contain">Vừa khung</button>
              <button class="dropdown-item" data-fit="cover">Lấp đầy (cắt)</button>
              <button class="dropdown-item" data-fit="fill">Kéo dãn</button>
            </div>
          </div>
          <div class="toolbar-separator"></div>
          <button class="toolbar-btn" id="btn-file-transfer" title="Truyền file">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/>
            </svg>
          </button>
          <button class="toolbar-btn" id="btn-chat" title="Chat">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
            <span class="badge hidden" id="chat-badge">0</span>
          </button>
        </div>
        <div class="toolbar-right">
          <span class="toolbar-stats" id="toolbar-stats">
            <span class="stat-latency" id="stat-latency">--ms</span>
            <span class="stat-fps" id="stat-fps">--fps</span>
            <span class="stat-bitrate" id="stat-bitrate">--</span>
          </span>
          <button class="toolbar-btn btn-danger" id="btn-disconnect" title="Ngắt kết nối">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
            Ngắt
          </button>
        </div>
      </div>

      <!-- Chat Panel -->
      <div class="chat-panel hidden" id="chat-panel">
        <div class="chat-header">
          <h3>💬 Chat</h3>
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
          <h3>📁 Truyền file</h3>
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
 * Wire toggle behavior for a toolbar dropdown:
 * clicking the trigger toggles its menu and closes any others.
 */
function setupDropdown(rootId: string, triggerId: string, menuId: string) {
  const trigger = document.getElementById(triggerId);
  const menu = document.getElementById(menuId);
  if (!trigger || !menu) return;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close other dropdowns
    document.querySelectorAll('.dropdown-menu').forEach((m) => {
      if (m.id !== menuId) m.classList.add('hidden');
    });
    menu.classList.toggle('hidden');
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    const root = document.getElementById(rootId);
    if (root && !root.contains(e.target as Node)) {
      menu.classList.add('hidden');
    }
  });
}

/**
 * Setup session event listeners
 */
function setupSessionEvents() {
  // Disconnect
  document.getElementById('btn-disconnect')?.addEventListener('click', () => {
    handleDisconnect();
  });

  // Fullscreen
  document.getElementById('btn-fullscreen')?.addEventListener('click', () => {
    const wrapper = document.getElementById('video-wrapper');
    if (wrapper) {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        wrapper.requestFullscreen();
      }
    }
  });

  // Quality dropdown
  setupDropdown('quality-dropdown', 'btn-quality', 'quality-menu');
  document.querySelectorAll('#quality-menu .dropdown-item').forEach((item) => {
    item.addEventListener('click', () => {
      const preset = (item as HTMLElement).dataset.quality as QualityPreset | undefined;
      if (!preset) return;
      const ok = window.connectionManager?.requestQuality(preset);
      const label = document.getElementById('quality-label');
      if (label) {
        const map: Record<QualityPreset, string> = { high: 'Cao', medium: 'Trung bình', low: 'Thấp' };
        label.textContent = map[preset];
      }
      document.getElementById('quality-menu')?.classList.add('hidden');
      if (ok === false) {
        showToast('Chưa kết nối — chưa thể đổi chất lượng', 'info');
      } else {
        showToast(`Đã yêu cầu chất lượng: ${QUALITY_PROFILES[preset].label}`, 'success');
      }
    });
  });

  // Display fit dropdown — render-only, doesn't touch the stream
  setupDropdown('fit-dropdown', 'btn-fit', 'fit-menu');
  document.querySelectorAll('#fit-menu .dropdown-item').forEach((item) => {
    item.addEventListener('click', () => {
      const fit = (item as HTMLElement).dataset.fit as DisplayFit | undefined;
      if (!fit) return;
      currentFit = fit;
      const video = document.getElementById('remote-video') as HTMLVideoElement | null;
      if (video) video.style.objectFit = fit;
      const label = document.getElementById('fit-label');
      const labelMap: Record<DisplayFit, string> = {
        contain: 'Vừa khung',
        cover: 'Lấp đầy (cắt)',
        fill: 'Kéo dãn',
      };
      if (label) label.textContent = labelMap[fit];
      document.getElementById('fit-menu')?.classList.add('hidden');
    });
  });

  // Toggle Chat
  document.getElementById('btn-chat')?.addEventListener('click', () => {
    const panel = document.getElementById('chat-panel');
    const filePanel = document.getElementById('file-panel');
    const btn = document.getElementById('btn-chat');
    panel?.classList.toggle('hidden');
    filePanel?.classList.add('hidden');
    btn?.classList.toggle('active');
    document.getElementById('btn-file-transfer')?.classList.remove('active');
    // Hide badge
    const badge = document.getElementById('chat-badge');
    if (badge) { badge.classList.add('hidden'); badge.textContent = '0'; }
  });

  document.getElementById('btn-close-chat')?.addEventListener('click', () => {
    document.getElementById('chat-panel')?.classList.add('hidden');
    document.getElementById('btn-chat')?.classList.remove('active');
  });

  // Toggle File Panel
  document.getElementById('btn-file-transfer')?.addEventListener('click', () => {
    const panel = document.getElementById('file-panel');
    const chatPanel = document.getElementById('chat-panel');
    const btn = document.getElementById('btn-file-transfer');
    panel?.classList.toggle('hidden');
    chatPanel?.classList.add('hidden');
    btn?.classList.toggle('active');
    document.getElementById('btn-chat')?.classList.remove('active');
  });

  document.getElementById('btn-close-file')?.addEventListener('click', () => {
    document.getElementById('file-panel')?.classList.add('hidden');
    document.getElementById('btn-file-transfer')?.classList.remove('active');
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
