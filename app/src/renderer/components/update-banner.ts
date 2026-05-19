/**
 * Update banner component — shows at the top of the home page when a new
 * version is available. User can download → install, or dismiss.
 */

import { showToast } from './toast';

let banner: HTMLDivElement | null = null;
let currentState: 'available' | 'downloading' | 'downloaded' | null = null;
let availableVersion: string | null = null;
// Tracks whether the user just clicked "Kiểm tra cập nhật" so we can show a
// toast when the result comes back as up-to-date / error.
let manualCheckPending = false;

export function initUpdateBanner(): void {
  window.titanAPI?.updater?.onStatus?.((status: any) => {
    handleUpdateStatus(status);
  });
}

/**
 * Trigger a user-initiated update check. Shows a toast with the result so
 * the user gets feedback regardless of whether an update is available.
 */
export async function checkForUpdates(): Promise<void> {
  if (manualCheckPending) return;
  manualCheckPending = true;
  showToast('Đang kiểm tra cập nhật...', 'info', 1500);
  const result = await window.titanAPI?.updater?.check?.();
  if (!result?.ok) {
    manualCheckPending = false;
    if (result?.reason === 'dev-mode') {
      showToast('Auto-update chỉ hoạt động trong bản đã đóng gói', 'info');
    } else {
      showToast(`Không thể kiểm tra: ${result?.reason || 'Lỗi không xác định'}`, 'error');
    }
  }
}

function handleUpdateStatus(status: any): void {
  const { state } = status;

  if (state === 'checking') {
    return;
  }

  if (state === 'up-to-date') {
    if (manualCheckPending) {
      manualCheckPending = false;
      showToast(`Đang dùng phiên bản mới nhất (${status.version})`, 'success');
    }
    hideBanner();
    return;
  }

  if (state === 'available') {
    manualCheckPending = false;
    availableVersion = status.version;
    currentState = 'available';
    // macOS unsigned builds can't auto-install — main process flags this
    // with manualInstall=true. Route the action straight to the browser.
    if (status.manualInstall) {
      showBanner(
        `Phiên bản mới ${status.version} — tải về thủ công`,
        'Mở trang tải',
        () => openDownloadPage(status.downloadUrl)
      );
    } else {
      showBanner(
        `Phiên bản mới ${status.version} đã sẵn sàng`,
        'Tải về',
        () => downloadUpdate()
      );
    }
  } else if (state === 'downloading') {
    currentState = 'downloading';
    const percent = status.percent || 0;
    showBanner(
      `Đang tải xuống... ${percent}%`,
      null,
      null
    );
  } else if (state === 'downloaded') {
    currentState = 'downloaded';
    showBanner(
      `Đã tải xong phiên bản ${status.version}`,
      'Cài đặt & Khởi động lại',
      () => installUpdate()
    );
  } else if (state === 'error') {
    currentState = null;
    if (manualCheckPending) {
      manualCheckPending = false;
      showToast(`Lỗi cập nhật: ${status.message || 'Không xác định'}`, 'error');
    } else {
      showBanner(
        `Lỗi cập nhật: ${status.message || 'Không xác định'}`,
        'Đóng',
        () => hideBanner()
      );
    }
  }
}

function showBanner(message: string, actionLabel: string | null, actionHandler: (() => void) | null): void {
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'update-banner';
    banner.innerHTML = `
      <div class="update-banner-content">
        <span class="update-banner-icon">⬆</span>
        <span class="update-banner-message"></span>
      </div>
      <div class="update-banner-actions">
        <button class="update-banner-action"></button>
        <button class="update-banner-dismiss">✕</button>
      </div>
    `;
    const container = document.getElementById('page-home');
    if (container) {
      container.insertBefore(banner, container.firstChild);
    }

    const dismissBtn = banner.querySelector('.update-banner-dismiss') as HTMLButtonElement;
    dismissBtn.addEventListener('click', () => hideBanner());
  }

  const msgEl = banner.querySelector('.update-banner-message') as HTMLSpanElement;
  const actionBtn = banner.querySelector('.update-banner-action') as HTMLButtonElement;

  msgEl.textContent = message;

  if (actionLabel && actionHandler) {
    actionBtn.textContent = actionLabel;
    actionBtn.style.display = '';
    actionBtn.onclick = actionHandler;
  } else {
    actionBtn.style.display = 'none';
  }

  banner.style.display = 'flex';
}

function hideBanner(): void {
  if (banner) {
    banner.style.display = 'none';
  }
  currentState = null;
}

async function downloadUpdate(): Promise<void> {
  const result = await window.titanAPI?.updater?.download?.();
  if (!result?.ok) {
    showBanner(`Không thể tải: ${result?.reason || 'Lỗi không xác định'}`, 'Đóng', () => hideBanner());
  }
}

async function installUpdate(): Promise<void> {
  await window.titanAPI?.updater?.install?.();
}

function openDownloadPage(url: string | undefined): void {
  const target = url || 'https://github.com/xtapo/Titan-XT/releases/latest';
  // Prefer the main-process opener (registered IPC) so the URL goes through
  // shell.openExternal. Fall back to window.open for safety.
  const opener = (window.titanAPI as any)?.openExternal;
  if (typeof opener === 'function') {
    opener(target);
  } else {
    window.open(target, '_blank', 'noopener,noreferrer');
  }
}
