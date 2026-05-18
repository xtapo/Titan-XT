import { ipcMain } from 'electron';
import type { RemoteActionId } from '../shared/protocol';
import { executeRemoteAction } from './system-actions-executor';
import { getPipeClient } from './pipe-client';
import { hideWallpaper, restoreWallpaper } from './wallpaper';

export type { RemoteActionId };

/**
 * Routes `system:execute` IPC calls. Prefers the SYSTEM worker so commands
 * like `shutdown /s` and `taskmgr` (which UAC normally elevates) succeed
 * without prompting. Falls back to in-process exec when the worker is not
 * reachable — the user just sees a UAC prompt or a denied result.
 *
 * Wallpaper actions short-circuit before the SYSTEM worker because the
 * trick (SystemParametersInfoW) only takes effect on the active desktop's
 * user session, which is the renderer process — not the SYSTEM session.
 */
export function setupSystemActions(): void {
  const pipe = getPipeClient();

  ipcMain.handle('system:execute', async (_event, action: RemoteActionId) => {
    if (action === 'hide-wallpaper') return hideWallpaper();
    if (action === 'restore-wallpaper') return restoreWallpaper();

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
