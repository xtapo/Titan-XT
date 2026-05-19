/**
 * Windows-only auto-launch helper.
 *
 * The packaged app requires administrator elevation (see app/package.json
 * `requestedExecutionLevel: requireAdministrator`). That kills the usual
 * `app.setLoginItemSettings` path: it writes to HKCU\Run, but UAC will not
 * auto-elevate a Run-key launch — Windows just blocks the process at login,
 * silently. Users tick the box and nothing happens.
 *
 * The supported workaround for elevated apps is a Scheduled Task with a
 * LogonTrigger + RunLevel=HighestAvailable. Task Scheduler bypasses UAC
 * because the task was already authorized at install time, so the app
 * launches elevated at login without a prompt.
 *
 * We pass `--hidden` so the agent comes up in the tray with no window pop.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execAsync = promisify(exec);

const TASK_NAME = 'TitanXTAutoLaunch';

interface ShResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

async function sh(cmd: string): Promise<ShResult> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { windowsHide: true });
    return { ok: true, stdout, stderr };
  } catch (err: any) {
    return {
      ok: false,
      stdout: err?.stdout,
      stderr: err?.stderr,
      error: err?.message || String(err),
    };
  }
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build a Scheduled Task XML that fires for the current interactive user
 * at logon and launches the agent exe with `--hidden`.
 *
 * UserId is captured at install time from USERNAME / USERDOMAIN env so the
 * task is bound to whoever ticked the checkbox — matches the principle of
 * least surprise (the app starts for them, not for every user on the box).
 */
function buildTaskXml(exePath: string, userId: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Auto-start Titan-XT at user logon (elevated, hidden in tray).</Description>
    <Author>Titan-XT</Author>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escXml(userId)}</UserId>
      <Delay>PT5S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escXml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escXml(exePath)}</Command>
      <Arguments>--hidden</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

async function writeTempXml(xml: string): Promise<string> {
  const file = path.join(os.tmpdir(), `titan-xt-autolaunch-${Date.now()}.xml`);
  // schtasks /XML expects UTF-16 LE with BOM (matches the XML declaration).
  fs.writeFileSync(file, '﻿' + xml, { encoding: 'utf16le' });
  return file;
}

function currentUserId(): string {
  const domain = process.env.USERDOMAIN || process.env.COMPUTERNAME || '';
  const user = process.env.USERNAME || '';
  return domain ? `${domain}\\${user}` : user;
}

export async function setAutoLaunchWindows(
  enabled: boolean,
  exePath: string,
): Promise<{ success: boolean; error?: string }> {
  if (!enabled) {
    // Best-effort delete. If the task doesn't exist, schtasks returns
    // exit 1 — treat that as already-uninstalled, not as failure.
    const del = await sh(`schtasks /Delete /TN "${TASK_NAME}" /F`);
    if (!del.ok) {
      const stderr = (del.stderr || '').toLowerCase();
      const stdout = (del.stdout || '').toLowerCase();
      if (
        stderr.includes('cannot find') ||
        stderr.includes('does not exist') ||
        stdout.includes('cannot find') ||
        stdout.includes('does not exist')
      ) {
        return { success: true };
      }
      return { success: false, error: del.stderr || del.error || 'schtasks /Delete failed' };
    }
    return { success: true };
  }

  const userId = currentUserId();
  if (!userId) {
    return { success: false, error: 'Could not determine current user' };
  }

  const xml = buildTaskXml(exePath, userId);
  const xmlPath = await writeTempXml(xml);

  const create = await sh(
    `schtasks /Create /TN "${TASK_NAME}" /XML "${xmlPath}" /F`,
  );

  try {
    fs.unlinkSync(xmlPath);
  } catch { /* ignore */ }

  if (!create.ok) {
    return {
      success: false,
      error: create.stderr || create.error || 'schtasks /Create failed',
    };
  }
  return { success: true };
}

export async function getAutoLaunchWindows(): Promise<{
  enabled: boolean;
  hidden: boolean;
}> {
  const r = await sh(`schtasks /Query /TN "${TASK_NAME}"`);
  return { enabled: r.ok, hidden: r.ok };
}
