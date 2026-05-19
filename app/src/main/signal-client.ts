import { ipcMain, BrowserWindow } from 'electron';
import { io, Socket } from 'socket.io-client';
import { HEARTBEAT_INTERVAL } from '../shared/constants';

/**
 * Signal-client owner — runs in the main process so the socket.io connection
 * stays alive even when the renderer window is destroyed (idle in tray).
 *
 * The renderer talks to the server through this module via IPC:
 *   renderer → main:  ipcRenderer.invoke('signal:emit', event, payload)
 *   main → renderer:  webContents.send('signal:event', { event, args })
 *
 * When no window exists, server-side events are buffered. An incoming
 * `connect-request` causes the agent layer to spawn the main window, which
 * then drains the buffer once `signal:ready` lands.
 */

type ServerEvent =
  | 'connect'
  | 'disconnect'
  | 'registered'
  | 'connect-request'
  | 'password-verify'
  | 'signal'
  | 'session-ended'
  | 'connect-challenge'
  | 'connect-accepted'
  | 'connect-rejected'
  | 'connect-error';

const FORWARDED_EVENTS: ServerEvent[] = [
  'connect',
  'disconnect',
  'registered',
  'connect-request',
  'password-verify',
  'signal',
  'session-ended',
  'connect-challenge',
  'connect-accepted',
  'connect-rejected',
  'connect-error',
];

let socket: Socket | null = null;
let serverUrl = '';
let machineId = '';
let machineName = '';
let heartbeatTimer: NodeJS.Timeout | null = null;
let onIncoming: ((data: any) => void) | null = null;
let getWindow: (() => BrowserWindow | null) | null = null;

// Buffer events that arrive while no renderer is alive. Drained when the
// renderer signals it's ready to receive (signal:ready). Capped so a flood of
// events while the window is gone can't grow without bound.
const BUFFER_LIMIT = 50;
let pendingEvents: Array<{ event: ServerEvent; args: any[] }> = [];
let rendererReady = false;

function forwardToRenderer(event: ServerEvent, ...args: any[]): void {
  const win = getWindow?.();
  if (rendererReady && win && !win.isDestroyed()) {
    try {
      win.webContents.send('signal:event', { event, args });
      return;
    } catch (err) {
      console.warn('[Signal] forward failed:', err);
    }
  }
  pendingEvents.push({ event, args });
  if (pendingEvents.length > BUFFER_LIMIT) pendingEvents.shift();
}

function drainPending(): void {
  const win = getWindow?.();
  if (!win || win.isDestroyed()) return;
  const queued = pendingEvents.splice(0);
  for (const { event, args } of queued) {
    try {
      win.webContents.send('signal:event', { event, args });
    } catch (err) {
      console.warn('[Signal] drain forward failed:', err);
    }
  }
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    socket?.emit('ping');
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export interface SignalClientOptions {
  /** Lazy accessor for the main window — may return null when the window is destroyed. */
  getMainWindow: () => BrowserWindow | null;
  /**
   * Called when an incoming connect-request arrives from the signal server
   * and there's no live renderer to handle it. Agent uses this to spawn the
   * main window so the host UI can prompt for accept/reject.
   */
  onIncomingConnect?: (data: any) => void;
}

export function setupSignalClient(opts: SignalClientOptions): void {
  getWindow = opts.getMainWindow;
  onIncoming = opts.onIncomingConnect ?? null;

  // Renderer asks main to emit on the underlying socket.
  ipcMain.handle('signal:emit', (_event, name: string, ...args: any[]) => {
    if (!socket || !socket.connected) return { ok: false, reason: 'not-connected' };
    try {
      socket.emit(name, ...args);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, reason: err?.message || String(err) };
    }
  });

  ipcMain.handle('signal:isConnected', () => !!socket?.connected);

  // Renderer signals it's ready to receive forwarded events. Drains any
  // buffered events that piled up while the window was destroyed.
  ipcMain.handle('signal:ready', () => {
    rendererReady = true;
    drainPending();
    return { ok: true, connected: !!socket?.connected };
  });

  // Renderer being torn down (close / refresh). Stop forwarding so events
  // re-buffer until the next renderer announces signal:ready.
  ipcMain.handle('signal:detach', () => {
    rendererReady = false;
    return { ok: true };
  });
}

/**
 * Open the socket connection. Idempotent — calling again with the same
 * machineId is a no-op. Called once from agent.ts after identity is loaded.
 */
export function startSignalClient(opts: {
  serverUrl: string;
  machineId: string;
  machineName: string;
}): void {
  if (socket && machineId === opts.machineId) return;
  // Different identity → tear down and reconnect.
  if (socket) {
    try { socket.disconnect(); } catch { /* ignore */ }
    socket = null;
  }

  serverUrl = opts.serverUrl;
  machineId = opts.machineId;
  machineName = opts.machineName;

  socket = io(serverUrl, {
    transports: ['websocket', 'polling'],
    timeout: 10_000,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 3_000,
  });

  socket.on('connect', () => {
    console.log('[Signal] Connected to signal server');
    socket?.emit('register', { machineId, machineName });
    startHeartbeat();
    forwardToRenderer('connect');
  });

  socket.on('registered', () => {
    forwardToRenderer('registered');
  });

  socket.on('disconnect', () => {
    console.log('[Signal] Disconnected from signal server');
    stopHeartbeat();
    forwardToRenderer('disconnect');
  });

  socket.on('connect_error', (err) => {
    console.warn('[Signal] connect_error:', err?.message);
  });

  // === Server-side session events — forwarded to renderer if alive,
  // otherwise buffered. `connect-request` additionally triggers the
  // window-spawn callback so the host UI is up by the time the
  // password-verify follow-up lands. ===

  socket.on('connect-request', (data: any) => {
    console.log('[Signal] Incoming connect-request from', data?.fromId);
    try { onIncoming?.(data); } catch (err) { console.warn('[Signal] onIncoming threw:', err); }
    forwardToRenderer('connect-request', data);
  });

  for (const ev of FORWARDED_EVENTS) {
    if (ev === 'connect' || ev === 'disconnect' || ev === 'registered' || ev === 'connect-request') {
      continue;
    }
    socket.on(ev, (...args: any[]) => {
      forwardToRenderer(ev, ...args);
    });
  }
}

export function stopSignalClient(): void {
  stopHeartbeat();
  rendererReady = false;
  pendingEvents = [];
  if (socket) {
    try { socket.disconnect(); } catch { /* ignore */ }
    socket = null;
  }
}

export function isSignalConnected(): boolean {
  return !!socket?.connected;
}
