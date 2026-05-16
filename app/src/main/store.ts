import Store from 'electron-store';
import { AppSettings, ConnectionHistory } from '../shared/types';
import { DEFAULT_SIGNAL_SERVER, DEFAULT_FPS } from '../shared/constants';

let store: any = null;

const defaultSettings: AppSettings = {
  signalServer: DEFAULT_SIGNAL_SERVER,
  autoStart: false,
  minimizeToTray: true,
  quality: 'auto',
  fps: DEFAULT_FPS,
  hideWallpaper: false,
  requireManualApproval: false,
  allowedIPs: [],
};

/**
 * Get or create the persistent store
 */
export function getStore(): any {
  if (!store) {
    store = new (Store as any)({
      name: 'titan-xt-config',
      defaults: {
        machineId: '',
        password: '',
        settings: defaultSettings,
        history: [],
      },
    });
  }
  return store;
}

/**
 * Setup IPC handlers for settings and history
 */
export function setupStore(): void {
  const { ipcMain } = require('electron');
  const s = getStore();

  // Settings
  ipcMain.handle('settings:get', () => {
    return s.get('settings', defaultSettings);
  });

  ipcMain.handle('settings:update', (_event: any, newSettings: Partial<AppSettings>) => {
    const current = s.get('settings', defaultSettings) as AppSettings;
    const merged = { ...current, ...newSettings };
    s.set('settings', merged);
    return merged;
  });

  // Connection History
  ipcMain.handle('history:get', () => {
    return s.get('history', []);
  });

  ipcMain.handle('history:add', (_event: any, entry: ConnectionHistory) => {
    const history = s.get('history', []) as ConnectionHistory[];

    const existingIndex = history.findIndex(
      (h: ConnectionHistory) => h.machineId === entry.machineId
    );

    if (existingIndex >= 0) {
      history[existingIndex] = {
        ...history[existingIndex],
        ...entry,
        totalSessions: history[existingIndex].totalSessions + 1,
      };
    } else {
      history.unshift({ ...entry, totalSessions: 1 });
    }

    const trimmed = history.slice(0, 20);
    s.set('history', trimmed);
    return trimmed;
  });

  ipcMain.handle('history:clear', () => {
    s.set('history', []);
    return [];
  });
}
