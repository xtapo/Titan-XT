// === Audit Log Types ===
//
// Records every meaningful event in a remote-support session so the local
// host has a tamper-evident trail of "what did the technician do on my
// machine". Stored locally on the host's machine only (never sent to the
// signal server). Surfaced via Settings → Audit Log.

export type AuditEventType =
  | 'session-start'
  | 'session-end'
  | 'auth-success'
  | 'auth-failure'
  | 'control-lock'
  | 'control-unlock'
  | 'mode-change'
  | 'monitor-switch'
  | 'quality-change'
  | 'codec-change'
  | 'remote-action'
  | 'file-sent'
  | 'file-received'
  | 'clipboard-sync'
  | 'annotation-clear'
  | 'wallpaper-toggle'
  | 'recording-start'
  | 'recording-stop';

export type AuditRole = 'host' | 'viewer';

export interface AuditEvent {
  /** Stable per-event id (timestamp + random suffix). */
  id: string;
  /** Unix ms timestamp when the event occurred. */
  timestamp: number;
  /** Which role logged this — host machines log host events, viewers log viewer events. */
  role: AuditRole;
  /** Session id this event belongs to (groups events for replay). */
  sessionId: string;
  /** Event category. */
  type: AuditEventType;
  /** Short human-readable description shown in the audit list. */
  message: string;
  /** Partner machine id (the other side of the session). */
  partnerId?: string;
  /** Partner display name when known. */
  partnerName?: string;
  /** Free-form extra context (file name, action id, etc.). Best-effort. */
  details?: Record<string, string | number | boolean>;
  /** Severity hint for the UI: info (default) / warn / critical. */
  severity?: 'info' | 'warn' | 'critical';
}
