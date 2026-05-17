import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, clipboard } from 'electron';
import path from 'path';
import os from 'os';
import { APP_NAME } from '../shared/constants';
import { setupIdentity } from './identity';
import { setupStore } from './store';
import { setupInputSimulator } from './input-simulator';
import { setupScreenCapture } from './screen-capture';
import { setupFileTransfer } from './file-transfer';
import { setupSystemActions } from './system-actions';

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
function createMainWindow(): void {
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
    mainWindow?.show();
  });

  // Fallback: force show after 3s in case ready-to-show never fires
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
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

  // Minimize to tray instead of close
  mainWindow.on('close', (event) => {
    if (tray) {
      event.preventDefault();
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

    createMainWindow();
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
}
