// === Named-pipe protocol between Agent (Electron main) and the elevated
// SYSTEM Worker (input + system actions executor) ===
//
// Wire format: newline-delimited JSON. Each frame is one JSON object
// followed by '\n'. Both sides MUST flush after every newline.
//
// The Worker runs as LocalSystem in the active user session, so it can
// drive UAC-elevated foreground apps without UIPI blocking input.
// The Agent (the visible Electron process) forwards every input/system
// request here; if the pipe is not connected, the Agent falls back to
// executing in-process (which works for non-elevated targets).

import type { MouseMessage, KeyMessage, RemoteActionId } from './protocol';

/** Pipe name. {sessionId} is filled in by the worker so each interactive
 *  session has its own pipe and we never cross sessions. */
export const PIPE_NAME_PREFIX = 'titan-xt-input';

export function pipePathForSession(sessionId: number): string {
  return `\\\\.\\pipe\\${PIPE_NAME_PREFIX}-${sessionId}`;
}

// === Request kinds ===

export type RequestKind =
  | 'ping'
  | 'input.simulate'
  | 'system.execute';

export interface BaseRequest {
  id: number;
  kind: RequestKind;
}

export interface PingRequest extends BaseRequest {
  kind: 'ping';
}

export interface InputSimulateRequest extends BaseRequest {
  kind: 'input.simulate';
  payload: MouseMessage | KeyMessage;
}

export interface SystemExecuteRequest extends BaseRequest {
  kind: 'system.execute';
  payload: { action: RemoteActionId };
}

export type PipeRequest = PingRequest | InputSimulateRequest | SystemExecuteRequest;

// === Response ===

export interface PipeResponse {
  id: number;
  ok: boolean;
  data?: any;
  error?: string;
}

// === Framing helpers ===

export function encodeFrame(msg: PipeRequest | PipeResponse): Buffer {
  return Buffer.from(JSON.stringify(msg) + '\n', 'utf8');
}

/** Stateful line splitter — feed Buffer chunks, get parsed messages. */
export class FrameDecoder<T = PipeRequest | PipeResponse> {
  private buf = '';

  push(chunk: Buffer): T[] {
    this.buf += chunk.toString('utf8');
    const out: T[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // drop malformed frame, keep the stream
      }
    }
    return out;
  }
}
