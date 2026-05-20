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
/** Secondary pipe carrying GDI screen captures from the worker so we can
 *  keep streaming after the user locks the workstation (Chromium's
 *  desktopCapturer is bound to the user's `winsta0\\default` desktop and
 *  goes blank on the secure Winlogon desktop). Binary frame layout, see
 *  `shared/video-pipe-protocol.ts`. */
export const VIDEO_PIPE_NAME_PREFIX = 'titan-xt-video';

export function pipePathForSession(sessionId: number): string {
  return `\\\\.\\pipe\\${PIPE_NAME_PREFIX}-${sessionId}`;
}

export function videoPipePathForSession(sessionId: number): string {
  return `\\\\.\\pipe\\${VIDEO_PIPE_NAME_PREFIX}-${sessionId}`;
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

// === Server-push events (worker → agent) ===
// The worker pushes events as JSON-line frames with id=0 so the agent's
// pipe client can distinguish them from request responses. The current
// event vocabulary is small — extend the union when adding new ones.
export interface PipeEvent {
  id: 0;
  event: 'desktop';
  /** Active input desktop name as reported by GetUserObjectInformation.
   *  Common values: "Default" (normal user desktop), "Winlogon" (lock
   *  screen / UAC dim screen / Ctrl+Alt+Del). */
  desktop: string;
}

/** Type guard — distinguishes a server-push event from a request response. */
export function isPipeEvent(msg: any): msg is PipeEvent {
  return !!msg && msg.id === 0 && typeof msg.event === 'string';
}

// === Framing helpers ===

export function encodeFrame(msg: PipeRequest | PipeResponse | PipeEvent): Buffer {
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
