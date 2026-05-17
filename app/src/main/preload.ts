import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload script — securely exposes IPC methods to the renderer
 * via contextBridge. The renderer accesses these via window.titanAPI
 */
contextBridge.exposeInMainWorld('titanAPI', {
  // === Window Controls ===
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    setHostMode: (enable: boolean) => ipcRenderer.invoke('window:setHostMode', enable),
    setHostCollapsed: (collapsed: boolean) => ipcRenderer.invoke('window:setHostCollapsed', collapsed),
    onMaximizeChange: (cb: (maximized: boolean) => void) => {
      ipcRenderer.on('window:maximizeChanged', (_e, maximized) => cb(maximized));
    },
  },

  // === Identity ===
  identity: {
    get: () => ipcRenderer.invoke('identity:get'),
    regeneratePassword: () => ipcRenderer.invoke('identity:regeneratePassword'),
    verifyPassword: (passwordHash: string, nonce: string) =>
      ipcRenderer.invoke('identity:verifyPassword', passwordHash, nonce),
  },

  // === Screen ===
  screen: {
    getSources: () => ipcRenderer.invoke('screen:getSources'),
    getMonitorInfo: (monitorId: string) => ipcRenderer.invoke('screen:getMonitorInfo', monitorId),
    getPrimaryDisplay: () => ipcRenderer.invoke('screen:getPrimaryDisplay'),
  },

  // === Input Simulation ===
  input: {
    simulate: (event: any) => ipcRenderer.invoke('input:simulate', event),
  },

  // === System Actions (host-side execution) ===
  system: {
    execute: (action: string) => ipcRenderer.invoke('system:execute', action),
  },

  // === Clipboard ===
  clipboard: {
    read: () => ipcRenderer.invoke('clipboard:read') as Promise<string>,
    write: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  },

  // === File ===
  file: {
    selectFiles: () => ipcRenderer.invoke('file:selectFiles'),
    readChunk: (filePath: string, offset: number, chunkSize: number) =>
      ipcRenderer.invoke('file:readChunk', filePath, offset, chunkSize) as Promise<string | null>,
    saveFile: (fileName: string, base64Data: string) =>
      ipcRenderer.invoke('file:saveFile', fileName, base64Data),
    showInFolder: (filePath: string) => ipcRenderer.invoke('file:showInFolder', filePath),
  },

  // === Dialog ===
  dialog: {
    selectFolder: () => ipcRenderer.invoke('dialog:selectFolder') as Promise<string | null>,
  },

  // === History ===
  history: {
    get: () => ipcRenderer.invoke('history:get'),
    add: (entry: any) => ipcRenderer.invoke('history:add', entry),
    clear: () => ipcRenderer.invoke('history:clear'),
  },

  // === Settings ===
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (settings: any) => ipcRenderer.invoke('settings:update', settings),
  },

  // === App Info ===
  app: {
    getInfo: () => ipcRenderer.invoke('app:getInfo'),
  },

  // === Connection Events (Main → Renderer) ===
  on: (channel: string, callback: (...args: any[]) => void) => {
    const validChannels = [
      'connect:incoming',
      'connect:accepted',
      'connect:rejected',
      'connect:error',
      'session:ended',
      'signal:received',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },

  // === Connection Actions (Renderer → Main) ===
  send: (channel: string, ...args: any[]) => {
    const validChannels = [
      'connect:request',
      'connect:respond',
      'connect:disconnect',
      'signal:send',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, ...args);
    }
  },
});
