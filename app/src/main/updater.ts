import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';

// electron-updater talks to GitHub Releases via the `publish` block in
// package.json (provider: github, owner: xtapo, repo: Titan-XT). It looks
// up `latest.yml` (auto-emitted by electron-builder when targeting nsis)
// against the running app version and downloads the matching installer.

let mainWindowGetter: (() => BrowserWindow | null) | null = null;
let downloadingUpdate = false;
let updateDownloaded = false;
// Tracks whether the in-flight check was triggered by the user via the tray
// menu / IPC (vs the silent post-launch check). Manual checks need explicit
// feedback when the result is "up-to-date" — otherwise the user sees nothing.
let manualCheckPending = false;

function send(channel: string, payload?: unknown): void {
  const win = mainWindowGetter?.();
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

function showAndFocusWindow(): void {
  const win = mainWindowGetter?.();
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

export function setupUpdater(getMainWindow: () => BrowserWindow | null): void {
  mainWindowGetter = getMainWindow;

  // Auto-download is on by default in electron-updater. We turn it off so the
  // user keeps control: app checks → notifies → user clicks "Tải về" → app
  // downloads → on quit, the installer runs.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    send('updater:status', { state: 'checking' });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    // Available result handles itself via the banner — clear the manual flag
    // so we don't also pop a redundant dialog.
    manualCheckPending = false;
    showAndFocusWindow();
    send('updater:status', {
      state: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      releaseDate: info.releaseDate,
    });
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    send('updater:status', { state: 'up-to-date', version: info.version });
    if (manualCheckPending) {
      manualCheckPending = false;
      dialog.showMessageBox({
        type: 'info',
        title: 'Cập nhật',
        message: 'Bạn đang dùng phiên bản mới nhất.',
        detail: `Phiên bản hiện tại: ${app.getVersion()}`,
      });
    }
  });

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    send('updater:status', {
      state: 'downloading',
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    downloadingUpdate = false;
    updateDownloaded = true;
    send('updater:status', { state: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (err: Error) => {
    downloadingUpdate = false;
    console.warn('[Updater] error:', err.message);
    send('updater:status', { state: 'error', message: err.message });
    if (manualCheckPending) {
      manualCheckPending = false;
      dialog.showErrorBox('Cập nhật', err.message || 'Lỗi không xác định khi kiểm tra cập nhật.');
    }
  });

  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) {
      return { ok: false, reason: 'dev-mode' };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      return { ok: true, version: result?.updateInfo?.version };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  });

  ipcMain.handle('updater:download', async () => {
    if (downloadingUpdate || updateDownloaded) {
      return { ok: true, alreadyHandled: true };
    }
    try {
      downloadingUpdate = true;
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      downloadingUpdate = false;
      return { ok: false, reason: (err as Error).message };
    }
  });

  ipcMain.handle('updater:install', () => {
    if (!updateDownloaded) {
      return { ok: false, reason: 'not-downloaded' };
    }
    // isSilent=false shows the NSIS installer UI (per-machine install needs
    // UAC anyway). isForceRunAfter=true relaunches the app post-update.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true };
  });

  // Kick off the first check shortly after launch — give the renderer time
  // to mount its listeners so the first event isn't dropped.
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.warn('[Updater] initial check failed:', err.message);
      });
    }, 5000);
  }
}

/**
 * Tray "Kiểm tra cập nhật..." entry. Always shows feedback to the user — a
 * native dialog when there's nothing to install (since the banner only
 * surfaces actionable states).
 */
export async function checkForUpdatesWithDialog(): Promise<void> {
  if (!app.isPackaged) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Cập nhật',
      message: 'Auto-update chỉ hoạt động trong bản đã đóng gói.',
    });
    return;
  }
  manualCheckPending = true;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result) {
      manualCheckPending = false;
      dialog.showMessageBox({
        type: 'info',
        title: 'Cập nhật',
        message: 'Không thể kiểm tra cập nhật ngay bây giờ.',
      });
    }
  } catch (err) {
    manualCheckPending = false;
    dialog.showErrorBox('Cập nhật', (err as Error).message);
  }
}
