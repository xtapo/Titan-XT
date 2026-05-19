import { ipcMain } from 'electron';
import { MouseMessage, KeyMessage } from '../shared/protocol';
import { executeInputMessage } from './input-executor';
import { getPipeClient } from './pipe-client';

/**
 * InputSimulator — IPC handler that forwards input to the SYSTEM Worker
 * pipe when available, falling back to in-process nut.js otherwise.
 *
 * Smoothing for absolute-position mouse moves:
 * The viewer ships ratio coords on every mousemove (often 240+ Hz). The
 * naive "set to latest target" path was physically correct but felt
 * jittery on slow drags because the host cursor stepped pixel-to-pixel
 * instead of gliding. We now run a 125 Hz lerp loop that blends the
 * tracked position toward the latest target by LERP_FACTOR per tick.
 * Flicks (>FLICK_THRESHOLD of screen) snap instantly so big gestures
 * stay responsive; tiny residuals (<SNAP_RATIO) also snap so the loop
 * terminates instead of chasing floating-point dust.
 *
 * Buttons / keys / scroll drain through a shared chain so a click can
 * never overlap an in-flight lerp step (which would race nut.js's
 * internal lastPos cache).
 */

const TICK_MS = 8;
const LERP_FACTOR = 0.4;
const SNAP_RATIO = 0.0008;
const FLICK_THRESHOLD = 0.15;

let targetMove: MouseMessage | null = null;
let currentX: number | null = null;
let currentY: number | null = null;
let interpolating = false;

let sendChain: Promise<void> = Promise.resolve();

function chainSend(fn: () => Promise<void>): Promise<void> {
  const p = sendChain.then(fn, fn);
  sendChain = p.catch(() => {});
  return p;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function runInterpolation(send: (m: MouseMessage) => Promise<void>): Promise<void> {
  if (interpolating) return;
  interpolating = true;
  try {
    while (targetMove) {
      const t = targetMove;
      const tx = t.x;
      const ty = t.y;

      if (currentX === null || currentY === null) {
        currentX = tx;
        currentY = ty;
        try { await chainSend(() => send({ ...t, x: tx, y: ty })); } catch {}
        if (targetMove === t) targetMove = null;
        continue;
      }

      const dx = tx - currentX;
      const dy = ty - currentY;
      const dist = Math.hypot(dx, dy);

      if (dist <= SNAP_RATIO || dist >= FLICK_THRESHOLD) {
        currentX = tx;
        currentY = ty;
        try { await chainSend(() => send({ ...t, x: tx, y: ty })); } catch {}
        if (targetMove === t) targetMove = null;
        continue;
      }

      currentX += dx * LERP_FACTOR;
      currentY += dy * LERP_FACTOR;
      const stepX = currentX;
      const stepY = currentY;
      try { await chainSend(() => send({ ...t, x: stepX, y: stepY })); } catch {}
      await sleep(TICK_MS);
    }
  } finally {
    interpolating = false;
  }
}

export function setupInputSimulator(): void {
  const pipe = getPipeClient();

  const sendOne = async (msg: MouseMessage | KeyMessage): Promise<void> => {
    if (process.platform === 'win32' && pipe.worthTrying()) {
      try {
        const res = await pipe.simulateInput(msg);
        if (res.ok) return;
      } catch {
        // Pipe down — fall through.
      }
    }
    await executeInputMessage(msg);
  };

  ipcMain.handle('input:simulate', async (_event, msg: MouseMessage | KeyMessage) => {
    if (msg.type === 'mouse' && msg.action === 'move') {
      targetMove = msg;
      void runInterpolation(sendOne);
      return { success: true };
    }

    // Button / scroll: cancel any pending lerp, snap the tracker to the
    // event's own coords so subsequent moves lerp from here, then queue
    // the event behind any in-flight lerp step.
    if (msg.type === 'mouse') {
      targetMove = null;
      currentX = msg.x;
      currentY = msg.y;
    }
    try {
      await chainSend(() => sendOne(msg));
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}
