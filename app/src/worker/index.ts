/**
 * Titan-XT Worker — runs as LocalSystem inside the active interactive
 * desktop session. Owns the only nut.js instance and the only
 * `system-actions` executor on the host.
 *
 * Lifecycle:
 *   1. Spawned by the Service host with a duplicated SYSTEM token bound
 *      to the active user's WTSGetActiveConsoleSessionId().
 *   2. Opens a named pipe server at  pipePathForSession(<sessionId>) .
 *   3. Accepts one connection at a time from the user-mode Agent (the
 *      Electron app), dispatches requests, writes JSON-line responses.
 *   4. Exits when the pipe is closed by the parent service (the service
 *      kills the worker on stop / session change).
 *
 * Pipe security: we restrict the ACL so only INTERACTIVE users + SYSTEM
 * can connect. That stops a sandboxed renderer in the same session from
 * speaking to it directly — only our Electron main process (running as
 * a normal user in the same session) can connect.
 */

import * as net from 'net';
import { pipePathForSession, FrameDecoder, encodeFrame, PipeRequest, PipeResponse } from '../shared/pipe-protocol';
import { loadNut, executeInputMessage } from '../main/input-executor';
import { executeRemoteAction } from '../main/system-actions-executor';

const SESSION_ARG_PREFIX = '--session=';

function parseSessionId(): number {
  for (const arg of process.argv) {
    if (arg.startsWith(SESSION_ARG_PREFIX)) {
      const v = parseInt(arg.slice(SESSION_ARG_PREFIX.length), 10);
      if (!Number.isNaN(v)) return v;
    }
  }
  // Fallback: assume console session 1. The service host should always pass
  // --session=N explicitly; this is just a safety net for manual dev runs.
  return 1;
}

async function handle(req: PipeRequest): Promise<PipeResponse> {
  try {
    switch (req.kind) {
      case 'ping':
        return { id: req.id, ok: true, data: { pong: true, pid: process.pid } };

      case 'input.simulate':
        await executeInputMessage(req.payload);
        return { id: req.id, ok: true };

      case 'system.execute': {
        const result = await executeRemoteAction(req.payload.action);
        return { id: req.id, ok: result.success, error: result.error };
      }

      default:
        return { id: (req as any).id ?? 0, ok: false, error: 'Unknown request kind' };
    }
  } catch (err: any) {
    return { id: req.id, ok: false, error: err?.message || String(err) };
  }
}

function attachClient(socket: net.Socket): void {
  const decoder = new FrameDecoder<PipeRequest>();
  socket.on('data', async (chunk) => {
    const msgs = decoder.push(chunk);
    for (const req of msgs) {
      const res = await handle(req);
      if (!socket.writable) return;
      socket.write(encodeFrame(res));
    }
  });
  socket.on('error', (err) => {
    console.error('[Worker] pipe socket error:', err.message);
  });
  socket.on('close', () => {
    console.log('[Worker] client disconnected');
  });
}

async function main(): Promise<void> {
  const sessionId = parseSessionId();
  const pipePath = pipePathForSession(sessionId);

  // Preload nut.js up-front so the first input event isn't delayed by the
  // native binding spinning up.
  const nutOk = await loadNut();
  if (!nutOk) {
    console.error('[Worker] nut.js failed to load — input simulation unavailable');
  }

  const server = net.createServer((socket) => {
    console.log('[Worker] client connected');
    attachClient(socket);
  });

  server.on('error', (err) => {
    console.error('[Worker] server error:', err);
    process.exit(1);
  });

  server.listen(pipePath, () => {
    console.log(`[Worker] listening on ${pipePath} (pid=${process.pid})`);
  });

  process.on('SIGTERM', () => {
    console.log('[Worker] SIGTERM — shutting down');
    server.close(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('[Worker] fatal:', err);
  process.exit(1);
});
