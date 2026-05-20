import Store from 'electron-store';
import { AppSettings, ConnectionHistory, AddressBookEntry } from '../shared/types';
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
  downloadFolder: '',
  askBeforeSave: false,
  unattendedEnabled: false,
  unattendedPasswordHash: '',
  unattendedPasswordSalt: '',
  unattendedAutoStart: false,
  auditEnabled: true,
  clipboardSyncEnabled: false,
  clipboardSyncImages: false,
  hostAudioEnabled: false,
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
        addressBook: [],
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

  // === Address Book ("Máy của tôi") ===
  // Stored locally only. Passwords (when saved) never leave this machine.
  ipcMain.handle('addressBook:get', () => {
    return s.get('addressBook', []) as AddressBookEntry[];
  });

  ipcMain.handle('addressBook:add', (_event: any, entry: AddressBookEntry) => {
    const list = s.get('addressBook', []) as AddressBookEntry[];
    const existing = list.findIndex((e) => e.id === entry.id);
    const normalized: AddressBookEntry = {
      ...entry,
      machineId: (entry.machineId || '').replace(/\D/g, ''),
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      createdAt: entry.createdAt || Date.now(),
    };
    if (existing >= 0) {
      list[existing] = { ...list[existing], ...normalized };
    } else {
      list.unshift(normalized);
    }
    s.set('addressBook', list);
    return list;
  });

  ipcMain.handle('addressBook:update', (_event: any, id: string, patch: Partial<AddressBookEntry>) => {
    const list = s.get('addressBook', []) as AddressBookEntry[];
    const i = list.findIndex((e) => e.id === id);
    if (i < 0) return list;
    list[i] = { ...list[i], ...patch, id: list[i].id };
    s.set('addressBook', list);
    return list;
  });

  ipcMain.handle('addressBook:remove', (_event: any, id: string) => {
    const list = s.get('addressBook', []) as AddressBookEntry[];
    const next = list.filter((e) => e.id !== id);
    s.set('addressBook', next);
    return next;
  });

  ipcMain.handle('addressBook:touch', (_event: any, id: string) => {
    const list = s.get('addressBook', []) as AddressBookEntry[];
    const i = list.findIndex((e) => e.id === id);
    if (i < 0) return list;
    list[i] = { ...list[i], lastConnectedAt: Date.now() };
    s.set('addressBook', list);
    return list;
  });
}
