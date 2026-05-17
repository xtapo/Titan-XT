import { ipcMain } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Remote-action ids handled by the host. Mirrored in shared/protocol.ts so
 * the renderer can send and the host can dispatch using the same string.
 */
export type RemoteActionId =
  | 'ctrl-alt-del'
  | 'lock'
  | 'signout'
  | 'restart'
  | 'shutdown'
  | 'task-manager';

interface ActionResult {
  success: boolean;
  error?: string;
}

/**
 * Run a system command and translate any failure into a structured result.
 * We never let exec rejections escape — the renderer treats undefined as
 * "platform unsupported" and shows a clean toast either way.
 */
async function run(cmd: string): Promise<ActionResult> {
  try {
    await execAsync(cmd);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Execute a remote action on the host.
 *
 * Notes:
 *   - Windows uses dedicated commands (rundll32 / shutdown / logoff / taskmgr).
 *   - Ctrl+Alt+Del cannot be simulated from a normal user session on Windows
 *     (it is a Secure Attention Sequence). The closest equivalent we can
 *     trigger without UAC is the lock screen, so we map it to lock + a note.
 *   - On macOS / Linux we provide best-effort equivalents.
 */
export async function executeRemoteAction(action: RemoteActionId): Promise<ActionResult> {
  const platform = process.platform;

  switch (action) {
    case 'lock':
      if (platform === 'win32') return run('rundll32.exe user32.dll,LockWorkStation');
      if (platform === 'darwin') return run('pmset displaysleepnow');
      return run('loginctl lock-session');

    case 'ctrl-alt-del':
      // True SAS requires a service running as SYSTEM. Fall back to the lock
      // screen, which is what most remote tools do for unprivileged sessions.
      if (platform === 'win32') return run('rundll32.exe user32.dll,LockWorkStation');
      return { success: false, error: 'Chỉ hỗ trợ trên Windows' };

    case 'signout':
      if (platform === 'win32') return run('shutdown /l /f');
      if (platform === 'darwin') return run('osascript -e "tell application \\"System Events\\" to log out"');
      return run('loginctl terminate-user $USER');

    case 'restart':
      if (platform === 'win32') return run('shutdown /r /t 0 /f');
      if (platform === 'darwin') return run('osascript -e "tell application \\"System Events\\" to restart"');
      return run('shutdown -r now');

    case 'shutdown':
      if (platform === 'win32') return run('shutdown /s /t 0 /f');
      if (platform === 'darwin') return run('osascript -e "tell application \\"System Events\\" to shut down"');
      return run('shutdown -h now');

    case 'task-manager':
      if (platform === 'win32') return run('taskmgr');
      if (platform === 'darwin') return run('open -a "Activity Monitor"');
      return run('gnome-system-monitor');

    default:
      return { success: false, error: `Hành động không hỗ trợ: ${action}` };
  }
}

export function setupSystemActions(): void {
  ipcMain.handle('system:execute', async (_event, action: RemoteActionId) => {
    return executeRemoteAction(action);
  });
}
