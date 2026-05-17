import { ipcMain, app, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { getStore } from './store';
import { AppSettings } from '../shared/types';

/**
 * Session Recording — main-process file sink.
 *
 * The renderer's MediaRecorder fires `dataavailable` every few seconds with
 * a webm blob. Renderer base64-encodes each chunk and ships it over IPC;
 * main appends it to a write stream and only closes the file on stop.
 *
 * Keeping the bytes out of renderer memory is the whole point — long
 * recordings would otherwise pile up as one huge Blob and OOM the tab.
 */

interface OpenRecording {
  id: string;
  filePath: string;
  stream: fs.WriteStream;
  startedAt: number;
  /**
   * Serialized append queue. Append IPC calls resolve in the order they
   * arrive, but the stream.write callback is async, so we daisy-chain writes
   * to keep the on-disk byte order matching the chunk order.
   */
  writeQueue: Promise<void>;
}

const open: Map<string, OpenRecording> = new Map();

function resolveRecordingsDir(): string {
  const settings = getStore().get('settings') as AppSettings | undefined;
  const configured = settings?.downloadFolder?.trim();
  const base = configured && configured.length > 0
    ? configured
    : path.join(app.getPath('downloads'), 'Titan-XT');
  const dir = path.join(base, 'Recordings');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Build a filesystem-safe filename: <yyyy-mm-dd_hh-mm-ss>_<partner>.<ext>.
 * Strips characters that NTFS rejects so partner ids with stray formatting
 * don't break the open call.
 */
function buildFileName(partnerId: string, extension: string): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const cleanPartner = (partnerId || 'session')
    .replace(/[^A-Za-z0-9_-]+/g, '')
    .substring(0, 32) || 'session';
  const cleanExt = extension.replace(/[^a-z0-9]+/gi, '').toLowerCase() || 'webm';
  return `titan-xt_${stamp}_${cleanPartner}.${cleanExt}`;
}

function appendChunk(rec: OpenRecording, base64: string): Promise<void> {
  rec.writeQueue = rec.writeQueue.then(
    () => new Promise<void>((resolve, reject) => {
      try {
        const buf = Buffer.from(base64, 'base64');
        rec.stream.write(buf, (err) => {
          if (err) reject(err);
          else resolve();
        });
      } catch (err) {
        reject(err as Error);
      }
    }),
  );
  return rec.writeQueue;
}

function closeStream(rec: OpenRecording): Promise<void> {
  return new Promise((resolve) => {
    rec.stream.end(() => resolve());
  });
}

export function setupRecording(): void {
  ipcMain.handle('recording:start', async (_event, opts: { partnerId?: string; extension?: string }) => {
    const dir = resolveRecordingsDir();
    const fileName = buildFileName(opts?.partnerId || '', opts?.extension || 'webm');
    const filePath = path.join(dir, fileName);

    let stream: fs.WriteStream;
    try {
      stream = fs.createWriteStream(filePath, { flags: 'w' });
      await new Promise<void>((resolve, reject) => {
        stream.once('open', () => resolve());
        stream.once('error', (err) => reject(err));
      });
    } catch (err: any) {
      console.error('[Recording] open failed:', err);
      throw new Error(err?.message || 'Không mở được file ghi');
    }

    const id = `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    open.set(id, {
      id,
      filePath,
      stream,
      startedAt: Date.now(),
      writeQueue: Promise.resolve(),
    });
    console.log(`[Recording] start id=${id} -> ${filePath}`);
    return { id, path: filePath };
  });

  ipcMain.handle('recording:appendChunk', async (_event, opts: { id: string; data: string }) => {
    const rec = open.get(opts?.id);
    if (!rec) return { success: false, error: 'Recording not open' };
    try {
      await appendChunk(rec, opts.data);
      return { success: true };
    } catch (err: any) {
      console.error('[Recording] append failed:', err);
      return { success: false, error: err?.message || 'append failed' };
    }
  });

  ipcMain.handle('recording:stop', async (_event, opts: { id: string; discard?: boolean }) => {
    const rec = open.get(opts?.id);
    if (!rec) return { success: false, error: 'Recording not open' };
    open.delete(rec.id);

    // Drain any queued chunk writes before closing the file. Otherwise the
    // tail of the recording is silently lost when stop() races appendChunk.
    try {
      await rec.writeQueue;
    } catch (err) {
      console.warn('[Recording] drain failed:', err);
    }
    await closeStream(rec);

    if (opts?.discard) {
      try {
        fs.unlinkSync(rec.filePath);
      } catch {
        /* ignore */
      }
      console.log(`[Recording] stop+discard id=${rec.id}`);
      return { success: true, path: null };
    }

    // Sanity check: a 0-byte file is useless. Treat that as failure so the
    // renderer can surface "not saved" rather than offering an empty .webm.
    try {
      const stats = fs.statSync(rec.filePath);
      if (stats.size === 0) {
        fs.unlinkSync(rec.filePath);
        return { success: false, error: 'Bản ghi rỗng' };
      }
    } catch {
      return { success: false, error: 'Không kiểm tra được file' };
    }

    console.log(`[Recording] stop id=${rec.id} path=${rec.filePath}`);
    return { success: true, path: rec.filePath };
  });

  ipcMain.handle('recording:openFolder', async () => {
    try {
      const dir = resolveRecordingsDir();
      // openPath gives a friendlier UX than showItemInFolder when the folder
      // is empty (no item to highlight).
      const result = await shell.openPath(dir);
      if (result) return { success: false, error: result };
      return { success: true, path: dir };
    } catch (err: any) {
      return { success: false, error: err?.message || 'open folder failed' };
    }
  });
}

/**
 * Force-close every open recording. Wired to app `before-quit` so a crash
 * during shutdown doesn't strand a dangling write stream.
 */
export async function closeAllRecordings(): Promise<void> {
  const all = Array.from(open.values());
  open.clear();
  await Promise.all(
    all.map(async (rec) => {
      try {
        await rec.writeQueue;
      } catch {
        /* ignore */
      }
      await closeStream(rec).catch(() => undefined);
    }),
  );
}
