import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, clipboard, shell } from 'electron';
import path from 'path';
import os from 'os';
import { APP_NAME } from '../shared/constants';
import { setupIdentity } from './identity';
import { setupStore } from './store';
import { setupInputSimulator } from './input-simulator';
import { setupScreenCapture, getSelectedSourceId } from './screen-capture';
import { setupFileTransfer } from './file-transfer';
import { setupSystemActions } from './system-actions';
import { setupRecording, closeAllRecordings } from './recording';
import { setupWallpaper, restoreOnStartup, restoreWallpaper } from './wallpaper';
import { setupUpdater, checkForUpdatesWithDialog } from './updater';
import { setupAnnotation, closeAnnotationOverlay } from './annotation';
import { setupAudit } from './audit';
import { setupLockScreenBridge } from './lock-screen-bridge';
import { getPipeClient } from './pipe-client';

// Chromium ships with H.265 / HEVC over WebRTC gated behind feature flags.
// Without these, RTCRtpSender.getCapabilities('video') doesn't list HEVC and
// our codec-preference toggle silently falls back to H.264. Must run before
// app.whenReady() — Chromium command-line flags are read at process startup.
//
// PlatformHEVCEncoderSupport / PlatformHEVCDecoderSupport route encode/decode
// through the OS-level hardware codec (Media Foundation on Windows, AVFoundation
// on macOS). Without these, Chromium ignores the GPU's HEVC encoder and either
// refuses HEVC entirely or falls back to a software encoder that can't keep up
// with 1080p screen share — defeating the bandwidth win.
//
// AV1: WebRtcAllowAv1{Send,Receive} + UseLibavif feature gate exposes
// AV1 as a negotiable WebRTC codec. AV1 is ~50% better than H.264 for screen
// content and the new royalty-free standard, but the software encoder is too
// slow for 1080p60 — we still expose it for hosts with hardware AV1 (Intel Arc,
// NVIDIA 40-series, AMD 7000-series, recent Apple silicon).
//
// VaapiVideoEncoder / VaapiVideoDecoder: route encode/decode through the
// platform's GPU video API (NVENC/QuickSync/AMF on Windows via D3D11VA,
// VideoToolbox on macOS, VA-API on Linux). Without these, Chromium falls back
// to libvpx/x264 software encoders even when the GPU has a perfectly good
// hardware encoder sitting idle.
app.commandLine.appendSwitch('enable-features', [
  'WebRtcAllowH265Send',
  'WebRtcAllowH265Receive',
  'PlatformHEVCEncoderSupport',
  'PlatformHEVCDecoderSupport',
  // AV1 over WebRTC. Send is gated by a separate flag from receive so we
  // enable both — the host encodes, the viewer decodes.
  'WebRtcAllowAv1',
  'WebRtcUseAv1Encoder',
  // GPU-backed encode/decode pipelines. Cuts CPU usage from ~40% (software
  // x264 1080p60) to <5% on a typical NVIDIA / Intel iGPU.
  'AcceleratedVideoEncoder',
  'AcceleratedVideoDecoder',
  'PlatformEncoderInWebRTC',
  'VaapiVideoEncoder',
  'VaapiVideoDecoder',
  'VaapiIgnoreDriverChecks',
  // Windows Graphics Capture (WGC) backend for screen capture — replaces
  // legacy GDI BitBlt with the same API OBS/Game Bar use. Delivers 60fps+
  // capture on Windows 10 2004+ instead of the 25-30fps GDI ceiling.
  'WebRtcAllowWgcScreenCapturer',
  // Zero-copy capture — keep the captured surface on the GPU all the way
  // through to the encoder so we don't pay a CPU readback per frame.
  'ZeroCopyVideoCapture',
].join(','));

// Hint Chromium about hardware-acceleration policy. These complement the
// feature flags above — without them Chromium can still fall back to software
// when its heuristics decide the GPU is "untrusted" (common on Windows with
// older drivers).
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-accelerated-mjpeg-decode');
// Force GPU rasterization so screen capture composites stay on the GPU.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let originalBounds: Electron.Rectangle | null = null;
let originalMinSize: { width: number, height: number } | null = null;

// Host-mode panel sizing (UltraViewer-style mini panel docked bottom-right)
const HOST_PANEL_WIDTH = 300;
const HOST_PANEL_HEIGHT = 420;
const HOST_PANEL_COLLAPSED_WIDTH = 28;
const HOST_PANEL_COLLAPSED_HEIGHT = 80;
const HOST_PANEL_MARGIN = 12;

let hostModeActive = false;
let hostCollapsed = false;

/**
 * Position + resize the host-mode mini panel docked to the bottom-right
 * corner of the primary display's work area.
 */
function applyHostBounds(collapsed: boolean): void {
  if (!mainWindow) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const width = collapsed ? HOST_PANEL_COLLAPSED_WIDTH : HOST_PANEL_WIDTH;
  const height = collapsed ? HOST_PANEL_COLLAPSED_HEIGHT : HOST_PANEL_HEIGHT;
  mainWindow.setBounds({
    x: workArea.x + workArea.width - width - HOST_PANEL_MARGIN,
    y: workArea.y + workArea.height - height - HOST_PANEL_MARGIN,
    width,
    height,
  });
}

// === Window Creation ===
function createMainWindow(startHidden: boolean = false): void {
  mainWindow = new BrowserWindow({
    width: 850,
    height: 650,
    minWidth: 750,
    minHeight: 550,
    title: APP_NAME,
    frame: false,
    transparent: false,
    backgroundColor: '#0a0a0f',
    icon: path.join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    const indexPath = path.join(__dirname, '../renderer/index.html');
    console.log('[Main] Loading renderer from:', indexPath);
    mainWindow.loadFile(indexPath).catch((err) => {
      console.error('[Main] Failed to load renderer:', err);
    });
  }

  if (process.env.TITAN_DEBUG === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.once('ready-to-show', () => {
    if (!startHidden) mainWindow?.show();
  });

  // Fallback: force show after 3s in case ready-to-show never fires —
  // skipped when launched hidden so unattended auto-start stays silent.
  setTimeout(() => {
    if (
      mainWindow &&
      !mainWindow.isDestroyed() &&
      !mainWindow.isVisible() &&
      !startHidden
    ) {
      console.warn('[Main] ready-to-show never fired — forcing show');
      mainWindow.show();
    }
  }, 3000);

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[Main] did-fail-load: ${code} ${desc} ${url}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[Main] render-process-gone:', details);
  });

  // Minimize to tray instead of close — but tear down any active remote
  // session first so the partner doesn't keep "Đang điều khiển" / chat panel
  // up against a window the user thinks they closed.
  mainWindow.on('close', (event) => {
    if (tray) {
      event.preventDefault();
      mainWindow?.webContents.send('app:before-hide');
      mainWindow?.hide();
    }
  });

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximizeChanged', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximizeChanged', false);
  });
}

// === System Tray ===
function createTray(): void {
  let icon: Electron.NativeImage;
  const iconPath = path.join(__dirname, '../../resources/icon.png');

  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error('Empty icon');
    icon = icon.resize({ width: 16, height: 16 });
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Mở Titan-XT',
      click: () => mainWindow?.show(),
    },
    {
      label: 'Kiểm tra cập nhật...',
      click: () => {
        checkForUpdatesWithDialog().catch((err) => {
          console.warn('[Tray] check for updates failed:', err);
        });
      },
    },
    { type: 'separator' },
    {
      label: 'Thoát',
      click: () => {
        tray?.destroy();
        tray = null;
        app.quit();
      },
    },
  ]);

  tray.setToolTip(APP_NAME);
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    mainWindow?.show();
  });
}

// === IPC Handlers ===
function setupIPC(): void {
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized());

  // === Unattended auto-launch ===
  // On Windows with requireAdministrator, setLoginItemSettings won't work —
  // UAC blocks auto-elevation at logon. We use a Scheduled Task with Logon
  // trigger + HighestAvailable instead. On macOS/Linux, fall back to the
  // built-in setLoginItemSettings.
  ipcMain.handle('autolaunch:set', async (_event, enabled: boolean) => {
    if (process.platform === 'win32') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { setAutoLaunchWindows } = require('./auto-launch-windows');
        return await setAutoLaunchWindows(enabled, process.execPath);
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) };
      }
    } else {
      // macOS / Linux: use Electron's built-in Login Items / autostart
      try {
        app.setLoginItemSettings({
          openAtLogin: !!enabled,
          openAsHidden: true,
          args: enabled ? ['--hidden'] : [],
        });
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) };
      }
    }
  });

  ipcMain.handle('autolaunch:get', async () => {
    if (process.platform === 'win32') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getAutoLaunchWindows } = require('./auto-launch-windows');
        return await getAutoLaunchWindows();
      } catch {
        return { enabled: false, hidden: false };
      }
    }
    try {
      const s = app.getLoginItemSettings();
      return { enabled: !!s.openAtLogin, hidden: !!s.openAsHidden };
    } catch {
      return { enabled: false, hidden: false };
    }
  });
  ipcMain.handle('window:setHostMode', (_event, enable: boolean) => {
    if (!mainWindow) return;
    if (enable) {
      if (!originalBounds) {
        originalBounds = mainWindow.getBounds();
        const minSize = mainWindow.getMinimumSize();
        originalMinSize = { width: minSize[0], height: minSize[1] };
      }
      hostModeActive = true;
      hostCollapsed = false;
      mainWindow.setResizable(false);
      mainWindow.setMinimumSize(HOST_PANEL_COLLAPSED_WIDTH, HOST_PANEL_COLLAPSED_HEIGHT);
      mainWindow.setAlwaysOnTop(true, 'floating');
      mainWindow.setSkipTaskbar(false);
      applyHostBounds(false);
    } else {
      hostModeActive = false;
      hostCollapsed = false;
      mainWindow.setAlwaysOnTop(false);
      mainWindow.setResizable(true);
      if (originalMinSize) {
        mainWindow.setMinimumSize(originalMinSize.width, originalMinSize.height);
      }
      if (originalBounds) {
        mainWindow.setBounds(originalBounds);
        originalBounds = null;
        originalMinSize = null;
      }
    }
  });

  ipcMain.handle('window:setHostCollapsed', (_event, collapsed: boolean) => {
    if (!mainWindow || !hostModeActive) return;
    hostCollapsed = !!collapsed;
    applyHostBounds(hostCollapsed);
  });

  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('clipboard:write', (_event, text: string) => clipboard.writeText(text));

  // Trusted opener for outbound URLs (release page, docs, etc.). Renderers
  // call window.titanAPI.openExternal(url) — we whitelist the scheme so a
  // compromised renderer can't shell out to file:// or javascript:.
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    if (typeof url !== 'string') return { ok: false, reason: 'bad-url' };
    if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'unsupported-scheme' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, reason: err?.message || String(err) };
    }
  });

  ipcMain.handle('app:getInfo', () => ({
    name: APP_NAME,
    version: app.getVersion() || '1.0.0',
    platform: process.platform,
    hostname: os.hostname(),
  }));
}

/**
 * Boot the Electron Agent UI. Called from the dispatcher in ./index when
 * the binary is launched without --service / --worker / --install flags.
 */
export function startAgent(): void {
  // Single instance lock — claim before whenReady so a duplicate launch
  // exits before bothering with window setup.
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    setupStore();
    setupIdentity();
    setupIPC();
    setupInputSimulator();
    setupScreenCapture();
    setupFileTransfer();
    setupSystemActions();
    setupRecording();
    setupWallpaper();
    setupUpdater(() => mainWindow);
    setupAnnotation(() => getSelectedSourceId());
    setupAudit();
    setupLockScreenBridge(() => mainWindow);
    // Best-effort: open the worker pipe early so desktop-change events
    // start flowing before the user even initiates a session. The pipe
    // connect is cheap and fails fast when the service isn't installed.
    if (process.platform === 'win32') {
      getPipeClient().connect().catch(() => {
        // Service likely not installed yet — bridge stays idle until the
        // first input event opens the pipe lazily.
      });
    }
    // If the previous run crashed mid-session, the user's wallpaper is still
    // blanked. Put it back before the window even shows up.
    restoreOnStartup().catch((err) => {
      console.warn('[Main] wallpaper startup recovery failed:', err);
    });

    // `--hidden` is added to argv when the auto-launch hook fires so the
    // unattended host comes up tray-only and doesn't blink a window in the
    // user's face at every login. Honor it from both argv and Electron's
    // own login-item bookkeeping (wasOpenedAsHidden is true on macOS when
    // launched via Login Items with the hidden flag).
    const launchedHidden =
      process.argv.includes('--hidden') ||
      app.getLoginItemSettings().wasOpenedAsHidden;

    createMainWindow(launchedHidden);
    createTray();

    console.log('');
    console.log('  ◆ TITAN-XT Desktop App');
    console.log(`  Machine: ${os.hostname()}`);
    console.log('  Ready.');
    console.log('');

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      if (!tray) {
        app.quit();
      }
    }
  });

  // Flush any in-flight recordings to disk before the process exits.
  app.on('before-quit', () => {
    closeAllRecordings().catch((err) => {
      console.warn('[Main] closeAllRecordings failed:', err);
    });
    // Best-effort: never leave the user without their wallpaper if they
    // quit mid-session. restoreWallpaper is a no-op when nothing was hidden.
    restoreWallpaper().catch((err) => {
      console.warn('[Main] wallpaper restore on quit failed:', err);
    });
    // Tear down the annotation overlay so it doesn't dangle as an orphan
    // transparent window on the desktop.
    closeAnnotationOverlay();
  });
}
