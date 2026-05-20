/**
 * Pipe client used by the Agent (Electron main) to forward input + system
 * actions to the elevated Worker.
 *
 * Behavior:
 *   - Connects on demand to the per-session pipe.
 *   - Auto-reconnects with exponential backoff if the worker dies / restarts.
 *   - Provides `available()` so callers can choose to fall back to running
 *     locally when the service simply isn't installed.
 *
 * Important: requests are async. We multiplex by `id` over a single
 * connection so a fast burst of mouse-move events doesn't serialize.
 *
 * Plus a parallel video pipe client used to receive GDI captures from the
 * worker while the user has locked the workstation. Decoupled from this
 * class — see `VideoPipeClient` below — so a hot input path doesn't pay
 * for video parsing.
 */

import * as net from 'net';
import {
  pipePathForSession,
  videoPipePathForSession,
  FrameDecoder,
  encodeFrame,
  PipeRequest,
  PipeResponse,
  PipeEvent,
  isPipeEvent,
} from '../shared/pipe-protocol';
import { VideoFrameDecoder, VideoFrame } from '../shared/video-pipe-protocol';
import type { MouseMessage, KeyMessage, RemoteActionId } from '../shared/protocol';

interface Pending {
  resolve: (res: PipeResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 5_000;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 5_000;

export class PipeClient {
  private sessionId: number;
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private decoder = new FrameDecoder<PipeResponse | PipeEvent>();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private backoff = RECONNECT_BASE_MS;
  private closed = false;
  /** When false, callers should fall back to in-process execution. */
  private connectedOnce = false;
  private lastFailure: number = 0;
  /** Suppress reconnect attempts for this many ms after a hard failure. */
  private static FAILURE_QUIET_MS = 2_000;

  // Last desktop name reported by the worker via PipeEvent. Empty string
  // means "unknown / not yet reported". UI / capture switching consult this
  // to decide whether to use the GDI fallback.
  private lastDesktop: string = '';
  private desktopListeners = new Set<(name: string) => void>();

  constructor(sessionId: number) {
    this.sessionId = sessionId;
  }

  /** Best-effort check — true if a connection is currently usable. Does not
   *  trigger a fresh connect to avoid stalling caller paths. */
  available(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  /**
   * True if we have ever connected, OR if a connect attempt would not be
   * pointlessly slow right now. Callers use this to decide between waiting
   * for the pipe vs falling back to local execution.
   */
  worthTrying(): boolean {
    if (this.available()) return true;
    if (this.closed) return false;
    return Date.now() - this.lastFailure > PipeClient.FAILURE_QUIET_MS;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error('PipeClient closed');
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const pipePath = pipePathForSession(this.sessionId);
      const sock = net.createConnection(pipePath);

      const onError = (err: Error) => {
        sock.removeAllListeners();
        this.connecting = null;
        this.lastFailure = Date.now();
        reject(err);
      };

      sock.once('error', onError);
      sock.once('connect', () => {
        sock.removeListener('error', onError);
        this.attach(sock);
        this.connecting = null;
        this.connectedOnce = true;
        this.backoff = RECONNECT_BASE_MS;
        resolve();
      });
    });

    return this.connecting;
  }

  private attach(sock: net.Socket): void {
    this.socket = sock;
    sock.on('data', (chunk) => {
      const msgs = this.decoder.push(chunk);
      for (const msg of msgs) {
        if (isPipeEvent(msg)) {
          this.handleEvent(msg);
        } else {
          this.dispatch(msg as PipeResponse);
        }
      }
    });
    sock.on('error', (err) => {
      console.error('[PipeClient] socket error:', err.message);
    });
    sock.on('close', () => {
      this.socket = null;
      this.failAllPending(new Error('pipe closed'));
      // Don't auto-reconnect aggressively — wait for the next request.
    });
  }

  private handleEvent(ev: PipeEvent): void {
    if (ev.event === 'desktop') {
      const prev = this.lastDesktop;
      this.lastDesktop = ev.desktop;
      if (prev !== ev.desktop) {
        for (const fn of this.desktopListeners) {
          try { fn(ev.desktop); } catch (err) {
            console.warn('[PipeClient] desktop listener threw:', (err as Error).message);
          }
        }
      }
    }
  }

  /** Latest desktop name reported by the worker (e.g. "Default" / "Winlogon"). */
  desktopName(): string {
    return this.lastDesktop;
  }

  /** Subscribe to desktop-change events. Returns an unsubscribe function. */
  onDesktopChange(fn: (name: string) => void): () => void {
    this.desktopListeners.add(fn);
    return () => this.desktopListeners.delete(fn);
  }

  private dispatch(res: PipeResponse): void {
    const p = this.pending.get(res.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(res.id);
    p.resolve(res);
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private async send(req: PipeRequest): Promise<PipeResponse> {
    if (!this.socket || this.socket.destroyed) await this.connect();
    if (!this.socket) throw new Error('not connected');

    return new Promise<PipeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        reject(new Error('pipe request timeout'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(req.id, { resolve, reject, timer });
      try {
        this.socket!.write(encodeFrame(req));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(req.id);
        reject(err as Error);
      }
    });
  }

  private nextRequestId(): number {
    return this.nextId++;
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.send({ id: this.nextRequestId(), kind: 'ping' });
      return r.ok;
    } catch {
      return false;
    }
  }

  async simulateInput(payload: MouseMessage | KeyMessage): Promise<PipeResponse> {
    return this.send({ id: this.nextRequestId(), kind: 'input.simulate', payload });
  }

  async executeSystem(action: RemoteActionId): Promise<PipeResponse> {
    return this.send({ id: this.nextRequestId(), kind: 'system.execute', payload: { action } });
  }

  close(): void {
    this.closed = true;
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* ignore */ }
    }
    this.socket = null;
  }
}

let singleton: PipeClient | null = null;

/** Returns (and lazily creates) a process-wide pipe client for the active
 *  session. Caller is responsible for handling failures and falling back. */
export function getPipeClient(): PipeClient {
  if (!singleton) {
    // On Windows the agent runs in the user's session — process.env shows
    // SESSIONNAME. The session id comes via WTSGetActiveConsoleSessionId
    // from the service side; here we just trust that the worker spawned for
    // *our* session and use the session of our own process. Node doesn't
    // expose that directly, so we read it from %SESSIONNAME% indirectly via
    // the per-pipe naming convention: the worker uses the *same* session
    // we run in, so we can probe both common ids (1, 2) by attempting
    // connect on the canonical "active" name first.
    singleton = new PipeClient(getSelfSessionId());
  }
  return singleton;
}

/**
 * Best-effort lookup of the current process's session id on Windows.
 * Reads it via the ProcessIdToSessionId API through koffi.
 */
function getSelfSessionId(): number {
  if (process.platform !== 'win32') return 1;
  try {
    // Lazy require so non-Windows builds don't pay the koffi load cost.
    const koffi = require('koffi') as typeof import('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    const GetCurrentProcessId = kernel32.func('uint32 __stdcall GetCurrentProcessId()');
    const ProcessIdToSessionId = kernel32.func('int32 __stdcall ProcessIdToSessionId(uint32, _Out_ uint32*)');
    const out: any = [0];
    if (ProcessIdToSessionId(GetCurrentProcessId(), out)) {
      return out[0] as number;
    }
  } catch (err) {
    console.warn('[PipeClient] getSelfSessionId failed:', (err as Error).message);
  }
  return 1;
}

// === Video pipe client ====================================================
//
// Separate one-way client for the GDI capture stream coming out of the
// worker. We keep this disconnected unless the agent explicitly asks for
// it (`start()`) — hooking it up always-on would push BGRA frames over the
// pipe even when the user isn't locked, which is exactly the case
// Chromium's desktopCapturer already handles for free.

export interface VideoPipeFrame {
  width: number;
  height: number;
  /** Raw payload — for BGRA8 format this is `width*height*4` bytes. */
  payload: Buffer;
  /** Pixel format from `video-pipe-protocol.ts`. */
  format: number;
}

const VIDEO_RECONNECT_DELAY_MS = 1_000;

export class VideoPipeClient {
  private sessionId: number;
  private socket: net.Socket | null = null;
  private decoder = new VideoFrameDecoder();
  private listeners = new Set<(frame: VideoPipeFrame) => void>();
  private wantOpen = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(sessionId: number) {
    this.sessionId = sessionId;
  }

  onFrame(fn: (frame: VideoPipeFrame) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  isOpen(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  /** Open the pipe and start receiving frames. Idempotent. */
  start(): void {
    this.wantOpen = true;
    if (this.isOpen() || this.reconnectTimer) return;
    this.connect();
  }

  /** Stop receiving frames and close the pipe. */
  stop(): void {
    this.wantOpen = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* ignore */ }
      this.socket = null;
    }
    // Drop any partial frame buffer so a future start() begins clean.
    this.decoder = new VideoFrameDecoder();
  }

  private connect(): void {
    if (!this.wantOpen) return;
    const path = videoPipePathForSession(this.sessionId);
    const sock = net.createConnection(path);
    this.socket = sock;

    sock.on('connect', () => {
      // Connected — nothing to do, frames will start streaming.
    });

    sock.on('data', (chunk: Buffer) => {
      const frames = this.decoder.push(chunk);
      for (const f of frames) this.deliver(f);
    });

    sock.on('error', (err) => {
      // Common case: ENOENT before the worker has bound the pipe. Don't
      // log spam; just let `close` fire and the reconnect timer take over.
      if ((err as any).code !== 'ENOENT') {
        console.warn('[VideoPipe] socket error:', err.message);
      }
    });

    sock.on('close', () => {
      this.socket = null;
      if (!this.wantOpen) return;
      // Throttle reconnects so we don't busy-loop while the worker is dead.
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, VIDEO_RECONNECT_DELAY_MS);
    });
  }

  private deliver(frame: VideoFrame): void {
    const out: VideoPipeFrame = {
      width: frame.width,
      height: frame.height,
      payload: frame.payload,
      format: frame.format,
    };
    for (const fn of this.listeners) {
      try { fn(out); } catch (err) {
        console.warn('[VideoPipe] frame listener threw:', (err as Error).message);
      }
    }
  }
}

let videoSingleton: VideoPipeClient | null = null;

export function getVideoPipeClient(): VideoPipeClient {
  if (!videoSingleton) {
    videoSingleton = new VideoPipeClient(getSelfSessionId());
  }
  return videoSingleton;
}
