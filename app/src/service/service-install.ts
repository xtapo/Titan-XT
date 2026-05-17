/**
 * Install / uninstall the Titan-XT background supervisor.
 *
 * We use a Windows Scheduled Task instead of an SCM service because Node +
 * koffi cannot host a SCM ServiceMain reliably — the V8 thread gets blocked
 * inside StartServiceCtrlDispatcherW and the service is stuck in "Starting"
 * until SCM times it out. A scheduled task gives us the same outcome
 * (auto-start at boot, LocalSystem account) without that constraint.
 *
 * Task config:
 *   - Trigger: ONSTART (boots before any user logs in)
 *   - Account: SYSTEM (Run with highest privileges)
 *   - Action:  "<exe>" --service
 *   - Multiple-instance policy: ignore new instance if already running
 *   - Restart on failure handled by the supervisor itself (it loops)
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { SERVICE_NAME, SERVICE_DESCRIPTION } from './service-meta';

const execAsync = promisify(exec);

export interface InstallResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

async function sh(cmd: string): Promise<InstallResult> {
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

/**
 * schtasks.exe accepts an XML definition for full control. We generate it
 * inline and pipe via /XML so we get all the options that aren't exposed
 * on the simple /Create flag set (most importantly: ExecutionTimeLimit=PT0S
 * which tells Task Scheduler to never auto-stop our supervisor, and
 * StopOnIdleEnd=false / DisallowStartIfOnBatteries=false).
 */
function buildTaskXml(exePath: string): string {
  // The exe path is embedded inside an XML attribute-ish text node. Escape
  // anything that would break XML or Task Scheduler's argument parsing.
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ELECTRON_RUN_AS_NODE turns Titan-XT.exe into a plain Node interpreter
  // (skipping Chromium init, which would crash in session 0). But Node then
  // parses our argv looking for its OWN flags, so passing `--service`
  // directly trips Node's "invalid argument" path (exit code 9). We have
  // to give Node the entry script path first; everything after is forwarded
  // as argv to the script.
  //
  // The packaged layout puts main/index.js inside resources/app.asar — Node
  // (loaded by Electron) reads asar transparently, so this path works.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path');
  const installDir = path.dirname(exePath);
  const entryScript = path.join(installDir, 'resources', 'app.asar', 'dist', 'main', 'index.js');

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${esc(SERVICE_DESCRIPTION)}</Description>
    <Author>Titan-XT</Author>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
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
    <Priority>5</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/c set ELECTRON_RUN_AS_NODE=1&amp;&amp; "${esc(exePath)}" "${esc(entryScript)}" --service</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

/**
 * Write the XML to %TEMP% and import via schtasks /Create /XML. Doing it
 * via a temp file avoids quoting hell (the XML contains < > & quotes).
 */
async function writeTempXml(xml: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path');
  const file = path.join(os.tmpdir(), `titan-xt-task-${Date.now()}.xml`);
  // schtasks /XML expects UTF-16 LE with BOM (matches the XML declaration).
  fs.writeFileSync(file, '﻿' + xml, { encoding: 'utf16le' });
  return file;
}

export async function installService(exePath: string): Promise<InstallResult> {
  // Best-effort cleanup of any previous task.
  await sh(`schtasks /Delete /TN "${SERVICE_NAME}" /F`);

  const xml = buildTaskXml(exePath);
  const xmlPath = await writeTempXml(xml);

  const create = await sh(
    `schtasks /Create /TN "${SERVICE_NAME}" /XML "${xmlPath}" /F`
  );

  // Best-effort cleanup of the temp file regardless of outcome.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('fs').unlinkSync(xmlPath);
  } catch { /* ignore */ }

  if (!create.ok) return create;

  // Run it now so the user doesn't have to reboot to start using it.
  return sh(`schtasks /Run /TN "${SERVICE_NAME}"`);
}

export async function uninstallService(): Promise<InstallResult> {
  await sh(`schtasks /End /TN "${SERVICE_NAME}"`); // best-effort stop
  return sh(`schtasks /Delete /TN "${SERVICE_NAME}" /F`);
}

export async function isServiceInstalled(): Promise<boolean> {
  const r = await sh(`schtasks /Query /TN "${SERVICE_NAME}"`);
  return r.ok;
}

export async function isServiceRunning(): Promise<boolean> {
  const r = await sh(`schtasks /Query /TN "${SERVICE_NAME}" /FO LIST`);
  if (!r.ok) return false;
  return /Status:\s*Running/i.test(r.stdout || '');
}

/** CLI entry — dispatched from main/index.ts on `--install-service` /
 *  `--uninstall-service`. */
export async function runInstallCli(mode: 'install' | 'uninstall', exePath: string): Promise<number> {
  const result = mode === 'install' ? await installService(exePath) : await uninstallService();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (!result.ok) {
    if (result.error) console.error(result.error);
    return 1;
  }
  return 0;
}
