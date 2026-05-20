/**
 * lock-screen-bridge — keep the viewer's video alive while the host's
 * workstation is on the secure (Winlogon) desktop.
 *
 * Chromium's `desktopCapturer` runs inside the user-mode Agent and is
 * bound to `winsta0\\default`. The moment the user locks the PC, the
 * captured frames go black because the active desktop has switched to
 * `winsta0\\winlogon`. The SYSTEM Worker — which can attach to whichever
 * desktop is currently receiving input — captures the lock screen via
 * GDI BitBlt and pushes raw BGRA frames over a side pipe (`titan-xt-video-*`).
 *
 * This module is the glue:
 *   1. Watches `PipeClient.onDesktopChange()`.
 *   2. When the desktop name leaves "Default", starts the video pipe and
 *      forwards each frame to the renderer over IPC.
 *   3. When it returns to "Default", stops the pipe and tells the renderer
 *      to drop back to the regular desktopCapturer track.
 *
 * The renderer (lock-fallback.ts) is responsible for swapping the actual
 * RTCRtpSender video track. We just shuttle bytes.
 */

import { BrowserWindow } from 'electron';
import { getPipeClient, getVideoPipeClient, VideoPipeFrame } from './pipe-client';

// "Default" is the literal user object name for the normal interactive
// desktop. Anything else — "Winlogon", "Screen-saver", a custom desktop —
// means we should be in fallback mode.
const NORMAL_DESKTOP = 'Default';

// Throttle frame forwarding to renderer: even though the worker caps at
// ~10 fps, a slow renderer would otherwise queue messages on the IPC port.
// We drop instead of queue so the freshest frame always wins.
let inflightFrame: VideoPipeFrame | null = null;
let dispatching = false;

let started = false;
let active = false;
let getWindow: () => BrowserWindow | null = () => null;

function dispatchToRenderer(): void {
  if (dispatching) return;
  dispatching = true;
  // Microtask so back-to-back frames coalesce into a single send.
  queueMicrotask(() => {
    dispatching = false;
    if (!inflightFrame) return;
    const f = inflightFrame;
    inflightFrame = null;
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    try {
      // Buffer survives IPC unchanged — Electron transfers it as a
      // Uint8Array on the renderer side.
      win.webContents.send('lockscreen:frame', {
        width: f.width,
        height: f.height,
        format: f.format,
        payload: f.payload,
      });
    } catch (err) {
      console.warn('[LockBridge] send failed:', (err as Error).message);
    }
  });
}

function onFrame(frame: VideoPipeFrame): void {
  // Newest wins. If the renderer is slow we'll drop intermediate frames
  // and only ever send the latest, which is what we want for screen share.
  inflightFrame = frame;
  dispatchToRenderer();
}

function startFallback(reason: string): void {
  if (active) return;
  active = true;
  console.log(`[LockBridge] entering fallback (${reason})`);
  const video = getVideoPipeClient();
  video.start();
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send('lockscreen:state', { locked: true });
    } catch { /* ignore */ }
  }
}

function stopFallback(reason: string): void {
  if (!active) return;
  active = false;
  console.log(`[LockBridge] leaving fallback (${reason})`);
  const video = getVideoPipeClient();
  video.stop();
  inflightFrame = null;
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send('lockscreen:state', { locked: false });
    } catch { /* ignore */ }
  }
}

/**
 * Wire the bridge. Call once during agent startup with a getter that
 * returns the active main window (so we can hand frames to the renderer
 * after it's been created).
 */
export function setupLockScreenBridge(getMainWindow: () => BrowserWindow | null): void {
  if (started) return;
  if (process.platform !== 'win32') return; // GDI capture is Windows-only
  started = true;
  getWindow = getMainWindow;

  const pipe = getPipeClient();
  const video = getVideoPipeClient();
  video.onFrame(onFrame);

  // React to desktop changes pushed by the worker.
  pipe.onDesktopChange((name) => {
    if (!name) return;
    // Empty name = unknown / not yet attached. Stay in current state.
    if (name === NORMAL_DESKTOP) {
      stopFallback(`desktop=${name}`);
    } else {
      startFallback(`desktop=${name}`);
    }
  });

  // If the worker reported a desktop before the bridge wired up (race on
  // first connect), reconcile now. Empty string = still unknown.
  const initial = pipe.desktopName();
  if (initial && initial !== NORMAL_DESKTOP) {
    startFallback(`initial desktop=${initial}`);
  }
}
