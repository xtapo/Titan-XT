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
    verifyPassword: (passwordHash: string, nonce: string, viewerId?: string) =>
      ipcRenderer.invoke('identity:verifyPassword', passwordHash, nonce, viewerId),
    setUnattendedPassword: (plain: string) =>
      ipcRenderer.invoke('identity:setUnattendedPassword', plain) as Promise<{ success: boolean; error?: string }>,
    clearUnattendedPassword: () =>
      ipcRenderer.invoke('identity:clearUnattendedPassword') as Promise<{ success: boolean }>,
    getUnattendedStatus: () =>
      ipcRenderer.invoke('identity:getUnattendedStatus') as Promise<{ enabled: boolean; autoStart: boolean }>,
  },

  // === Auto-launch (Windows Run / macOS Login Items / Linux autostart) ===
  autoLaunch: {
    set: (enabled: boolean) =>
      ipcRenderer.invoke('autolaunch:set', enabled) as Promise<{ success: boolean; error?: string }>,
    get: () =>
      ipcRenderer.invoke('autolaunch:get') as Promise<{ enabled: boolean; hidden: boolean }>,
  },

  // === Screen ===
  screen: {
    getSources: () => ipcRenderer.invoke('screen:getSources'),
    getMonitorInfo: (monitorId: string) => ipcRenderer.invoke('screen:getMonitorInfo', monitorId),
    getPrimaryDisplay: () => ipcRenderer.invoke('screen:getPrimaryDisplay'),
    selectSource: (sourceId: string | null) => ipcRenderer.invoke('screen:selectSource', sourceId),
    getSelectedSource: () => ipcRenderer.invoke('screen:getSelectedSource') as Promise<string | null>,
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
    saveFile: (fileName: string, base64Data: string, targetHint?: 'desktop') =>
      ipcRenderer.invoke('file:saveFile', fileName, base64Data, targetHint),
    showInFolder: (filePath: string) => ipcRenderer.invoke('file:showInFolder', filePath),
  },

  // === Dialog ===
  dialog: {
    selectFolder: () => ipcRenderer.invoke('dialog:selectFolder') as Promise<string | null>,
  },

  // === Session Recording ===
  recording: {
    start: (opts: { partnerId?: string; extension?: string; mimeType?: string }) =>
      ipcRenderer.invoke('recording:start', opts) as Promise<{ id: string; path: string }>,
    appendChunk: (opts: { id: string; data: string }) =>
      ipcRenderer.invoke('recording:appendChunk', opts) as Promise<{ success: boolean; error?: string }>,
    stop: (opts: { id: string; discard?: boolean }) =>
      ipcRenderer.invoke('recording:stop', opts) as Promise<{ success: boolean; path?: string | null; error?: string }>,
    openFolder: () =>
      ipcRenderer.invoke('recording:openFolder') as Promise<{ success: boolean; path?: string; error?: string }>,
  },

  // === History ===
  history: {
    get: () => ipcRenderer.invoke('history:get'),
    add: (entry: any) => ipcRenderer.invoke('history:add', entry),
    clear: () => ipcRenderer.invoke('history:clear'),
  },

  // === Address Book ("Máy của tôi") ===
  addressBook: {
    get: () => ipcRenderer.invoke('addressBook:get'),
    add: (entry: any) => ipcRenderer.invoke('addressBook:add', entry),
    update: (id: string, patch: any) => ipcRenderer.invoke('addressBook:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('addressBook:remove', id),
    touch: (id: string) => ipcRenderer.invoke('addressBook:touch', id),
  },

  // === Settings ===
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (settings: any) => ipcRenderer.invoke('settings:update', settings),
  },

  // === Wallpaper (host-side perf optimization) ===
  wallpaper: {
    hide: () => ipcRenderer.invoke('wallpaper:hide') as Promise<{ success: boolean; error?: string }>,
    restore: () => ipcRenderer.invoke('wallpaper:restore') as Promise<{ success: boolean; error?: string }>,
  },

  // === Annotation (host-side overlay) ===
  // Renderer (host role) hands incoming viewer strokes to main, which paints
  // them on a transparent click-through window covering the shared monitor.
  annotation: {
    relay: (msg: any) => ipcRenderer.invoke('annotation:relay', msg),
    setSource: (sourceId: string | null) => ipcRenderer.invoke('annotation:setSource', sourceId),
    close: () => ipcRenderer.invoke('annotation:close'),
  },

  // === Audit Log ===
  // Local-only append-only event journal. Surfaced in the Settings page so
  // the machine owner can see what happened during remote-support sessions.
  audit: {
    isEnabled: () => ipcRenderer.invoke('audit:isEnabled') as Promise<boolean>,
    append: (event: any) => ipcRenderer.invoke('audit:append', event) as Promise<{ success: boolean; disabled?: boolean }>,
    read: (limit?: number) => ipcRenderer.invoke('audit:read', limit) as Promise<any[]>,
    clear: () => ipcRenderer.invoke('audit:clear') as Promise<{ success: boolean }>,
    export: () => ipcRenderer.invoke('audit:export') as Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>,
    openFolder: () => ipcRenderer.invoke('audit:openFolder') as Promise<{ success: boolean; path?: string; error?: string }>,
  },

  // === App Info ===
  app: {
    getInfo: () => ipcRenderer.invoke('app:getInfo'),
  },

  // === Auto Update ===
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    onStatus: (cb: (status: any) => void) => {
      ipcRenderer.on('updater:status', (_e, status) => cb(status));
    },
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
      'app:before-hide',
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

/**
 * Bridge consumed by the host-side annotation overlay window
 * (resources/annotation-overlay.html). The overlay registers a stroke handler
 * with `window.titanOverlay.onStroke(cb)` and we pipe every IPC `annotation:stroke`
 * message into that callback. Lives on a separate global so the main app's
 * titanAPI surface stays untouched in the overlay.
 */
contextBridge.exposeInMainWorld('titanOverlay', {
  onStroke: (cb: (msg: any) => void) => {
    ipcRenderer.on('annotation:stroke', (_e, msg) => cb(msg));
  },
});
