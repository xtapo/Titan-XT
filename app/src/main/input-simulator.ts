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
 * The fallback is what an unprivileged user sees on first install before
 * the service is registered, and during dev where we run the agent alone.
 */

export function setupInputSimulator(): void {
  const pipe = getPipeClient();

  ipcMain.handle('input:simulate', async (_event, msg: MouseMessage | KeyMessage) => {
    // Fast path: send via pipe. We only fall back if the worker is not
    // reachable, because in-process input cannot drive elevated apps.
    if (process.platform === 'win32' && pipe.worthTrying()) {
      try {
        const res = await pipe.simulateInput(msg);
        if (res.ok) return { success: true };
        // Pipe responded with an error — surface it instead of silently falling
        // back, since the worker is the source of truth when present.
        return { success: false, error: res.error };
      } catch (err: any) {
        // Connection failed (service down, mid-respawn, …). Fall through to
        // in-process execution rather than dropping the input.
        console.warn('[Input] pipe unavailable, using in-process fallback:', err.message);
      }
    }

    try {
      await executeInputMessage(msg);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}
