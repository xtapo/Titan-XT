/**
 * Session Page — Remote desktop view with toolbar, chat, file transfer
 */

import { showToast } from '../components/toast';
import { navigateTo } from '../main';
import { QUALITY_PROFILES, QualityPreset, CODEC_LABELS, VideoCodec } from '../../shared/constants';
import { ConnectionManager } from '../lib/connection';
import { SessionRecorder, formatElapsed, RecorderState } from '../lib/recorder';
import { AnnotationController } from '../lib/annotation';
import { auditLog } from '../lib/audit-logger';

type DisplayFit = 'contain' | 'cover' | 'fill';
let isHostMode = false;
let hostPanelCollapsed = false;
const hostViewers = new Map<string, { id: string; name: string; mode: 'control' | 'view' }>();
// Host-side: mirror of ConnectionManager.controlLocked so the panel UI can
// reflect the lock state on first paint without round-tripping through the
// connection manager.
let hostControlLocked = false;

// Viewer-side: lazily created on first record. Kept module-scoped so the
// indicator update + the menu entry can both reach the same instance.
let recorder: SessionRecorder | null = null;
let recorderPartnerId: string = '';

// Viewer-side annotation controller. Lazy-mounted on first session render so
// we don't pay the canvas/toolbar cost when no session is active. The host
// never instantiates this — annotation is a viewer-driven action that mirrors
// to the host's transparent overlay window.
let annotationCtl: AnnotationController | null = null;

/**
 * Render session page structure
 */
export function renderSessionPage() {
  const page = document.getElementById('page-session');
  if (!page) return;

  page.innerHTML = `
    <div class="session-container">
      <div class="video-wrapper" id="video-wrapper">
        <video id="remote-video" autoplay playsinline muted disablepictureinpicture disableremoteplayback></video>
        <!-- Synthetic cursor — drawn at the viewer's local mouse position with
             zero latency so the user feels native cursor responsiveness even
             when the video frame carrying the host's real cursor hasn't
             arrived yet. Hidden by default; InputHandler shows it during
             control sessions and positions it via transform on every move. -->
        <div class="synthetic-cursor hidden" id="synthetic-cursor">
          <svg width="20" height="22" viewBox="0 0 20 22" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 1.5 L2 17 L6 13 L9 19 L11.5 18 L8.5 12 L14 12 Z"
                  fill="white" stroke="black" stroke-width="1.2" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="video-overlay" id="video-overlay">
          <div class="connecting-spinner">
            <div class="spinner"></div>
            <p id="session-status-text">Đang kết nối...</p>
          </div>
        </div>
        <!-- Drop overlay shown to the viewer while a file is being dragged
             over the remote video. Lands on the host's Desktop on release. -->
        <div class="video-drop-overlay hidden" id="video-drop-overlay">
          <div class="video-drop-card">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <div class="video-drop-title">Thả để gửi tới Desktop của host</div>
            <div class="video-drop-sub">File sẽ xuất hiện trên màn hình máy đối tác</div>
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
              <button class="dropdown-item dropdown-item-toggle" data-action="toggle-wallpaper" id="menu-toggle-wallpaper">
                <span class="dropdown-item-label">Tắt hình nền (giảm lag)</span>
                <span class="dropdown-item-check hidden" data-wallpaper-check>✓</span>
              </button>
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
              <div class="dropdown-section-label">Chế độ</div>
              <button class="dropdown-item dropdown-item-toggle" data-mode="control">
                <span class="dropdown-item-label">Điều khiển</span>
                <span class="dropdown-item-check" data-mode-check="control">✓</span>
              </button>
              <button class="dropdown-item dropdown-item-toggle" data-mode="view">
                <span class="dropdown-item-label">Chỉ xem</span>
                <span class="dropdown-item-check hidden" data-mode-check="view">✓</span>
              </button>
              <div class="dropdown-divider"></div>
              <button class="dropdown-item" data-view="fullscreen">Toàn màn hình</button>
              <div class="dropdown-divider"></div>
              <div class="dropdown-section-label">Màn hình của host</div>
              <div class="dropdown-monitor-list" id="menu-view-monitors">
                <div class="dropdown-item-empty">Chờ host gửi danh sách...</div>
              </div>
              <div class="dropdown-divider"></div>
              <div class="dropdown-section-label">Chất lượng</div>
              <button class="dropdown-item dropdown-item-toggle" data-quality="auto">
                <span class="dropdown-item-label">Tự động (theo mạng)</span>
                <span class="dropdown-item-check" data-quality-check="auto">✓</span>
              </button>
              ${(Object.keys(QUALITY_PROFILES) as QualityPreset[])
                .map((k) => `<button class="dropdown-item dropdown-item-toggle" data-quality="${k}">
                  <span class="dropdown-item-label">${QUALITY_PROFILES[k].label}</span>
                  <span class="dropdown-item-check hidden" data-quality-check="${k}">✓</span>
                </button>`)
                .join('')}
              <div class="dropdown-divider"></div>
              <div class="dropdown-section-label">Codec video</div>
              ${(['h264', 'h265', 'av1', 'vp9'] as VideoCodec[])
                .map((c) => {
                  const supported = ConnectionManager.codecSupported(c);
                  const cls = supported
                    ? 'dropdown-item dropdown-item-toggle'
                    : 'dropdown-item dropdown-item-toggle dropdown-item-disabled';
                  const note = supported ? '' : ' (không hỗ trợ)';
                  // The dropdown-item-check span is rendered for every codec
                  // so updateCodecMenu() can flip the `hidden` class without
                  // rebuilding the markup. The default codec gets the check
                  // shown on first paint; the switch happens after handshake.
                  const checkHidden = c === 'h264' ? '' : 'hidden';
                  return `<button class="${cls}" data-codec="${c}"${supported ? '' : ' disabled'}>
                    <span class="dropdown-item-label">${CODEC_LABELS[c]}${note}</span>
                    <span class="dropdown-item-check ${checkHidden}" data-codec-check="${c}">✓</span>
                  </button>`;
                })
                .join('')}
              <div class="dropdown-divider"></div>
              <div class="dropdown-section-label">Hiển thị</div>
              <button class="dropdown-item dropdown-item-toggle" data-fit="contain">
                <span class="dropdown-item-label">Vừa khung</span>
                <span class="dropdown-item-check" data-fit-check="contain">✓</span>
              </button>
              <button class="dropdown-item dropdown-item-toggle" data-fit="cover">
                <span class="dropdown-item-label">Lấp đầy (cắt)</span>
                <span class="dropdown-item-check hidden" data-fit-check="cover">✓</span>
              </button>
              <button class="dropdown-item dropdown-item-toggle" data-fit="fill">
                <span class="dropdown-item-label">Kéo dãn</span>
                <span class="dropdown-item-check hidden" data-fit-check="fill">✓</span>
              </button>
              <div class="dropdown-divider"></div>
              <div class="dropdown-section-label">Âm thanh</div>
              <button class="dropdown-item dropdown-item-toggle" data-audio="toggle" id="menu-audio-toggle">
                <span class="dropdown-item-label">Bật âm thanh máy đối tác</span>
                <span class="dropdown-item-check hidden" data-audio-check>✓</span>
              </button>
              <div class="dropdown-divider"></div>
              <div class="dropdown-section-label">Vẽ trên màn hình</div>
              <button class="dropdown-item dropdown-item-toggle" data-annotate="toggle" id="menu-annotate-toggle">
                <span class="dropdown-item-label">Bật chế độ vẽ</span>
                <span class="dropdown-item-check hidden" data-annotate-check>✓</span>
              </button>
              <button class="dropdown-item" data-annotate="undo">Hoàn tác nét vẽ cuối (Ctrl+Z)</button>
              <button class="dropdown-item" data-annotate="clear">Xóa hết các nét vẽ</button>
              <div class="dropdown-divider"></div>
              <div class="dropdown-section-label">Đường truyền</div>
              <button class="dropdown-item" data-metrics="toggle">Bật/tắt bảng đồng hồ đo</button>
              <div class="dropdown-divider"></div>
              <div class="dropdown-section-label">Clipboard</div>
              <button class="dropdown-item dropdown-item-toggle" data-clipboard="toggle" id="menu-clipboard-toggle">
                <span class="dropdown-item-label">Tự động đồng bộ clipboard</span>
                <span class="dropdown-item-check hidden" data-clipboard-check>✓</span>
              </button>
              <button class="dropdown-item dropdown-item-toggle" data-clipboard="toggle-images" id="menu-clipboard-images-toggle">
                <span class="dropdown-item-label">Đồng bộ cả ảnh trong clipboard</span>
                <span class="dropdown-item-check hidden" data-clipboard-images-check>✓</span>
              </button>
              <button class="dropdown-item" data-clipboard="pull">Lấy clipboard từ máy đối tác</button>
              <button class="dropdown-item" data-clipboard="push">Đẩy clipboard sang máy đối tác</button>
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
              <div class="dropdown-divider"></div>
              <button class="dropdown-item" data-files="record-toggle" id="menu-record-toggle">
                <span class="dropdown-item-label">Bắt đầu ghi phiên</span>
              </button>
              <button class="dropdown-item" data-files="record-folder">Mở thư mục bản ghi</button>
            </div>
          </div>
        </div>

        <div class="toolbar-right">
          <span class="toolbar-stats" id="toolbar-stats">
            <span class="stat-network-badge" id="stat-network-badge" title="Tình trạng mạng">
              <span class="stat-network-dot"></span>
              <span class="stat-network-label">--</span>
            </span>
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

      <!-- Persistent indicator: shown to viewer when host has locked control. -->
      <div class="control-lock-banner hidden" id="control-lock-banner">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
          <rect x="3" y="11" width="18" height="11" rx="2"/>
          <path d="M7 11V7a5 5 0 0110 0v4"/>
        </svg>
        <span>Host đã khóa quyền điều khiển — bạn chỉ có thể xem</span>
      </div>

      <!-- Persistent indicator: red dot + elapsed time while a recording is in progress. -->
      <div class="recording-indicator hidden" id="recording-indicator" title="Đang ghi phiên — bấm để dừng">
        <span class="recording-dot"></span>
        <span class="recording-text">REC</span>
        <span class="recording-elapsed" id="recording-elapsed">00:00</span>
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

  // View menu — fullscreen + monitor + quality + display fit (consolidated).
  // Use event delegation on the menu itself so dynamically-rendered monitor
  // buttons (added via updateMonitorMenu) trigger their click handler too.
  document.getElementById('menu-view')?.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('.dropdown-item') as HTMLElement | null;
    if (!item) return;
    const view = item.dataset.view;
    const quality = item.dataset.quality as QualityPreset | undefined;
    const codec = item.dataset.codec as VideoCodec | undefined;
    const fit = item.dataset.fit as DisplayFit | undefined;
    const mode = item.dataset.mode as 'control' | 'view' | undefined;
    const monitorId = item.dataset.monitor;
    const audio = item.dataset.audio;
    const annotate = item.dataset.annotate;
    document.getElementById('menu-view')?.classList.add('hidden');

    if (mode) {
      handleViewerModeChange(mode);
    } else if (audio === 'toggle') {
      toggleRemoteAudio();
    } else if (annotate === 'toggle') {
      toggleAnnotationMode();
    } else if (annotate === 'undo') {
      annotationCtl?.undo();
    } else if (annotate === 'clear') {
      annotationCtl?.clear();
    } else if (item.dataset.metrics === 'toggle') {
      // Lazy-import so the metrics module's bundle work doesn't run unless
      // the user actually opens the panel during a session.
      import('../lib/metrics').then(({ toggleMetricsPanel }) => toggleMetricsPanel());
    } else if (item.dataset.clipboard === 'pull') {
      const ok = window.connectionManager?.pullHostClipboard();
      showToast(
        ok ? 'Đã yêu cầu clipboard từ máy đối tác' : (window.connectionManager?.isClipboardSyncEnabled === false ? 'Hãy bật đồng bộ clipboard trước' : 'Chưa kết nối'),
        ok ? 'success' : 'info',
      );
    } else if (item.dataset.clipboard === 'push') {
      window.connectionManager?.pushClipboardToHost?.().then((ok) => {
        showToast(
          ok ? 'Đã gửi clipboard sang máy đối tác' : (window.connectionManager?.isClipboardSyncEnabled === false ? 'Hãy bật đồng bộ clipboard trước' : 'Không có nội dung clipboard'),
          ok ? 'success' : 'info',
        );
      });
    } else if (item.dataset.clipboard === 'toggle') {
      const cm = window.connectionManager;
      if (!cm) return;
      const next = !cm.isClipboardSyncEnabled;
      cm.setClipboardSync({ enabled: next });
      updateClipboardToggleUI();
      showToast(next ? 'Đã bật đồng bộ clipboard' : 'Đã tắt đồng bộ clipboard', next ? 'success' : 'info');
    } else if (item.dataset.clipboard === 'toggle-images') {
      const cm = window.connectionManager;
      if (!cm) return;
      const next = !cm.isClipboardSyncImagesEnabled;
      cm.setClipboardSync({ images: next });
      updateClipboardToggleUI();
      showToast(next ? 'Đã bật đồng bộ ảnh clipboard' : 'Đã tắt đồng bộ ảnh clipboard', next ? 'success' : 'info');
    } else if (view === 'fullscreen') {
      const wrapper = document.getElementById('video-wrapper');
      if (wrapper) {
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          wrapper.requestFullscreen();
        }
      }
    } else if (monitorId) {
      const ok = window.connectionManager?.requestMonitor(monitorId);
      if (ok === false) {
        showToast('Chưa kết nối — chưa thể đổi màn hình', 'info');
      } else {
        showToast('Đang đổi màn hình chia sẻ...', 'info');
      }
    } else if (quality === ('auto' as any)) {
      // Re-enable the adaptive controller so the viewer climbs/descends
      // tiers based on observed network conditions instead of the user's
      // last manual pick.
      window.connectionManager?.setAdaptiveEnabled?.(true);
      refreshQualityUI();
      showToast('Đã bật chất lượng tự động', 'success');
    } else if (quality) {
      const ok = window.connectionManager?.requestQuality(quality);
      if (ok === false) {
        showToast('Chưa kết nối — chưa thể đổi chất lượng', 'info');
      } else {
        refreshQualityUI();
        showToast(`Đã yêu cầu chất lượng: ${QUALITY_PROFILES[quality].label}`, 'success');
      }
    } else if (codec) {
      if (!ConnectionManager.codecSupported(codec)) {
        showToast(`Trình duyệt không hỗ trợ ${CODEC_LABELS[codec]}`, 'error');
        return;
      }
      const ok = window.connectionManager?.requestCodec(codec);
      if (ok === false) {
        showToast('Chưa kết nối — chưa thể đổi codec', 'info');
      } else {
        refreshCodecUI(codec);
        showToast(`Đã yêu cầu chuyển sang ${CODEC_LABELS[codec]}`, 'success');
      }
    } else if (fit) {
      const video = document.getElementById('remote-video') as HTMLVideoElement | null;
      if (video) video.style.objectFit = fit;
      refreshFitUI(fit);
    }
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
      else if (action === 'record-toggle') toggleSessionRecording();
      else if (action === 'record-folder') openRecordingsFolder();
    });
  });

  // Recording indicator: clicking the badge stops the recording — quicker
  // than re-opening the menu just to find the toggle.
  document.getElementById('recording-indicator')?.addEventListener('click', () => {
    if (recorder?.isRecording) toggleSessionRecording();
  });

  document.getElementById('btn-close-chat')?.addEventListener('click', () => {
    document.getElementById('chat-panel')?.classList.add('hidden');
  });
  document.getElementById('btn-close-file')?.addEventListener('click', () => {
    document.getElementById('file-panel')?.classList.add('hidden');
  });

  // Make floating dialogs draggable by their header so they can be moved
  // off the area the user is actively controlling.
  enableDialogDrag('chat-panel', '.chat-header');
  enableDialogDrag('file-panel', '.file-header');

  // Chat send
  const chatInput = document.getElementById('chat-input') as HTMLInputElement;
  document.getElementById('btn-send-chat')?.addEventListener('click', () => sendChat());
  chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

/**
 * Helper to zip a directory if needed and enqueue it for sending.
 */
async function handleSendFileOrFolder(filePath: string, targetHint?: 'desktop'): Promise<void> {
  try {
    if (window.titanAPI?.file?.prepareFileOrFolder) {
      const f = await window.titanAPI.file.prepareFileOrFolder(filePath);
      if (f) {
        await window.connectionManager?.sendFile(f.path, f.name, f.size, targetHint);
      }
    } else {
      const name = filePath.split(/[\\/]/).pop() || 'file';
      await window.connectionManager?.sendFile(filePath, name, 0, targetHint);
    }
  } catch (err) {
    console.error('[Session] send error:', err);
    showToast('Không thể gửi mục này', 'error');
  }
}

  // File select
  document.getElementById('btn-select-files')?.addEventListener('click', async () => {
    try {
      if (window.titanAPI?.file) {
        const files = await window.titanAPI.file.selectFiles();
        if (files && files.length > 0) {
          for (const f of files) {
            await handleSendFileOrFolder(f.path);
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
      for (const f of Array.from(files)) {
        const filePath = (f as any).path as string | undefined;
        if (!filePath) {
          showToast('Không lấy được đường dẫn file — hãy dùng nút Chọn file', 'error');
          continue;
        }
        await handleSendFileOrFolder(filePath);
      }
    });
  }

  // Drag-onto-video: viewer can drop a file straight onto the remote video
  // and it lands on the host's Desktop. UltraViewer-style "throw it across".
  setupVideoDropZone();

  // Listen for session start
  window.addEventListener('start-session', ((e: CustomEvent) => {
    const { partnerId, password, mode } = e.detail;
    const partnerName = document.getElementById('toolbar-partner-name');
    if (partnerName) {
      const fmtId = `${partnerId.substring(0, 3)} ${partnerId.substring(3, 6)} ${partnerId.substring(6, 9)}`;
      partnerName.textContent = `Đang kết nối đến ${fmtId}...`;
    }

    // Reflect the connect-mode the user chose on the home screen in the
    // Control/View toggle. Without this, joining as 'view' still shows a
    // checkmark on "Điều khiển".
    refreshViewerModeUI(mode === 'view' ? 'view' : 'control');

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
 * Wire viewer-side drag-and-drop on the remote video. Dropping a file (or
 * several) here streams them to the host with `targetHint='desktop'`, so
 * they appear on the host's actual OS desktop — UltraViewer / AnyDesk-style
 * "throw a file across the screen" UX.
 *
 * The overlay only appears while a real file drag is in progress (we filter
 * for the `Files` type) so we don't intercept text selection or input drag.
 * Counter trick handles dragenter firing on every child element.
 */
function setupVideoDropZone(): void {
  const wrapper = document.getElementById('video-wrapper');
  const overlay = document.getElementById('video-drop-overlay');
  if (!wrapper || !overlay) return;

  let dragDepth = 0;

  const isFileDrag = (e: DragEvent): boolean => {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === 'Files') return true;
    }
    return false;
  };

  wrapper.addEventListener('dragenter', (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    // Skip in host mode — the host panel has its own drop handler and the
    // video element isn't even mounted there.
    if (isHostMode) return;
    e.preventDefault();
    dragDepth += 1;
    overlay.classList.remove('hidden');
  });

  wrapper.addEventListener('dragover', (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  wrapper.addEventListener('dragleave', (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.classList.add('hidden');
  });

  wrapper.addEventListener('drop', async (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.add('hidden');
    if (isHostMode) return;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    if (!window.connectionManager) {
      showToast('Chưa kết nối — không thể gửi file', 'error');
      return;
    }

    for (const f of Array.from(files)) {
      const filePath = (f as any).path as string | undefined;
      if (!filePath) {
        showToast('Không lấy được đường dẫn file — hãy dùng nút Chọn file', 'error');
        continue;
      }
      openFilePanel();
      await handleSendFileOrFolder(filePath, 'desktop');
    }
    showToast('Đang gửi tới Desktop của host...', 'info');
  });
}

/**
 * Viewer-side: flip annotation mode on / off. While active, the canvas
 * overlay swallows pointer events so they don't leak into the remote-input
 * handler, and strokes are mirrored to the host's transparent overlay
 * window over CHANNEL_ANNOTATION. The "Bật chế độ vẽ" toggle owns the
 * checkmark + the toolbar visibility together.
 */
function toggleAnnotationMode(): void {
  const wrapper = document.getElementById('video-wrapper');
  if (!wrapper) return;
  if (!window.connectionManager) {
    showToast('Chưa kết nối — chưa thể vẽ', 'info');
    return;
  }

  if (!annotationCtl) {
    annotationCtl = new AnnotationController();
  }
  // Re-attach is idempotent — safe to call every toggle in case the session
  // re-rendered the wrapper (e.g. after navigating home and back).
  annotationCtl.attach(wrapper, (msg) => {
    window.connectionManager?.sendAnnotation(msg);
  });
  annotationCtl.toggle();

  const check = document.querySelector('[data-annotate-check]');
  const label = document.querySelector('#menu-annotate-toggle .dropdown-item-label');
  const on = annotationCtl.isActive;
  check?.classList.toggle('hidden', !on);
  if (label) label.textContent = on ? 'Tắt chế độ vẽ' : 'Bật chế độ vẽ';
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
    const willOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden');
    // Refresh the host's monitor list whenever the View menu opens so the
    // picker reflects plug/unplug events that happened after connect, and
    // as a safety-net for any initial request that was lost on the wire.
    if (willOpen && menuId === 'menu-view') {
      window.connectionManager?.requestMonitorList?.();
      // Re-sync all the toggle check marks so they reflect any state that
      // changed while the menu was closed (adaptive auto-downgrade, codec
      // renegotiation completing, etc).
      refreshQualityUI();
      const codec = window.connectionManager?.codec ?? 'h264';
      refreshCodecUI(codec);
      const video = document.getElementById('remote-video') as HTMLVideoElement | null;
      const fit = (video?.style.objectFit as DisplayFit) || 'contain';
      refreshFitUI(fit);
      updateClipboardToggleUI();
    }
  });

  document.addEventListener('click', (e) => {
    const root = document.getElementById(rootId);
    if (root && !root.contains(e.target as Node)) {
      menu.classList.add('hidden');
    }
  });
}

/**
 * Make a floating dialog draggable by its header. The dialog stays inside
 * the session container so it can't be flung off-screen, and we switch to
 * absolute left/top once dragging starts (the CSS default is right/top).
 */
function enableDialogDrag(panelId: string, handleSelector: string) {
  const panel = document.getElementById(panelId) as HTMLElement | null;
  if (!panel) return;
  const handle = panel.querySelector(handleSelector) as HTMLElement | null;
  if (!handle) return;

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  handle.addEventListener('mousedown', (e) => {
    // Ignore clicks on the close button or any nested control inside the header.
    if ((e.target as HTMLElement).closest('button')) return;
    const container = panel.offsetParent as HTMLElement | null;
    if (!container) return;
    const rect = panel.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left - containerRect.left;
    startTop = rect.top - containerRect.top;

    panel.style.left = `${startLeft}px`;
    panel.style.top = `${startTop}px`;
    panel.style.right = 'auto';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const container = panel.offsetParent as HTMLElement | null;
    if (!container) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const maxLeft = container.clientWidth - panel.offsetWidth;
    const maxTop = container.clientHeight - panel.offsetHeight;
    const nextLeft = Math.max(0, Math.min(maxLeft, startLeft + dx));
    const nextTop = Math.max(0, Math.min(maxTop, startTop + dy));
    panel.style.left = `${nextLeft}px`;
    panel.style.top = `${nextTop}px`;
  });

  document.addEventListener('mouseup', () => {
    dragging = false;
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
 * Toggle session recording on the viewer side. The MediaRecorder taps the
 * remote video element's stream so the saved .webm captures exactly what
 * the user sees — including any quality changes mid-session.
 */
async function toggleSessionRecording(): Promise<void> {
  if (!recorder) {
    recorder = new SessionRecorder({
      onStateChange: (state: RecorderState) => updateRecordingUI(state),
      onElapsed: (seconds) => {
        const el = document.getElementById('recording-elapsed');
        if (el) el.textContent = formatElapsed(seconds);
      },
      onError: (msg) => showToast(msg, 'error'),
      onSaved: (path) => showToast(`Đã lưu bản ghi: ${path}`, 'success'),
    });
  }

  if (recorder.isRecording) {
    await recorder.stop();
    auditLog('recording-stop', 'Dừng ghi phiên');
    return;
  }

  const video = document.getElementById('remote-video') as HTMLVideoElement | null;
  const stream = video?.srcObject as MediaStream | null;
  if (!stream || stream.getVideoTracks().length === 0) {
    showToast('Chưa có hình ảnh để ghi — chờ kết nối ổn định', 'info');
    return;
  }

  recorderPartnerId = window.connectionManager?.partnerIdForRecording || recorderPartnerId;
  await recorder.start(stream, recorderPartnerId);
  auditLog('recording-start', 'Bắt đầu ghi phiên', {
    details: { partnerId: recorderPartnerId },
  });
}

/**
 * Reflect recorder state in the toolbar label and the persistent indicator.
 * Keeps the indicator visible from 'starting' through 'stopping' so the user
 * always knows recording is in progress, even during the brief flush.
 */
function updateRecordingUI(state: RecorderState): void {
  const indicator = document.getElementById('recording-indicator');
  const label = document.querySelector('#menu-record-toggle .dropdown-item-label');
  const elapsed = document.getElementById('recording-elapsed');
  const active = state === 'recording' || state === 'starting' || state === 'stopping';

  indicator?.classList.toggle('hidden', !active);
  indicator?.classList.toggle('recording-stopping', state === 'stopping');

  if (label) {
    if (state === 'recording' || state === 'starting') {
      label.textContent = 'Dừng ghi phiên';
    } else if (state === 'stopping') {
      label.textContent = 'Đang lưu...';
    } else {
      label.textContent = 'Bắt đầu ghi phiên';
      if (elapsed) elapsed.textContent = '00:00';
    }
  }
}

/**
 * Ask main to reveal the recordings folder in OS file explorer. Useful when
 * the user can't remember where the file ended up.
 */
async function openRecordingsFolder(): Promise<void> {
  const api = (window as any).titanAPI?.recording;
  if (!api?.openFolder) {
    showToast('Bản dựng này chưa hỗ trợ ghi phiên', 'info');
    return;
  }
  const result = await api.openFolder();
  if (result?.success === false) {
    showToast(result.error || 'Không mở được thư mục', 'error');
  }
}

/**
 * Viewer-side: flip the remote video element between muted and unmuted.
 * The element starts muted so Chromium honors the autoplay policy on first
 * stream attach; the user opts in to host audio explicitly via the menu.
 *
 * Updates the menu checkmark + label so the current state is obvious.
 */
function toggleRemoteAudio(): void {
  const video = document.getElementById('remote-video') as HTMLVideoElement | null;
  if (!video) return;
  const stream = video.srcObject as MediaStream | null;
  const hasAudio = !!stream && stream.getAudioTracks().length > 0;
  if (!hasAudio) {
    showToast('Máy đối tác không gửi âm thanh', 'info');
    return;
  }

  video.muted = !video.muted;
  // Volume defaults to 1; reset in case the OS or a previous session left it at 0.
  if (!video.muted && video.volume === 0) video.volume = 1;

  const check = document.querySelector('[data-audio-check]');
  const label = document.querySelector('#menu-audio-toggle .dropdown-item-label');
  check?.classList.toggle('hidden', video.muted);
  if (label) {
    label.textContent = video.muted
      ? 'Bật âm thanh máy đối tác'
      : 'Tắt âm thanh máy đối tác';
  }
  showToast(video.muted ? 'Đã tắt âm thanh' : 'Đã bật âm thanh máy đối tác', 'info');
}

/**
 * Viewer-side: flip between sending inputs and read-only.
 * Updates the dropdown checkmarks and lets ConnectionManager toggle the
 * input handler. If the host has locked control, we still let the user
 * "choose control" (so the switch reflects their intent) but the actual
 * input handler stays off until the host unlocks.
 */
function handleViewerModeChange(mode: 'control' | 'view'): void {
  const ok = window.connectionManager?.setViewerMode(mode);
  if (ok === false) {
    showToast('Chưa kết nối — không thể đổi chế độ', 'info');
    return;
  }
  refreshViewerModeUI(mode);

  if (mode === 'view') {
    showToast('Chuyển sang chế độ chỉ xem', 'info');
  } else if (window.connectionManager?.isControlLockedRemotely) {
    showToast('Host đang khóa điều khiển — vẫn chỉ xem được', 'info');
  } else {
    showToast('Đã bật chế độ điều khiển', 'success');
  }
}

/**
 * Sync the View menu's mode toggle with the current state. Hides the
 * checkmark on the unselected option and disables the "Điều khiển" entry
 * visually when the host has locked control (to make it clear the
 * limitation comes from the other side, not from the local toggle).
 */
function refreshViewerModeUI(mode: 'control' | 'view'): void {
  const checkControl = document.querySelector('[data-mode-check="control"]');
  const checkView = document.querySelector('[data-mode-check="view"]');
  checkControl?.classList.toggle('hidden', mode !== 'control');
  checkView?.classList.toggle('hidden', mode !== 'view');

  const controlBtn = document.querySelector('[data-mode="control"]') as HTMLElement | null;
  if (controlBtn) {
    controlBtn.classList.toggle(
      'dropdown-item-disabled',
      !!window.connectionManager?.isControlLockedRemotely,
    );
  }
}

/**
 * Sync the View menu's codec toggle with the current state. The host
 * confirms the switch by a renegotiation; once the new offer is accepted
 * we move the check mark. Until then we already paint it on the picked
 * codec optimistically — the user has to *see* something change, otherwise
 * the menu feels broken.
 */
export function refreshCodecUI(codec: 'h264' | 'h265'): void {
  document.querySelectorAll<HTMLElement>('[data-codec-check]').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.codecCheck !== codec);
  });
}

/**
 * Sync the View menu's quality toggle. "Auto" is checked when the adaptive
 * controller owns the preset; otherwise the user-pinned tier wins.
 */
export function refreshQualityUI(): void {
  const conn = window.connectionManager;
  const adaptive = conn?.isAdaptive ?? false;
  const current = conn?.quality;
  document.querySelectorAll<HTMLElement>('[data-quality-check]').forEach((el) => {
    const target = el.dataset.qualityCheck;
    const match = adaptive ? target === 'auto' : target === current;
    el.classList.toggle('hidden', !match);
  });
}

/**
 * Sync the display-fit toggle (contain/cover/fill). Reads the current
 * objectFit off the video element so the check survives a menu rebuild.
 */
export function refreshFitUI(fit: DisplayFit): void {
  document.querySelectorAll<HTMLElement>('[data-fit-check]').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.fitCheck !== fit);
  });
}

/**
 * Called from ConnectionManager when the host pushes a control-lock state
 * change. Updates the persistent banner over the video and refreshes the
 * mode toggle UI so the user sees why the Control option is greyed out.
 */
export function updateRemoteControlLock(locked: boolean): void {
  const banner = document.getElementById('control-lock-banner');
  banner?.classList.toggle('hidden', !locked);
  refreshViewerModeUI(window.connectionManager?.currentViewerMode ?? 'control');
  if (locked) {
    showToast('Host đã khóa quyền điều khiển', 'info');
  } else {
    showToast('Host đã mở khóa điều khiển', 'success');
  }
}

/**
 * Viewer-side: track whether we've asked the host to hide its wallpaper.
 * Used to flip between hide-wallpaper / restore-wallpaper actions and
 * keep the menu checkmark in sync. Reset on disconnect/exit.
 */
let wallpaperHiddenOnHost = false;

export function resetWallpaperToggleUI(): void {
  wallpaperHiddenOnHost = false;
  document.querySelector('[data-wallpaper-check]')?.classList.add('hidden');
}

/**
 * Reflect the current ConnectionManager clipboard-sync state into the
 * Clipboard sub-menu's two toggles. Called whenever the user flips a switch
 * and right after a session begins so the menu matches the persisted prefs.
 */
export function updateClipboardToggleUI(): void {
  const cm = window.connectionManager;
  const enabled = !!cm?.isClipboardSyncEnabled;
  const images = !!cm?.isClipboardSyncImagesEnabled;
  document.querySelector('[data-clipboard-check]')?.classList.toggle('hidden', !enabled);
  document.querySelector('[data-clipboard-images-check]')?.classList.toggle('hidden', !images);
}

/**
 * Called from ConnectionManager when the host reports the result of a
 * hide-wallpaper / restore-wallpaper action. Rolls the optimistic local
 * state back if the host failed, so the menu checkmark stays honest.
 */
export function onWallpaperResult(action: string, success: boolean, error?: string): void {
  if (!success) {
    // Roll back to whatever the host's actual state is. We optimistically
    // flipped on send, so undo that flip here.
    if (action === 'hide-wallpaper') wallpaperHiddenOnHost = false;
    else if (action === 'restore-wallpaper') wallpaperHiddenOnHost = true;
    document
      .querySelector('[data-wallpaper-check]')
      ?.classList.toggle('hidden', !wallpaperHiddenOnHost);
    showToast(`Không thể đổi hình nền: ${error || 'lỗi không rõ'}`, 'error');
    return;
  }
  showToast(
    action === 'hide-wallpaper' ? 'Đã tắt hình nền máy đối tác' : 'Đã bật lại hình nền máy đối tác',
    'success',
  );
}

/**
 * Send a remote system action to the host. Destructive ones (sign-out,
 * restart, shutdown) ask for explicit confirmation first because they
 * cannot be undone — once the host disconnects, you've lost the session.
 */
function runRemoteAction(action: string): void {
  // Wallpaper toggle is virtual — flips between hide/restore based on the
  // local mirror, then sends the resolved action down to the host.
  if (action === 'toggle-wallpaper') {
    const target = wallpaperHiddenOnHost ? 'restore-wallpaper' : 'hide-wallpaper';
    const sent = window.connectionManager?.sendRemoteAction(target);
    if (sent === false) {
      showToast('Chưa kết nối — không thể gửi lệnh', 'error');
    } else {
      // Optimistic flip; the host's result message is the source of truth
      // (handleRemoteActionResult will roll back on failure).
      wallpaperHiddenOnHost = !wallpaperHiddenOnHost;
      document
        .querySelector('[data-wallpaper-check]')
        ?.classList.toggle('hidden', !wallpaperHiddenOnHost);
      showToast(
        wallpaperHiddenOnHost ? 'Đã yêu cầu tắt hình nền' : 'Đã yêu cầu bật lại hình nền',
        'info',
      );
    }
    return;
  }

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

  // Tell the connection manager we're about to break the session on purpose
  // so its auto-reconnect loop knows to wait longer and shows the right copy
  // ("đang chờ máy đối tác khởi động lại..." instead of "mất kết nối").
  if (destructive) {
    window.connectionManager?.markExpectedDisconnect(action);
  }

  const sent = window.connectionManager?.sendRemoteAction(action);
  if (sent === false) {
    // Channel not open — cancel the "expected disconnect" hint we just set,
    // otherwise the next unrelated drop would wait too long.
    if (destructive) window.connectionManager?.clearExpectedDisconnect();
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
export function enterHostMode(viewerId: string, viewerName?: string): void {
  isHostMode = true;
  // Start collapsed by default — only auto-expand when the viewer chats
  // or sends a file. Mirrors UltraViewer's "out of the way until needed"
  // behavior so the host's screen isn't covered.
  hostPanelCollapsed = true;

  // Track this viewer so the panel can list multiple connected viewers.
  // Prefer the machine name sent in connect-request; fall back to the
  // formatted 9-digit id when the viewer didn't provide one.
  const displayName = viewerName?.trim() || formatViewerId(viewerId);
  hostViewers.set(viewerId, { id: viewerId, name: displayName, mode: 'control' });

  // Hide the regular titlebar and shrink the OS window into the mini-panel.
  document.body.classList.add('host-mode');
  // Apply the default collapsed state to the body so the CSS picks it up
  // before the panel mounts (avoids a flash of expanded layout).
  document.body.classList.toggle('host-mode-collapsed', hostPanelCollapsed);
  window.titanAPI?.window?.setHostMode?.(true);
  // Make sure the OS window matches the collapsed default the renderer just
  // applied. setHostMode initially sizes to the expanded panel, so resize.
  if (hostPanelCollapsed) {
    window.titanAPI?.window?.setHostCollapsed?.(true);
  }

  // Navigate to session page so its container is visible.
  navigateTo('session');

  // Build the mini panel UI in place of the regular session container.
  const page = document.getElementById('page-session');
  if (!page) return;
  page.innerHTML = `
    <div class="host-panel" id="host-panel">
      <!-- Drop overlay shown when the host drags a file onto the panel.
           Streams the file to the connected viewer so it lands on their
           Desktop. Mirrors the viewer's drag-onto-video flow. -->
      <div class="host-panel-drop-overlay hidden" id="host-panel-drop-overlay">
        <div class="host-panel-drop-card">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <div class="host-panel-drop-title">Thả để gửi tới khách</div>
          <div class="host-panel-drop-sub">File sẽ xuất hiện trên Desktop của họ</div>
        </div>
      </div>
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
            <button class="host-panel-iconbtn" id="host-panel-lock"
                    title="Khóa quyền điều khiển của khách">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
                <rect x="3" y="11" width="18" height="11" rx="2"/>
                <path d="M7 11V7a5 5 0 0110 0v4"/>
              </svg>
            </button>
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
  setupHostPanelDropZone();
  refreshHostLockUI();
  showToast(`${displayName} đã kết nối vào máy của bạn`, 'info');
}

/**
 * Exit host mode — restore session page to default state.
 * Called when the session ends on the host side.
 */
export function exitHostMode(): void {
  isHostMode = false;
  hostPanelCollapsed = false;
  hostControlLocked = false;
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
    .map((v) => {
      const modeBadge =
        v.mode === 'view'
          ? '<span class="host-panel-viewer-badge host-panel-viewer-badge-view">Chỉ xem</span>'
          : '<span class="host-panel-viewer-badge host-panel-viewer-badge-ctrl">Điều khiển</span>';
      return `
        <div class="host-panel-viewer">
          <span class="host-panel-viewer-dot"></span>
          <span class="host-panel-viewer-name">${v.name}</span>
          ${modeBadge}
        </div>`;
    })
    .join('');
}

function setupHostPanelEvents(): void {
  document.getElementById('host-panel-lock')?.addEventListener('click', () => {
    toggleHostControlLock();
  });
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
 * Wire host-side drag-and-drop on the mini panel. Dropping a file streams
 * it to the connected viewer with `targetHint='desktop'`, so the viewer
 * sees the file land on its own OS desktop. Symmetrical with the viewer's
 * drag-onto-video flow.
 *
 * Auto-expands the panel on dragenter so the host can see the drop target
 * even when collapsed to the side tab.
 */
function setupHostPanelDropZone(): void {
  const panel = document.getElementById('host-panel');
  const overlay = document.getElementById('host-panel-drop-overlay');
  if (!panel || !overlay) return;

  let dragDepth = 0;

  const isFileDrag = (e: DragEvent): boolean => {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === 'Files') return true;
    }
    return false;
  };

  panel.addEventListener('dragenter', (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth += 1;
    if (hostPanelCollapsed) setHostPanelCollapsed(false);
    overlay.classList.remove('hidden');
  });

  panel.addEventListener('dragover', (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  panel.addEventListener('dragleave', (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.classList.add('hidden');
  });

  panel.addEventListener('drop', async (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.add('hidden');

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    if (!window.connectionManager) {
      showToast('Chưa kết nối — không thể gửi file', 'error');
      return;
    }

    for (const f of Array.from(files)) {
      const filePath = (f as any).path as string | undefined;
      if (!filePath) {
        showToast('Không lấy được đường dẫn file', 'error');
        continue;
      }
      await handleSendFileOrFolder(filePath, 'desktop');
    }
    showToast('Đang gửi tới Desktop của khách...', 'info');
  });
}

/**
 * Host-side: toggle whether the connected viewer is allowed to send input.
 * The actual gate lives in ConnectionManager.controlLocked; this just
 * mirrors the state for the panel UI and pushes the change to the viewer.
 */
function toggleHostControlLock(): void {
  hostControlLocked = !hostControlLocked;
  const ok = window.connectionManager?.setControlLocked(hostControlLocked);
  if (ok === false) {
    // Roll back if the data channel wasn't ready — better to show the user
    // the unchanged state than a misleading "locked" badge with no effect.
    hostControlLocked = !hostControlLocked;
    showToast('Chưa kết nối — chưa thể đổi trạng thái khóa', 'info');
    return;
  }
  refreshHostLockUI();
  showToast(
    hostControlLocked
      ? 'Đã khóa quyền điều khiển — khách chỉ xem được'
      : 'Đã mở khóa quyền điều khiển',
    'info',
  );
}

/**
 * Update the host-panel lock button to reflect the current locked state.
 * Adds a "locked" class so the icon can show a filled padlock + accent color.
 */
function refreshHostLockUI(): void {
  const btn = document.getElementById('host-panel-lock');
  if (!btn) return;
  btn.classList.toggle('host-panel-iconbtn-locked', hostControlLocked);
  btn.title = hostControlLocked
    ? 'Mở khóa điều khiển (khách đang chỉ xem)'
    : 'Khóa quyền điều khiển của khách';
}

/**
 * Called from ConnectionManager when the viewer flips its Control/View
 * switch. Updates the per-viewer badge in the host panel.
 */
export function updateHostViewerMode(viewerId: string, mode: 'control' | 'view'): void {
  const entry = hostViewers.get(viewerId);
  if (!entry) return;
  entry.mode = mode;
  renderHostViewers();
}

/**
 * Render the host's monitor list inside the View menu so the viewer can
 * pick which display to share. Called by ConnectionManager whenever the
 * host pushes a 'monitor-list' system message.
 *
 * Hides the section entirely when the host has only one monitor — picking
 * "the one screen" is meaningless and just clutters the menu.
 */
export function updateMonitorMenu(
  monitors: Array<{ id: string; name: string; isPrimary: boolean }>,
  activeSourceId: string | null,
): void {
  const container = document.getElementById('menu-view-monitors');
  if (!container) return;
  const sectionLabel = container.previousElementSibling as HTMLElement | null;
  const dividerAfter = container.nextElementSibling as HTMLElement | null;

  // Single-monitor host — no point showing a picker. Hide the whole section
  // including the section label above it and the divider below.
  if (monitors.length <= 1) {
    container.classList.add('hidden');
    if (sectionLabel?.classList.contains('dropdown-section-label')) {
      sectionLabel.classList.add('hidden');
    }
    if (dividerAfter?.classList.contains('dropdown-divider')) {
      dividerAfter.classList.add('hidden');
    }
    return;
  }

  container.classList.remove('hidden');
  sectionLabel?.classList.remove('hidden');
  dividerAfter?.classList.remove('hidden');

  container.innerHTML = monitors
    .map((m, idx) => {
      const isActive = activeSourceId
        ? m.id === activeSourceId
        : m.isPrimary;
      const label = m.isPrimary
        ? `${m.name || `Màn hình ${idx + 1}`} (chính)`
        : m.name || `Màn hình ${idx + 1}`;
      const check = isActive
        ? '<span class="dropdown-item-check">✓</span>'
        : '<span class="dropdown-item-check hidden">✓</span>';
      return `
        <button class="dropdown-item dropdown-item-toggle" data-monitor="${escapeHtml(m.id)}">
          <span class="dropdown-item-label">${escapeHtml(label)}</span>
          ${check}
        </button>`;
    })
    .join('');
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
    <div class="file-item-actions" data-actions></div>
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
        <div class="host-panel-file-actions" data-actions></div>
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
 * @param savedPath absolute path on disk once status === 'complete' (receiver-side).
 *                  Used to render an "Open folder" / "Show in Explorer" button.
 */
export function updateFileProgress(
  fileId: string,
  percent: number,
  status: 'sending' | 'receiving' | 'complete' | 'error',
  savedPath?: string,
  speed?: string,
  eta?: string,
): void {
  const labelMap: Record<string, string> = {
    sending: 'Đang gửi',
    receiving: 'Đang nhận',
    complete: isHostMode ? 'File Received' : 'Hoàn thành',
    error: 'Lỗi',
  };

  const getDetailText = (): string => {
    let text = labelMap[status] || status;
    if ((status === 'sending' || status === 'receiving') && (speed || eta)) {
      const parts: string[] = [];
      if (speed) parts.push(speed);
      if (eta) parts.push(eta);
      if (parts.length > 0) {
        text = `${text} (${parts.join(', ')})`;
      }
    }
    return text;
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
      sizeEl.textContent = `${sizePrefix} — ${getDetailText()}`;
    }
    if (status === 'complete' && savedPath) {
      renderFileRowActions(row.querySelector('[data-actions]') as HTMLElement | null, savedPath);
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
    sizeEl.textContent = `${sizePrefix} — ${getDetailText()}`;
  }
  if (status === 'complete' && savedPath) {
    renderFileRowActions(row.querySelector('[data-actions]') as HTMLElement | null, savedPath);
  }
}

/**
 * Inject "Mở thư mục" + "Mở file" buttons next to a completed receive entry.
 * Both shell out to the main-process `file:showInFolder` IPC, which opens
 * Explorer / Finder with the file pre-selected.
 */
function renderFileRowActions(container: HTMLElement | null, savedPath: string): void {
  if (!container) return;
  // Idempotent — re-rendering on a row that already has buttons is a no-op.
  if (container.querySelector('[data-action="open-folder"]')) return;
  container.innerHTML = `
    <button class="file-action-btn" data-action="open-file" title="Mở file bằng ứng dụng mặc định">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span>Mở file</span>
    </button>
    <button class="file-action-btn" data-action="open-folder" title="Mở thư mục chứa file">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
      </svg>
      <span>Mở thư mục</span>
    </button>
  `;
  container.querySelector('[data-action="open-file"]')?.addEventListener('click', async () => {
    const result = await window.titanAPI?.file?.openFile?.(savedPath);
    if (result && !result.success) {
      showToast(result.error || 'Không thể mở file', 'error');
    }
  });
  container.querySelector('[data-action="open-folder"]')?.addEventListener('click', () => {
    window.titanAPI?.file?.showInFolder?.(savedPath);
  });
}

/**
 * Show / update the reconnecting overlay on the session page. Called by
 * ConnectionManager when the viewer peer drops and we begin auto-retry.
 *
 * @param partnerId   the host id to display in the toolbar
 * @param attempt     1-based attempt index (0 = before first retry fires)
 * @param max         total attempts the manager will try
 * @param hostReboot  true if a destructive action is in flight (signout/restart/shutdown)
 */
export function showReconnectingState(
  partnerId: string,
  attempt: number,
  max: number,
  hostReboot: boolean,
): void {
  const overlay = document.getElementById('video-overlay');
  const text = document.getElementById('session-status-text');
  const partnerName = document.getElementById('toolbar-partner-name');

  if (overlay) overlay.classList.remove('hidden');
  if (text) {
    if (attempt <= 0) {
      text.textContent = hostReboot
        ? 'Đang chờ máy đối tác khởi động lại...'
        : 'Mất kết nối — đang thử kết nối lại...';
    } else {
      text.textContent = `Đang kết nối lại... (${attempt}/${max})`;
    }
  }
  if (partnerName && partnerId && partnerId.length >= 9) {
    const fmtId = `${partnerId.substring(0, 3)} ${partnerId.substring(3, 6)} ${partnerId.substring(6, 9)}`;
    partnerName.textContent = `Đang kết nối lại đến ${fmtId}...`;
  }
}

/**
 * Hide the reconnecting overlay (restored either on success or give-up).
 */
export function hideReconnectingState(): void {
  const overlay = document.getElementById('video-overlay');
  const text = document.getElementById('session-status-text');
  if (overlay) overlay.classList.add('hidden');
  if (text) text.textContent = 'Đang kết nối...';
}

/**
 * Handle disconnect
 */
function handleDisconnect() {
  // If a recording is still running, flush + save it before tearing down
  // the stream — otherwise MediaRecorder loses the tail of the session.
  if (recorder?.isRecording) {
    recorder.stop().catch(() => {});
  }

  // Tear down annotation overlay so a stale canvas doesn't sit on top of
  // the next session's video.
  if (annotationCtl) {
    annotationCtl.detach();
    annotationCtl = null;
  }

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
