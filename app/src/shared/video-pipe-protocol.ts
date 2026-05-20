/**
 * Binary frame protocol for the worker → agent video pipe.
 *
 * Each frame:
 *   bytes 0..3   magic "TXVF" (Titan-XT Video Frame)
 *   bytes 4..7   uint32 BE — width  (pixels)
 *   bytes 8..11  uint32 BE — height (pixels)
 *   byte  12     pixel format (0 = BGRA8 top-down, 1 = JPEG)
 *   byte  13     reserved (0)
 *   bytes 14..17 uint32 BE — payload byte length
 *   bytes 18..   payload
 *
 * Length-prefixed so a partial read at the pipe boundary doesn't desync
 * the stream — the decoder buffers until it has a full payload, regardless
 * of how Windows slices the chunks.
 */

export const VIDEO_FRAME_MAGIC = 0x54585646; // "TXVF"
export const VIDEO_HEADER_SIZE = 18;

export const enum PixelFormat {
  BGRA8 = 0,
  JPEG = 1,
}

export interface VideoFrame {
  width: number;
  height: number;
  format: PixelFormat;
  payload: Buffer;
}

export function encodeVideoFrame(frame: VideoFrame): Buffer {
  const header = Buffer.alloc(VIDEO_HEADER_SIZE);
  header.writeUInt32BE(VIDEO_FRAME_MAGIC, 0);
  header.writeUInt32BE(frame.width, 4);
  header.writeUInt32BE(frame.height, 8);
  header.writeUInt8(frame.format, 12);
  header.writeUInt8(0, 13);
  header.writeUInt32BE(frame.payload.length, 14);
  return Buffer.concat([header, frame.payload]);
}

/**
 * Stateful decoder. Feed pipe chunks; pull complete frames out. Drops
 * garbage byte-by-byte until it finds the magic so a corrupt prefix can
 * never desync us permanently.
 */
export class VideoFrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): VideoFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: VideoFrame[] = [];

    while (this.buf.length >= VIDEO_HEADER_SIZE) {
      const magic = this.buf.readUInt32BE(0);
      if (magic !== VIDEO_FRAME_MAGIC) {
        // Resync: drop one byte and retry. In practice this never happens
        // unless the pipe got into a bad state.
        this.buf = this.buf.slice(1);
        continue;
      }
      const width = this.buf.readUInt32BE(4);
      const height = this.buf.readUInt32BE(8);
      const format = this.buf.readUInt8(12) as PixelFormat;
      const length = this.buf.readUInt32BE(14);

      // Sanity bounds — refuse absurd sizes that would OOM us.
      if (width === 0 || height === 0 || length === 0 || length > 64 * 1024 * 1024) {
        this.buf = this.buf.slice(1);
        continue;
      }

      const total = VIDEO_HEADER_SIZE + length;
      if (this.buf.length < total) break; // wait for more bytes

      const payload = Buffer.from(this.buf.slice(VIDEO_HEADER_SIZE, total));
      this.buf = this.buf.slice(total);
      out.push({ width, height, format, payload });
    }
    return out;
  }
}
