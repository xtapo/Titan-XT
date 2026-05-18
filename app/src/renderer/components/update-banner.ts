/**
 * Update banner component — shows at the top of the home page when a new
 * version is available. User can download → install, or dismiss.
 */

let banner: HTMLDivElement | null = null;
let currentState: 'available' | 'downloading' | 'downloaded' | null = null;
let availableVersion: string | null = null;

export function initUpdateBanner(): void {
  window.titanAPI?.updater?.onStatus?.((status: any) => {
    handleUpdateStatus(status);
  });
}

function handleUpdateStatus(status: any): void {
  const { state } = status;

  if (state === 'checking' || state === 'up-to-date') {
    hideBanner();
    return;
  }

  if (state === 'available') {
    availableVersion = status.version;
    currentState = 'available';
    showBanner(
      `Phiên bản mới ${status.version} đã sẵn sàng`,
      'Tải về',
      () => downloadUpdate()
    );
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
    showBanner(
      `Lỗi cập nhật: ${status.message || 'Không xác định'}`,
      'Đóng',
      () => hideBanner()
    );
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
