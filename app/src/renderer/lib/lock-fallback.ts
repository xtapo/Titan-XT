/**
 * lock-fallback — viewer-side companion to the SYSTEM worker's GDI capture.
 *
 * The agent (Electron main) tells us when the host has switched to the
 * Winlogon / lock screen / UAC dim screen via `lockscreen:state` and pushes
 * raw BGRA frames over `lockscreen:frame`. We:
 *
 *   1. Paint the freshest frame into a hidden canvas at the host-reported
 *      resolution.
 *   2. Use canvas.captureStream() to lift it into a MediaStreamTrack.
 *   3. Swap that onto the existing RTCRtpSender via PeerConnection.replaceVideoTrack
 *      — the viewer sees no black gap, only a picture switch.
 *
 * When the host comes back to the normal Default desktop, we restore the
 * previous desktopCapturer track so we get back full-resolution / full-fps
 * capture.
 *
 * This module lives entirely in the host's renderer process (it's the
 * host that captures + streams; the viewer just receives the resulting
 * track over WebRTC like any other).
 */

import type { PeerConnection } from './webrtc';

interface LockFrame {
  width: number;
  height: number;
  format: number; // 0 = BGRA8, 1 = JPEG (only BGRA8 implemented today)
  payload: Uint8Array | Buffer;
}

const TARGET_FPS = 12;

let installed = false;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let imageData: ImageData | null = null;
let imageDataDims = { w: 0, h: 0 };
let captureStream: MediaStream | null = null;
let pendingFrame: LockFrame | null = null;
let currentPeer: PeerConnection | null = null;
// MediaStream we replaced when entering fallback so we can swap back on unlock.
let savedOriginalStream: MediaStream | null = null;
// True while the worker says we're on a non-Default desktop.
let inFallback = false;

function ensureCanvas(width: number, height: number): void {
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.left = '-99999px';
    canvas.style.top = '-99999px';
    canvas.width = width;
    canvas.height = height;
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d', { willReadFrequently: false, alpha: false });
  } else if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  if (!imageData || imageDataDims.w !== width || imageDataDims.h !== height) {
    imageData = ctx!.createImageData(width, height);
    imageDataDims = { w: width, h: height };
  }
}

/**
 * Paint a BGRA frame into the canvas. We swap B and R channels into the
 * canvas's RGBA buffer in-place; alpha is forced to 0xFF since the worker
 * only sends opaque captures.
 */
function paintBgra(frame: LockFrame): void {
  ensureCanvas(frame.width, frame.height);
  if (!ctx || !imageData) return;
  const src = frame.payload as Uint8Array;
  const dst = imageData.data;
  const total = frame.width * frame.height * 4;
  if (src.length < total) {
    // Truncated frame — skip rather than render junk.
    return;
  }
  for (let i = 0; i < total; i += 4) {
    dst[i] = src[i + 2];     // R = src.B
    dst[i + 1] = src[i + 1]; // G
    dst[i + 2] = src[i];     // B = src.R
    dst[i + 3] = 0xff;
  }
  ctx.putImageData(imageData, 0, 0);
}

function ensureCaptureStream(): MediaStream | null {
  if (captureStream) return captureStream;
  if (!canvas) return null;
  try {
    captureStream = (canvas as any).captureStream(TARGET_FPS) as MediaStream;
  } catch (err) {
    console.error('[LockFallback] canvas.captureStream failed:', err);
    return null;
  }
  return captureStream;
}

async function enterFallback(): Promise<void> {
  if (!currentPeer) return;
  // Pre-create a 1×1 canvas+stream so replaceTrack has something to bind to
  // even before the first frame arrives. The first paintBgra call will
  // resize it to the host's actual capture dimensions.
  ensureCanvas(2, 2);
  const stream = ensureCaptureStream();
  if (!stream) return;

  // Save the existing video track stream so we can restore it on unlock.
  // We don't stop it here — desktopCapturer keeps running in the background
  // and will simply be "blanked" until the user unlocks. Keeping it warm
  // means restore is a single replaceTrack with no re-prompt.
  try {
    const peerAny = currentPeer as any;
    const senders: RTCRtpSender[] = peerAny.pc?.getSenders?.() ?? [];
    const videoSender = senders.find((s) => s.track?.kind === 'video');
    if (videoSender?.track) {
      // Synthesize a stream from the existing track so replaceVideoTrack can
      // re-attach it later. MediaStream constructor accepts MediaStreamTracks
      // directly.
      savedOriginalStream = new MediaStream([videoSender.track]);
    }
  } catch (err) {
    console.warn('[LockFallback] could not snapshot original track:', err);
  }

  await currentPeer.replaceVideoTrack(stream);
  console.log('[LockFallback] switched to GDI fallback track');
}

async function leaveFallback(): Promise<void> {
  if (!currentPeer) return;
  if (savedOriginalStream) {
    try {
      await currentPeer.replaceVideoTrack(savedOriginalStream);
    } catch (err) {
      console.warn('[LockFallback] restore replaceTrack failed:', err);
    }
    savedOriginalStream = null;
  }
  // Don't tear down the canvas / stream — keep them around so a subsequent
  // lock doesn't pay the canvas re-init cost. We do clear the pending
  // frame so we don't redraw a stale image on the next entry.
  pendingFrame = null;
  console.log('[LockFallback] restored desktopCapturer track');
}

/**
 * Wire up the renderer side once the peer connection exists. Idempotent —
 * subsequent calls just rebind the active peer.
 */
export function installLockFallback(peer: PeerConnection | null): void {
  currentPeer = peer;
  if (installed) return;
  const api: any = (window as any).titanAPI?.lockscreen;
  if (!api) return; // Non-Windows build or older preload — silently skip
  installed = true;

  api.onFrame((frame: LockFrame) => {
    if (!inFallback) return; // discard frames that arrive after unlock
    pendingFrame = frame;
    if (frame.format !== 0) {
      // JPEG path is reserved for a future change — only BGRA today.
      return;
    }
    paintBgra(frame);
    // Make sure we've got a captureStream wired into the peer the moment
    // we have real pixels in the canvas.
    if (currentPeer) {
      const stream = ensureCaptureStream();
      if (stream && !sameStream(currentPeer, stream)) {
        // Already swapped during enterFallback() — but if a race somehow
        // left the sender on the old track, fix it.
        currentPeer.replaceVideoTrack(stream).catch((err) =>
          console.warn('[LockFallback] late replaceTrack failed:', err),
        );
      }
    }
  });

  api.onState(({ locked }: { locked: boolean }) => {
    if (locked && !inFallback) {
      inFallback = true;
      void enterFallback();
    } else if (!locked && inFallback) {
      inFallback = false;
      void leaveFallback();
    }
  });
}

/**
 * Update the peer that the fallback should target. Called whenever the
 * connection manager spins up a new PeerConnection (new session).
 */
export function setLockFallbackPeer(peer: PeerConnection | null): void {
  currentPeer = peer;
  // If the new peer arrives mid-lock, re-attach the canvas track to it.
  if (inFallback && peer) {
    const stream = ensureCaptureStream();
    if (stream) {
      peer.replaceVideoTrack(stream).catch((err) =>
        console.warn('[LockFallback] rebind replaceTrack failed:', err),
      );
    }
  }
}

function sameStream(peer: PeerConnection, stream: MediaStream): boolean {
  try {
    const peerAny = peer as any;
    const senders: RTCRtpSender[] = peerAny.pc?.getSenders?.() ?? [];
    const cur = senders.find((s) => s.track?.kind === 'video')?.track;
    return !!cur && cur === stream.getVideoTracks()[0];
  } catch {
    return false;
  }
}
