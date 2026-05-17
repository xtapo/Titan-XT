import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, clipboard } from 'electron';
import path from 'path';
import os from 'os';
import { APP_NAME } from '../shared/constants';
import { setupIdentity } from './identity';
import { setupStore } from './store';
import { setupInputSimulator } from './input-simulator';
import { setupScreenCapture } from './screen-capture';
import { setupFileTransfer } from './file-transfer';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

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
      webSecurity: false, // Allow screen capture
    },
    show: false,
  });

  // Load renderer
  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    const indexPath = path.join(__dirname, '../renderer/index.html');
    console.log('[Main] Loading renderer from:', indexPath);
    mainWindow.loadFile(indexPath).catch((err) => {
      console.error('[Main] Failed to load renderer:', err);
    });
  }

  // Open DevTools in production for debugging (remove after fixing)
  if (process.env.TITAN_DEBUG === '1' || app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Show when ready
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

  // Log renderer crashes / load failures
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

  // Track maximize state
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximizeChanged', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximizeChanged', false);
  });
}

// === System Tray ===
function createTray(): void {
  // Create a simple 16x16 icon programmatically if no icon file
  let icon: Electron.NativeImage;
  const iconPath = path.join(__dirname, '../../resources/icon.png');

  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error('Empty icon');
    icon = icon.resize({ width: 16, height: 16 });
  } catch {
    // Create a minimal icon if file doesn't exist
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
  // Window controls (custom titlebar)
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

  // Clipboard
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('clipboard:write', (_event, text: string) => clipboard.writeText(text));

  // App info
  ipcMain.handle('app:getInfo', () => ({
    name: APP_NAME,
    version: app.getVersion() || '1.0.0',
    platform: process.platform,
    hostname: os.hostname(),
  }));
}

// === App Lifecycle ===
app.whenReady().then(() => {
  // Setup all modules
  setupStore();
  setupIdentity();
  setupIPC();
  setupInputSimulator();
  setupScreenCapture();
  setupFileTransfer();

  // Create window and tray
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

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
