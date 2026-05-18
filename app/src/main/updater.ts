import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';

// electron-updater talks to GitHub Releases via the `publish` block in
// package.json (provider: github, owner: xtapo, repo: Titan-XT). It looks
// up `latest.yml` (auto-emitted by electron-builder when targeting nsis)
// against the running app version and downloads the matching installer.

let mainWindowGetter: (() => BrowserWindow | null) | null = null;
let downloadingUpdate = false;
let updateDownloaded = false;

function send(channel: string, payload?: unknown): void {
  const win = mainWindowGetter?.();
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
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
    send('updater:status', {
      state: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      releaseDate: info.releaseDate,
    });
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    send('updater:status', { state: 'up-to-date', version: info.version });
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
 * Optional fallback used by the tray "Kiểm tra cập nhật" entry — shows a
 * native dialog when no main window is available to render UI.
 */
export async function checkForUpdatesWithDialog(): Promise<void> {
  if (!app.isPackaged) {
    dialog.showMessageBox({
      type: 'info',
      message: 'Auto-update chỉ hoạt động trong bản đã đóng gói.',
    });
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result) {
      dialog.showMessageBox({ type: 'info', message: 'Không thể kiểm tra cập nhật.' });
    }
  } catch (err) {
    dialog.showErrorBox('Cập nhật', (err as Error).message);
  }
}
