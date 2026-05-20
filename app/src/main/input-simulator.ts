import { ipcMain } from 'electron';
import { MouseMessage, KeyMessage } from '../shared/protocol';
import { executeInputMessage } from './input-executor';
import { getPipeClient } from './pipe-client';

/**
 * InputSimulator — IPC handler that prefers forwarding to the SYSTEM
 * Worker (so input lands at high IL and is not blocked by UIPI when the
 * foreground app is UAC-elevated). Falls back to executing in-process
 * when the service isn't installed yet.
 *
 * Mouse-move coalescing: a high-poll mouse on a fast viewer can push
 * 240+ Hz of move events onto the data channel. Each one used to traverse
 * IPC → pipe → nut.js setPosition synchronously, building a queue when
 * any single hop took longer than the inter-event spacing. The queue
 * showed up as "cursor lags behind the finger" — even on LAN. We now
 * keep at most one pending move at a time and let newer moves overwrite
 * the previous, which is exactly the semantics the host wants for an
 * absolute-positioning protocol: only the latest position matters.
 *
 * Button events (down / up / click / dblclick / contextmenu / scroll)
 * still go through serially, because dropping one of those would lose a
 * click. They drain the queued move first so a fast move-then-click
 * never lands at the previous position.
 */

let pendingMove: MouseMessage | null = null;
let drainInFlight = false;

async function drainPendingMove(send: (m: MouseMessage) => Promise<void>): Promise<void> {
  if (drainInFlight) return;
  drainInFlight = true;
  try {
    while (pendingMove) {
      const m = pendingMove;
      pendingMove = null;
      try {
        await send(m);
      } catch {
        // Best-effort — a single failed move shouldn't poison subsequent ones.
      }
    }
  } finally {
    drainInFlight = false;
  }
}

export function setupInputSimulator(): void {
  const pipe = getPipeClient();

  /** Send one input message, preferring the SYSTEM worker pipe. */
  const sendOne = async (msg: MouseMessage | KeyMessage): Promise<void> => {
    if (process.platform === 'win32' && pipe.worthTrying()) {
      try {
        const res = await pipe.simulateInput(msg);
        if (res.ok) return;
      } catch {
        // Pipe down — fall through to in-process.
      }
    }
    await executeInputMessage(msg);
  };

  ipcMain.handle('input:simulate', async (_event, msg: MouseMessage | KeyMessage) => {
    // Mouse-move: only the latest position matters. Stash and let the drain
    // loop pick it up; if a drain is already running and a new move arrives
    // mid-flight, it overwrites pendingMove and the in-flight setPosition
    // finishes, then the loop sees the new value and ships it.
    if (msg.type === 'mouse' && msg.action === 'move') {
      pendingMove = msg;
      // Don't await — return immediately so the data-channel handler can
      // process the next packet without back-pressure from the worker.
      void drainPendingMove(sendOne);
      return { success: true };
    }

    // Button / key / scroll: flush any queued move first so a click never
    // lands at the previous position, then send synchronously.
    if (pendingMove) {
      const flush = pendingMove;
      pendingMove = null;
      try {
        await sendOne(flush);
      } catch {
        // ignore
      }
    }
    try {
      await sendOne(msg);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Host-side BlockInput toggle. Only effective when the SYSTEM worker is
  // running — falls back to ok:false so the renderer can show a "khong the
  // chan" toast instead of silently doing nothing.
  ipcMain.handle('input:setHostBlocked', async (_event, block: boolean) => {
    if (process.platform !== 'win32') return { success: false, error: 'Chỉ hỗ trợ trên Windows' };
    if (!pipe.worthTrying()) return { success: false, error: 'Worker không sẵn sàng' };
    try {
      const res = await pipe.setHostInputBlocked(!!block);
      return { success: res.ok, error: res.error };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });
}
