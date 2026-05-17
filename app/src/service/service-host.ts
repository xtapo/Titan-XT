/**
 * Titan-XT Service host — runs as LocalSystem, started at boot by a
 * Scheduled Task (see service-install.ts).
 *
 * Why not SCM? Node + koffi cannot reliably implement a SCM ServiceMain:
 *   - StartServiceCtrlDispatcherW blocks the V8 thread.
 *   - SCM calls our ServiceMain on a foreign thread, but Node's event loop
 *     and timers only run on the main thread, so callbacks marshalled
 *     through koffi can never report SERVICE_RUNNING.
 *   - Symptom: service is stuck in "Starting" until SCM times out at 30s.
 *
 * A scheduled task running on `OnStart` as `NT AUTHORITY\SYSTEM` gives us
 * everything that mattered — auto-start at boot, LocalSystem privileges,
 * session-aware spawning — without the SCM threading dance.
 *
 * Responsibilities here:
 *   - Watch the active console session and (re)spawn the worker into it.
 *   - Restart the worker if it dies (small backoff).
 *   - Exit cleanly on SIGTERM / Ctrl+C / parent termination.
 */

import { getActiveSessionId, spawnWorkerInSession, waitForWorker, terminateWorker, SpawnedWorker } from './win32';
export { SERVICE_NAME, SERVICE_DISPLAY, SERVICE_DESCRIPTION } from './service-meta';

const POLL_INTERVAL_MS = 2_000;
const RESPAWN_BACKOFF_MS = 500;
const NO_SESSION = 0xffffffff;

let stopRequested = false;
let currentWorker: SpawnedWorker | null = null;
let currentSession: number = -1;

function killCurrentWorker(): void {
  if (!currentWorker) return;
  console.log(`[Service] terminating worker pid=${currentWorker.pid}`);
  terminateWorker(currentWorker.handle);
  currentWorker = null;
}

function ensureWorker(): void {
  if (stopRequested) return;
  const sessionId = getActiveSessionId();
  // 0xFFFFFFFF == no active interactive session (login screen / RDP-only).
  // Idle until a user logs in; the next poll picks it up.
  if (sessionId === NO_SESSION) {
    if (currentWorker) killCurrentWorker();
    currentSession = -1;
    return;
  }

  if (currentWorker && currentSession === sessionId) return;

  if (currentWorker) killCurrentWorker();

  // ELECTRON_RUN_AS_NODE=1 makes the Electron binary run as plain Node,
  // which is what the worker wants. Without this it tries to initialise
  // Chromium and crashes with STATUS_BREAKPOINT in session 0 / no display.
  // We inject it via the env block of CreateProcessAsUser instead of a
  // cmd.exe wrapper so TerminateProcess actually kills the worker.
  //
  // Also: in NODE mode the binary parses argv for Node's own flags, so we
  // can't pass `--worker` directly (Node exits 9 with "invalid argument").
  // We have to give Node the entry script path; everything after is argv
  // to the script. We're inside that script ourselves (running as supervisor),
  // so __filename works as long as it points at the same dist layout — but
  // process.execPath points at the .exe and our script lives next to it
  // under resources/app.asar/dist/main/index.js when packaged, or at the
  // tsc output path during dev. Reuse the same script we're running from.
  const entryScript = require.resolve('../main/index');
  const args = [entryScript, '--worker', `--session=${sessionId}`];
  try {
    currentWorker = spawnWorkerInSession(sessionId, process.execPath, args, {
      ELECTRON_RUN_AS_NODE: '1',
    });
    currentSession = sessionId;
    console.log(`[Service] spawned worker pid=${currentWorker.pid} session=${sessionId}`);
  } catch (err: any) {
    console.error('[Service] spawnWorkerInSession failed:', err.message);
  }
}

function shutdown(reason: string): void {
  if (stopRequested) return;
  stopRequested = true;
  console.log(`[Service] shutting down (${reason})`);
  killCurrentWorker();
  // Give logging a tick to flush.
  setTimeout(() => process.exit(0), 50);
}

/**
 * Main supervisor loop. Uses Node's event loop (setInterval) so the V8
 * thread stays responsive — no foreign-thread callbacks needed.
 */
export function runService(): void {
  console.log('[Service] starting supervisor');
  console.log(`  exec: ${process.execPath}`);
  console.log(`  pid:  ${process.pid}`);

  // Bind signals so the scheduled task can be stopped cleanly.
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // SIGHUP is sent by some session-management tools on logoff.
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // First spawn attempt happens immediately.
  ensureWorker();

  // Poll every POLL_INTERVAL_MS:
  //   - re-evaluate active session (handles fast user switching, RDP)
  //   - reap and respawn worker if it died
  const poller = setInterval(() => {
    if (stopRequested) {
      clearInterval(poller);
      return;
    }
    if (currentWorker) {
      // 0ms wait = poll the handle without blocking.
      const WAIT_OBJECT_0 = 0;
      const r = waitForWorker(currentWorker.handle, 0);
      if (r === WAIT_OBJECT_0) {
        console.log('[Service] worker exited — will respawn');
        terminateWorker(currentWorker.handle);
        currentWorker = null;
        // Tiny backoff to avoid hot-looping on a broken worker.
        setTimeout(ensureWorker, RESPAWN_BACKOFF_MS);
        return;
      }
    }
    ensureWorker();
  }, POLL_INTERVAL_MS);
}
