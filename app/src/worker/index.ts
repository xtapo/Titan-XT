/**
 * Titan-XT Worker — runs as LocalSystem inside the active interactive
 * desktop session. Owns the only nut.js instance and the only
 * `system-actions` executor on the host.
 *
 * Lifecycle:
 *   1. Spawned by the Service host with a duplicated SYSTEM token bound
 *      to the active user's WTSGetActiveConsoleSessionId().
 *   2. Opens a JSON named pipe at pipePathForSession(<sessionId>) for the
 *      Agent's input + system-action requests, and a parallel video pipe
 *      at videoPipePathForSession(<sessionId>) that streams GDI captures
 *      (used to keep the viewer rendering through the lock screen).
 *   3. Accepts one connection at a time per pipe from the user-mode Agent
 *      (the Electron app), dispatches requests, writes JSON-line responses.
 *   4. Exits when the pipe is closed by the parent service (the service
 *      kills the worker on stop / session change).
 *
 * Pipe security: we restrict the ACL so only INTERACTIVE users + SYSTEM
 * can connect. That stops a sandboxed renderer in the same session from
 * speaking to it directly — only our Electron main process (running as
 * a normal user in the same session) can connect.
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
} from '../shared/pipe-protocol';
import { executeRemoteAction } from '../main/system-actions-executor';
import { attachToInputDesktop, currentDesktopName } from './desktop-attach';
import { captureFrame, disposeCapture } from './gdi-capture';
import { executeInputSync } from './worker-input';
import { bindNativeInput, setBlockInput } from './native-input';

const SESSION_ARG_PREFIX = '--session=';

// Default capture target. 1280×720 fits comfortably on a local pipe at 10
// fps (~35 MB/s) and keeps the lock screen / Winlogon UI readable.
const VIDEO_TARGET_WIDTH = 1280;
const VIDEO_TARGET_HEIGHT = 720;
const VIDEO_TARGET_FPS = 10;

// Active JSON-pipe sockets we'll broadcast desktop-change events on.
const jsonClients = new Set<net.Socket>();
// Active video-pipe socket. We only allow one at a time — there's exactly
// one Agent per session so this is fine.
let videoClient: net.Socket | null = null;
let videoTimer: NodeJS.Timeout | null = null;

// Sticky host-input block. The OS clears BlockInput on every desktop
// switch (lock screen, UAC dim, Ctrl+Alt+Del), so we mirror the desired
// state here and re-assert it whenever attachToInputDesktop reports a new
// desktop name. Toggled by Agent via 'input.block-host' pipe requests.
let hostInputBlocked = false;

function parseSessionId(): number {
  for (const arg of process.argv) {
    if (arg.startsWith(SESSION_ARG_PREFIX)) {
      const v = parseInt(arg.slice(SESSION_ARG_PREFIX.length), 10);
      if (!Number.isNaN(v)) return v;
    }
  }
  // Fallback: assume console session 1. The service host should always pass
  // --session=N explicitly; this is just a safety net for manual dev runs.
  return 1;
}

async function handle(req: PipeRequest): Promise<PipeResponse> {
  try {
    switch (req.kind) {
      case 'ping':
        return { id: req.id, ok: true, data: { pong: true, pid: process.pid, desktop: currentDesktopName() } };

      case 'input.simulate':
        // Re-attach before each input event so we follow the active input
        // desktop across lock/unlock and UAC dim screen transitions. Cheap
        // when nothing changed (one OpenInputDesktop + name compare).
        // Critical: dispatch via SendInput on THIS thread (the one we just
        // attached) — nut.js runs on libuv worker threads that never
        // re-attach, so its input lands on the original Default desktop and
        // is silently dropped on the lock screen.
        attachToInputDesktop();
        executeInputSync(req.payload);
        return { id: req.id, ok: true };

      case 'input.block-host': {
        const block = !!req.payload?.block;
        hostInputBlocked = block;
        attachToInputDesktop();
        const ok = setBlockInput(block);
        return { id: req.id, ok, error: ok ? undefined : 'BlockInput failed' };
      }

      case 'system.execute': {
        const result = await executeRemoteAction(req.payload.action);
        return { id: req.id, ok: result.success, error: result.error };
      }

      default:
        return { id: (req as any).id ?? 0, ok: false, error: 'Unknown request kind' };
    }
  } catch (err: any) {
    return { id: req.id, ok: false, error: err?.message || String(err) };
  }
}

function attachJsonClient(socket: net.Socket): void {
  jsonClients.add(socket);
  const decoder = new FrameDecoder<PipeRequest>();
  socket.on('data', async (chunk) => {
    const msgs = decoder.push(chunk);
    for (const req of msgs) {
      const res = await handle(req);
      if (!socket.writable) return;
      socket.write(encodeFrame(res));
    }
  });
  socket.on('error', (err) => {
    console.error('[Worker] pipe socket error:', err.message);
  });
  socket.on('close', () => {
    jsonClients.delete(socket);
    console.log('[Worker] json client disconnected');
  });

  // Push the current desktop state immediately so the agent knows whether
  // the screen is already locked at connection time.
  const ev: PipeEvent = { id: 0, event: 'desktop', desktop: currentDesktopName() };
  try { socket.write(encodeFrame(ev)); } catch { /* ignore */ }
}

function broadcastDesktopChange(name: string): void {
  const ev: PipeEvent = { id: 0, event: 'desktop', desktop: name };
  const buf = encodeFrame(ev);
  for (const sock of jsonClients) {
    if (!sock.writable) continue;
    try { sock.write(buf); } catch { /* ignore one bad client */ }
  }
}

/**
 * Capture loop. Runs only while a video client is connected. Re-attaches
 * to the input desktop on every tick so frames keep flowing through
 * lock/unlock — capture from the user's Default desktop won't show what's
 * on the Winlogon desktop, you have to be attached to it.
 */
function startCaptureLoop(): void {
  if (videoTimer) return;
  let prevDesktop = currentDesktopName();
  const intervalMs = Math.max(33, Math.round(1000 / VIDEO_TARGET_FPS));
  videoTimer = setInterval(() => {
    if (!videoClient || !videoClient.writable) return;
    const desk = attachToInputDesktop();
    if (desk && desk !== prevDesktop) {
      prevDesktop = desk;
      broadcastDesktopChange(desk);
    }
    const frame = captureFrame({
      targetWidth: VIDEO_TARGET_WIDTH,
      targetHeight: VIDEO_TARGET_HEIGHT,
    });
    if (!frame) return;
    // Apply backpressure: skip a frame if the kernel pipe buffer is already
    // full. write() returns false in that case; we drop instead of queueing
    // to keep memory bounded under a slow consumer.
    try {
      videoClient.write(frame);
    } catch (err) {
      console.error('[Worker] video write failed:', (err as Error).message);
    }
  }, intervalMs);
}

function stopCaptureLoop(): void {
  if (videoTimer) {
    clearInterval(videoTimer);
    videoTimer = null;
  }
  disposeCapture();
}

function attachVideoClient(socket: net.Socket): void {
  // Only one video consumer at a time. Boot the previous one cleanly so a
  // reconnect after a transient drop doesn't leave us with two writers.
  if (videoClient) {
    try { videoClient.destroy(); } catch { /* ignore */ }
    videoClient = null;
  }
  videoClient = socket;
  console.log('[Worker] video client connected');

  // Drop any inbound bytes — this pipe is one-way.
  socket.on('data', () => { /* ignore */ });
  socket.on('error', (err) => {
    console.error('[Worker] video pipe error:', err.message);
  });
  socket.on('close', () => {
    if (videoClient === socket) {
      videoClient = null;
      stopCaptureLoop();
      console.log('[Worker] video client disconnected');
    }
  });

  startCaptureLoop();
}

async function main(): Promise<void> {
  const sessionId = parseSessionId();
  const pipePath = pipePathForSession(sessionId);
  const videoPipePath = videoPipePathForSession(sessionId);

  // Bind the worker thread to whatever desktop is receiving input *now* so
  // the very first input call doesn't lose a frame to the attach round-trip.
  // Subsequent calls re-check on every input batch (handle()).
  attachToInputDesktop();

  // Pre-bind user32/SendInput so the first input call doesn't pay the
  // koffi load cost. Cheap and idempotent.
  bindNativeInput();

  const server = net.createServer((socket) => {
    console.log('[Worker] json client connected');
    attachJsonClient(socket);
  });

  server.on('error', (err) => {
    console.error('[Worker] server error:', err);
    process.exit(1);
  });

  server.listen(pipePath, () => {
    console.log(`[Worker] listening on ${pipePath} (pid=${process.pid})`);
  });

  const videoServer = net.createServer((socket) => {
    attachVideoClient(socket);
  });
  videoServer.on('error', (err) => {
    console.error('[Worker] video server error:', err);
  });
  videoServer.listen(videoPipePath, () => {
    console.log(`[Worker] video pipe ${videoPipePath}`);
  });

  // Lightweight watcher: even when no video client is connected, observe the
  // input desktop so we can broadcast lock/unlock events to the agent over
  // the JSON pipe. The agent uses these to decide when to switch the viewer
  // away from desktopCapturer (which goes blank on the Winlogon desktop).
  let lastDesk = currentDesktopName();
  setInterval(() => {
    const d = attachToInputDesktop();
    if (d && d !== lastDesk) {
      console.log(`[Worker] input desktop changed: "${lastDesk}" -> "${d}"`);
      lastDesk = d;
      broadcastDesktopChange(d);
      // BlockInput is per-desktop and the OS clears it on every switch.
      // Re-assert so the host stays blocked across UAC dim / Ctrl+Alt+Del
      // when control is locked.
      if (hostInputBlocked) setBlockInput(true);
    }
  }, 500);

  process.on('SIGTERM', () => {
    console.log('[Worker] SIGTERM — shutting down');
    if (hostInputBlocked) { setBlockInput(false); hostInputBlocked = false; }
    stopCaptureLoop();
    videoServer.close();
    server.close(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    if (hostInputBlocked) { setBlockInput(false); hostInputBlocked = false; }
    stopCaptureLoop();
    videoServer.close();
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('[Worker] fatal:', err);
  process.exit(1);
});
