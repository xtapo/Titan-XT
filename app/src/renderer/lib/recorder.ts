/**
 * Session Recorder — viewer-side capture of the remote video stream into a
 * .webm file on disk. Uses MediaRecorder + a streaming IPC so that long
 * recordings don't pile up as one giant Blob in renderer memory.
 *
 * Each `dataavailable` event is shipped to main as base64 and appended to
 * the open file. On stop, main closes the file and returns the final path.
 */

const TIMESLICE_MS = 2_000;

const PREFERRED_MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp8',
  'video/webm',
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const t of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = reader.result as string;
      // Strip "data:<mime>;base64," prefix; keep just the payload.
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.substring(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopping';

export interface RecorderListeners {
  onStateChange?: (state: RecorderState) => void;
  onElapsed?: (seconds: number) => void;
  onError?: (message: string) => void;
  onSaved?: (filePath: string) => void;
}

export class SessionRecorder {
  private recorder: MediaRecorder | null = null;
  private recordingId: string | null = null;
  private listeners: RecorderListeners;
  private state: RecorderState = 'idle';
  private startedAt: number = 0;
  private elapsedTimer: number | null = null;
  // Serializes async chunk uploads so they arrive at main in order even if
  // FileReader / IPC latency varies between events.
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(listeners: RecorderListeners = {}) {
    this.listeners = listeners;
  }

  get currentState(): RecorderState {
    return this.state;
  }

  get isRecording(): boolean {
    return this.state === 'recording' || this.state === 'starting';
  }

  /**
   * Begin recording the given MediaStream. Returns false when the browser
   * doesn't support MediaRecorder, the IPC isn't available, or main refused
   * to open a destination file.
   */
  async start(stream: MediaStream, partnerId: string): Promise<boolean> {
    if (this.state !== 'idle') return false;
    if (!stream || stream.getVideoTracks().length === 0) {
      this.listeners.onError?.('Chưa có luồng video để ghi');
      return false;
    }
    const api = (window as any).titanAPI?.recording;
    if (!api?.start || !api?.appendChunk || !api?.stop) {
      this.listeners.onError?.('Bản dựng này chưa hỗ trợ ghi phiên');
      return false;
    }

    const mimeType = pickMimeType();
    if (!mimeType) {
      this.listeners.onError?.('Trình duyệt không hỗ trợ MediaRecorder/webm');
      return false;
    }

    this.setState('starting');

    let openResult: { id: string; path: string } | null = null;
    try {
      openResult = await api.start({
        partnerId,
        extension: 'webm',
        mimeType,
      });
    } catch (err: any) {
      this.listeners.onError?.(err?.message || 'Không mở được file ghi');
      this.setState('idle');
      return false;
    }
    if (!openResult?.id) {
      this.listeners.onError?.('Không mở được file ghi');
      this.setState('idle');
      return false;
    }
    this.recordingId = openResult.id;

    try {
      this.recorder = new MediaRecorder(stream, { mimeType });
    } catch (err: any) {
      this.listeners.onError?.(err?.message || 'Không khởi tạo được MediaRecorder');
      // Roll back the file we just opened so we don't leave a 0-byte stub.
      await api.stop({ id: this.recordingId, discard: true }).catch(() => {});
      this.recordingId = null;
      this.setState('idle');
      return false;
    }

    this.recorder.ondataavailable = (e: BlobEvent) => {
      if (!e.data || e.data.size === 0) return;
      const id = this.recordingId;
      if (!id) return;
      // Queue the upload so chunks land in order.
      this.writeQueue = this.writeQueue
        .then(() => blobToBase64(e.data))
        .then((b64) => api.appendChunk({ id, data: b64 }))
        .catch((err) => {
          console.warn('[Recorder] chunk upload failed:', err);
        });
    };

    this.recorder.onerror = (event: Event) => {
      const err = (event as any).error;
      console.error('[Recorder] MediaRecorder error:', err);
      this.listeners.onError?.(err?.message || 'Lỗi ghi phiên');
      this.cleanupAndDiscard().catch(() => {});
    };

    this.recorder.onstop = () => {
      // Final flush handled by stop(); nothing to do here.
    };

    try {
      this.recorder.start(TIMESLICE_MS);
    } catch (err: any) {
      this.listeners.onError?.(err?.message || 'Không bắt đầu được ghi');
      await api.stop({ id: this.recordingId, discard: true }).catch(() => {});
      this.recordingId = null;
      this.recorder = null;
      this.setState('idle');
      return false;
    }

    this.startedAt = Date.now();
    this.startElapsedTicker();
    this.setState('recording');
    return true;
  }

  /**
   * Stop recording and finalize the file. Resolves with the saved path or
   * null on failure. Safe to call when not recording.
   */
  async stop(): Promise<string | null> {
    if (this.state !== 'recording' || !this.recorder || !this.recordingId) {
      return null;
    }

    this.setState('stopping');
    this.stopElapsedTicker();

    const id = this.recordingId;
    const api = (window as any).titanAPI?.recording;

    // Wait for the MediaRecorder to flush its remaining buffer.
    const stopped = new Promise<void>((resolve) => {
      const rec = this.recorder!;
      rec.addEventListener('stop', () => resolve(), { once: true });
      try {
        rec.stop();
      } catch {
        resolve();
      }
    });

    await stopped;
    // Drain any pending chunk uploads queued before stop().
    await this.writeQueue.catch(() => {});

    let savedPath: string | null = null;
    try {
      const result = await api.stop({ id });
      if (result?.success && result.path) savedPath = result.path;
    } catch (err) {
      console.warn('[Recorder] stop failed:', err);
    }

    this.recorder = null;
    this.recordingId = null;
    this.setState('idle');

    if (savedPath) {
      this.listeners.onSaved?.(savedPath);
    } else {
      this.listeners.onError?.('Không lưu được file ghi');
    }
    return savedPath;
  }

  /**
   * Force-stop without saving. Used on unrecoverable errors and on session
   * teardown so we don't leave the file handle dangling on main.
   */
  async cleanupAndDiscard(): Promise<void> {
    this.stopElapsedTicker();
    const api = (window as any).titanAPI?.recording;
    const id = this.recordingId;
    try {
      this.recorder?.stop();
    } catch {
      /* ignore */
    }
    this.recorder = null;
    this.recordingId = null;
    if (id && api?.stop) {
      await api.stop({ id, discard: true }).catch(() => {});
    }
    this.setState('idle');
  }

  private setState(state: RecorderState): void {
    if (this.state === state) return;
    this.state = state;
    this.listeners.onStateChange?.(state);
  }

  private startElapsedTicker(): void {
    this.stopElapsedTicker();
    this.elapsedTimer = window.setInterval(() => {
      const seconds = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
      this.listeners.onElapsed?.(seconds);
    }, 500);
  }

  private stopElapsedTicker(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }
}

export function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
