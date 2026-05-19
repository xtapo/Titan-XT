import { ipcMain, app, dialog, shell, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import { getStore } from './store';
import type { AuditEvent } from '../shared/audit';

/**
 * Audit log — append-only ring of session events stored on disk.
 *
 * Why a separate JSONL file rather than electron-store: audit logs grow
 * fast (every keystroke-relevant event during a multi-hour session) and a
 * single JSON blob would balloon and re-serialize on every append. JSONL
 * (one event per line) appends in O(1) and the file can be tailed by
 * external tools.
 *
 * Storage layout:
 *   <userData>/audit/audit.jsonl   — current append target
 *   <userData>/audit/audit-<ts>.jsonl  — rotated snapshots (>5 MB)
 *
 * The renderer never touches disk directly — IPC only.
 */

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB before rotate
const MAX_KEEP_FILES = 6;               // current + 5 rotated
// In-memory cap when reading back. UI is paginated; we don't want to load
// 50 MB of history into the renderer in one shot.
const READ_LIMIT = 2_000;

function auditDir(): string {
  return path.join(app.getPath('userData'), 'audit');
}

function currentFile(): string {
  return path.join(auditDir(), 'audit.jsonl');
}

function ensureDir(): void {
  const dir = auditDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function rotateIfNeeded(): void {
  const file = currentFile();
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size < MAX_FILE_BYTES) return;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(auditDir(), `audit-${ts}.jsonl`);
    fs.renameSync(file, dest);
    // Trim oldest snapshots so the audit dir doesn't grow unbounded.
    const snaps = fs
      .readdirSync(auditDir())
      .filter((f) => f.startsWith('audit-') && f.endsWith('.jsonl'))
      .sort();
    while (snaps.length > MAX_KEEP_FILES - 1) {
      const stale = snaps.shift();
      if (!stale) break;
      try {
        fs.unlinkSync(path.join(auditDir(), stale));
      } catch {
        // best-effort
      }
    }
  } catch (err) {
    console.warn('[Audit] rotate failed:', err);
  }
}

/**
 * Append a single event. Best-effort — failures are logged to stderr but
 * never thrown, so a disk-full condition can't take a session down.
 */
export function appendAuditEvent(event: AuditEvent): void {
  try {
    ensureDir();
    rotateIfNeeded();
    const line = JSON.stringify(event) + '\n';
    fs.appendFileSync(currentFile(), line, 'utf8');
  } catch (err) {
    console.warn('[Audit] append failed:', err);
  }
}

/**
 * Read the most recent N events, newest first. Walks the current file
 * backwards so we don't pay for parsing rotated archives unless the user
 * asks for them.
 */
export function readRecentAuditEvents(limit: number = READ_LIMIT): AuditEvent[] {
  try {
    const file = currentFile();
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    const slice = lines.slice(-limit);
    const events: AuditEvent[] = [];
    for (const line of slice) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // Skip malformed lines rather than failing the whole read.
      }
    }
    return events.reverse();
  } catch (err) {
    console.warn('[Audit] read failed:', err);
    return [];
  }
}

/**
 * Wipe the audit history. Triggered from the settings UI; the user is
 * responsible for confirmation. We keep the directory so future appends
 * just work.
 */
export function clearAuditEvents(): void {
  try {
    const dir = auditDir();
    if (!fs.existsSync(dir)) return;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'));
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        // best-effort
      }
    }
  } catch (err) {
    console.warn('[Audit] clear failed:', err);
  }
}

/**
 * Wire IPC. Called once at startup from agent.ts.
 *
 * The renderer logs events via `audit:append` and reads them back via
 * `audit:read`. `audit:export` lets the user save the current log to a
 * standalone .jsonl for compliance review.
 */
export function setupAudit(): void {
  // Renderer should respect this so behaviour matches the user's preference
  // even if a stale renderer holds onto an enabled flag.
  ipcMain.handle('audit:isEnabled', () => {
    const store = getStore();
    const settings = store.get('settings', {}) as any;
    return settings?.auditEnabled !== false; // default: ON
  });

  ipcMain.handle('audit:append', (_event, payload: AuditEvent) => {
    if (!payload || typeof payload !== 'object') return { success: false };
    const store = getStore();
    const settings = store.get('settings', {}) as any;
    if (settings?.auditEnabled === false) return { success: false, disabled: true };
    appendAuditEvent(payload);
    return { success: true };
  });

  ipcMain.handle('audit:read', (_event, limit?: number) => {
    return readRecentAuditEvents(typeof limit === 'number' ? limit : undefined);
  });

  ipcMain.handle('audit:clear', () => {
    clearAuditEvents();
    return { success: true };
  });

  ipcMain.handle('audit:export', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts = {
      title: 'Xuất nhật ký kiểm toán',
      defaultPath: `titan-xt-audit-${Date.now()}.jsonl`,
      filters: [{ name: 'Audit log', extensions: ['jsonl'] }],
    };
    const result = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts);
    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }
    try {
      const events = readRecentAuditEvents();
      // Reverse back to chronological order on export — easier to diff.
      const lines = [...events].reverse().map((e) => JSON.stringify(e)).join('\n');
      fs.writeFileSync(result.filePath, lines, 'utf8');
      return { success: true, path: result.filePath };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('audit:openFolder', async () => {
    try {
      ensureDir();
      await shell.openPath(auditDir());
      return { success: true, path: auditDir() };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });
}
