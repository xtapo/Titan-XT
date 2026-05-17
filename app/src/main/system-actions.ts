import { ipcMain } from 'electron';
import type { RemoteActionId } from '../shared/protocol';
import { executeRemoteAction } from './system-actions-executor';
import { getPipeClient } from './pipe-client';

export type { RemoteActionId };

/**
 * Routes `system:execute` IPC calls. Prefers the SYSTEM worker so commands
 * like `shutdown /s` and `taskmgr` (which UAC normally elevates) succeed
 * without prompting. Falls back to in-process exec when the worker is not
 * reachable — the user just sees a UAC prompt or a denied result.
 */
export function setupSystemActions(): void {
  const pipe = getPipeClient();

  ipcMain.handle('system:execute', async (_event, action: RemoteActionId) => {
    if (process.platform === 'win32' && pipe.worthTrying()) {
      try {
        const res = await pipe.executeSystem(action);
        return { success: res.ok, error: res.error };
      } catch (err: any) {
        console.warn('[SystemActions] pipe unavailable, using in-process fallback:', err.message);
      }
    }
    return executeRemoteAction(action);
  });
}
