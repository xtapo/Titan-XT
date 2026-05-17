import { exec } from 'child_process';
import { promisify } from 'util';
import type { RemoteActionId } from '../shared/protocol';

const execAsync = promisify(exec);

/**
 * SystemActionsExecutor — pure executor, no Electron deps so the SYSTEM
 * worker can run it directly. The Agent uses this same module as fallback.
 *
 * Notes:
 *   - Windows uses dedicated commands (rundll32 / shutdown / logoff / taskmgr).
 *   - Ctrl+Alt+Del cannot be simulated from a normal user session on Windows
 *     (it's a Secure Attention Sequence). Falling back to lock screen mirrors
 *     what most remote tools do for unprivileged sessions.
 *   - When this runs inside the SYSTEM worker, `shutdown /s|/r` and `logoff`
 *     finally have the privilege they need without prompting UAC.
 */

export interface ActionResult {
  success: boolean;
  error?: string;
}

async function run(cmd: string): Promise<ActionResult> {
  try {
    await execAsync(cmd);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

export async function executeRemoteAction(action: RemoteActionId): Promise<ActionResult> {
  const platform = process.platform;

  switch (action) {
    case 'lock':
      if (platform === 'win32') return run('rundll32.exe user32.dll,LockWorkStation');
      if (platform === 'darwin') return run('pmset displaysleepnow');
      return run('loginctl lock-session');

    case 'ctrl-alt-del':
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
