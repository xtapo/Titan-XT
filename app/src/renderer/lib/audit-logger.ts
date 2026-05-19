/**
 * Audit logger — thin renderer-side wrapper around the main-process audit
 * journal. Every meaningful event in a session funnels through `log()` and
 * lands in the local JSONL file via IPC.
 *
 * Usage from anywhere in the renderer:
 *
 *   import { auditLog } from '../lib/audit-logger';
 *   auditLog('session-start', { partnerId, partnerName, role: 'host' });
 *
 * The logger is fail-soft: if the IPC bridge is missing (e.g. unit-test
 * harness, web-viewer build) calls become no-ops instead of throwing.
 */

import type { AuditEvent, AuditEventType, AuditRole } from '../../shared/audit';

interface LogContext {
  /** Force a specific role; defaults to whatever `setActiveSession` recorded. */
  role?: AuditRole;
  partnerId?: string;
  partnerName?: string;
  details?: Record<string, string | number | boolean>;
  severity?: 'info' | 'warn' | 'critical';
}

interface ActiveSession {
  sessionId: string;
  role: AuditRole;
  partnerId: string;
  partnerName: string;
}

let active: ActiveSession | null = null;

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Mark the current session — subsequent `auditLog()` calls inherit role +
 * partner from this. Call on session-start; clear on session-end.
 */
export function setActiveAuditSession(session: ActiveSession | null): void {
  active = session;
}

export function getActiveAuditSessionId(): string {
  return active?.sessionId || '';
}

/**
 * Log a single event. Best-effort — failures don't propagate. Returns the
 * promise so callers can await it during tests, but production callers
 * should fire-and-forget.
 */
export async function auditLog(
  type: AuditEventType,
  message: string,
  ctx: LogContext = {},
): Promise<void> {
  const api = (window as any).titanAPI?.audit;
  if (!api?.append) return;

  const role: AuditRole = ctx.role || active?.role || 'host';
  const event: AuditEvent = {
    id: genId(),
    timestamp: Date.now(),
    role,
    sessionId: active?.sessionId || '',
    type,
    message,
    partnerId: ctx.partnerId ?? active?.partnerId,
    partnerName: ctx.partnerName ?? active?.partnerName,
    details: ctx.details,
    severity: ctx.severity || 'info',
  };

  try {
    await api.append(event);
  } catch (err) {
    // Never let audit failures take a session down.
    console.warn('[Audit] append failed:', err);
  }
}
