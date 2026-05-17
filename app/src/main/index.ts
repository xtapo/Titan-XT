// === Multi-mode entry ===
//
// The same packaged binary powers three roles:
//   - Agent  (default): Electron UI process. Runs in user session.
//   - Service:          LocalSystem service host registered with SCM.
//   - Worker:           SYSTEM-level executor spawned by the service into
//                       the active user session (no Electron UI).
//
// Dispatch happens before any Electron import so the Service/Worker paths
// don't pay Electron's startup cost or pull a windowing stack they don't
// need. The build emits this file as the binary's main; SCM and
// CreateProcessAsUser launchers add `--service` / `--worker` argv.

const argv = process.argv.slice(1);
const hasFlag = (f: string) => argv.some((a) => a === f || a.startsWith(`${f}=`));

if (hasFlag('--service')) {
  // SCM-registered host. Bare Node — never touches Electron.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../service/service-host').runService();
} else if (hasFlag('--worker')) {
  // SYSTEM input/system-actions worker. Bare Node, no Electron either.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../worker/index');
} else if (hasFlag('--install-service') || hasFlag('--uninstall-service')) {
  // Manual elevated CLI. Useful for installer / dev / repair.
  const mode: 'install' | 'uninstall' = hasFlag('--install-service') ? 'install' : 'uninstall';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('../service/service-install') as typeof import('../service/service-install'))
    .runInstallCli(mode, process.execPath)
    .then((code: number) => process.exit(code))
    .catch((err: Error) => {
      console.error(err);
      process.exit(1);
    });
} else {
  // Default: run as Agent (Electron UI). All Electron-touching code lives
  // in ./agent so it isn't pulled in by the Service/Worker paths above.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./agent').startAgent();
}
