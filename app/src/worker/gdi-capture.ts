/**
 * gdi-capture — synchronous GDI BitBlt capture used by the Worker to keep
 * streaming through the lock screen.
 *
 * Why GDI and not Desktop Duplication / WGC: we need a path that works
 * on `winsta0\winlogon` (the secure desktop the user lands on after
 * locking). Desktop Duplication has historically refused that desktop
 * without extra cooperation; GDI BitBlt off `GetDC(NULL)` works as long
 * as the calling thread is attached to the input desktop (which we
 * already do via `desktop-attach.ts`).
 *
 * Trade-offs we accept here:
 *   - GDI capture caps around ~25-30 fps on modern hardware; we throttle
 *     ourselves to 10 fps because the lock screen is mostly static and
 *     we'd rather save bandwidth + CPU.
 *   - Hardware cursor is NOT included by BitBlt. We composite it with a
 *     follow-up GetCursorInfo + DrawIconEx pass so the viewer can actually
 *     see where the host's pointer is.
 *   - We always downscale to a fixed target before pushing onto the pipe
 *     (default 1280×720). At 1280×720 BGRA = 3.5 MB/frame * 10 fps = 35
 *     MB/s on a local pipe — fine. Pushing native 1080p would be ~80 MB/s.
 */

import koffi from 'koffi';
import { encodeVideoFrame, PixelFormat, VideoFrame } from '../shared/video-pipe-protocol';

let bound = false;

let user32: any = null;
let gdi32: any = null;

let GetDC: any = null;
let ReleaseDC: any = null;
let CreateCompatibleDC: any = null;
let CreateCompatibleBitmap: any = null;
let CreateDIBSection: any = null;
let SelectObject: any = null;
let DeleteObject: any = null;
let DeleteDC: any = null;
let BitBlt: any = null;
let StretchBlt: any = null;
let SetStretchBltMode: any = null;
let GetSystemMetrics: any = null;
let GetCursorInfo: any = null;
let CopyIcon: any = null;
let GetIconInfo: any = null;
let DrawIconEx: any = null;
let DestroyIcon: any = null;

const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;

const SRCCOPY = 0x00cc0020;
const CAPTUREBLT = 0x40000000;
const HALFTONE = 4;

const CURSOR_SHOWING = 0x00000001;
const DI_NORMAL = 0x0003;

const CURSORINFO = koffi.struct('CURSORINFO', {
  cbSize: 'uint32',
  flags: 'uint32',
  hCursor: 'void*',
  ptScreenPos_x: 'int32',
  ptScreenPos_y: 'int32',
});
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
const ICONINFO = koffi.struct('ICONINFO', {
  fIcon: 'int32',
  xHotspot: 'uint32',
  yHotspot: 'uint32',
  hbmMask: 'void*',
  hbmColor: 'void*',
});
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32',
  biWidth: 'int32',
  biHeight: 'int32',
  biPlanes: 'uint16',
  biBitCount: 'uint16',
  biCompression: 'uint32',
  biSizeImage: 'uint32',
  biXPelsPerMeter: 'int32',
  biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32',
  biClrImportant: 'uint32',
});
const BITMAPINFO = koffi.struct('BITMAPINFO', {
  bmiHeader: BITMAPINFOHEADER,
  // bmiColors[1] inline — koffi can't express variable arrays, but BI_RGB at
  // 32bpp ignores the palette so a single placeholder entry is enough.
  bmiColors: koffi.array('uint32', 1),
});

function bind(): boolean {
  if (bound) return true;
  if (process.platform !== 'win32') return false;
  try {
    user32 = koffi.load('user32.dll');
    gdi32 = koffi.load('gdi32.dll');

    GetDC = user32.func('void* __stdcall GetDC(void*)');
    ReleaseDC = user32.func('int32 __stdcall ReleaseDC(void*, void*)');
    GetSystemMetrics = user32.func('int32 __stdcall GetSystemMetrics(int32)');
    GetCursorInfo = user32.func('int32 __stdcall GetCursorInfo(_Inout_ CURSORINFO*)');
    CopyIcon = user32.func('void* __stdcall CopyIcon(void*)');
    GetIconInfo = user32.func('int32 __stdcall GetIconInfo(void*, _Out_ ICONINFO*)');
    DrawIconEx = user32.func(
      'int32 __stdcall DrawIconEx(void*, int32, int32, void*, int32, int32, uint32, void*, uint32)'
    );
    DestroyIcon = user32.func('int32 __stdcall DestroyIcon(void*)');

    CreateCompatibleDC = gdi32.func('void* __stdcall CreateCompatibleDC(void*)');
    CreateCompatibleBitmap = gdi32.func('void* __stdcall CreateCompatibleBitmap(void*, int32, int32)');
    CreateDIBSection = gdi32.func(
      'void* __stdcall CreateDIBSection(void*, _In_ BITMAPINFO*, uint32, _Out_ void**, void*, uint32)'
    );
    SelectObject = gdi32.func('void* __stdcall SelectObject(void*, void*)');
    DeleteObject = gdi32.func('int32 __stdcall DeleteObject(void*)');
    DeleteDC = gdi32.func('int32 __stdcall DeleteDC(void*)');
    BitBlt = gdi32.func('int32 __stdcall BitBlt(void*, int32, int32, int32, int32, void*, int32, int32, uint32)');
    StretchBlt = gdi32.func(
      'int32 __stdcall StretchBlt(void*, int32, int32, int32, int32, void*, int32, int32, int32, int32, uint32)'
    );
    SetStretchBltMode = gdi32.func('int32 __stdcall SetStretchBltMode(void*, int32)');

    bound = true;
    return true;
  } catch (err) {
    console.error('[GdiCapture] failed to bind win32:', (err as Error).message);
    return false;
  }
}

export interface CaptureOptions {
  /** Target width in pixels — output frames are scaled to fit this box. */
  targetWidth: number;
  /** Target height in pixels. */
  targetHeight: number;
}

interface CaptureResources {
  screenDC: any;
  memDC: any;
  scaleDC: any;
  fullBitmap: any;
  scaleBitmap: any;
  scalePixels: any; // pointer to the DIB pixel buffer
  scaleStride: number;
  fullW: number;
  fullH: number;
  originX: number;
  originY: number;
  scaleW: number;
  scaleH: number;
}

let resources: CaptureResources | null = null;

function teardown(): void {
  if (!resources) return;
  try { SelectObject(resources.memDC, resources.fullBitmap); } catch { /* ignore */ }
  try { DeleteObject(resources.fullBitmap); } catch { /* ignore */ }
  try { DeleteObject(resources.scaleBitmap); } catch { /* ignore */ }
  try { DeleteDC(resources.memDC); } catch { /* ignore */ }
  try { DeleteDC(resources.scaleDC); } catch { /* ignore */ }
  try { ReleaseDC(null, resources.screenDC); } catch { /* ignore */ }
  resources = null;
}

function ensureResources(opts: CaptureOptions): CaptureResources | null {
  if (!bind()) return null;

  // Check for screen-size changes (resolution swap, monitor hotplug) and
  // tear down so we re-create at the new size.
  const fullW = GetSystemMetrics(SM_CXVIRTUALSCREEN) || 1920;
  const fullH = GetSystemMetrics(SM_CYVIRTUALSCREEN) || 1080;
  const originX = GetSystemMetrics(SM_XVIRTUALSCREEN) || 0;
  const originY = GetSystemMetrics(SM_YVIRTUALSCREEN) || 0;

  // Fit (targetWidth × targetHeight) preserving aspect.
  const aspect = fullW / fullH;
  let scaleW = opts.targetWidth;
  let scaleH = Math.round(scaleW / aspect);
  if (scaleH > opts.targetHeight) {
    scaleH = opts.targetHeight;
    scaleW = Math.round(scaleH * aspect);
  }
  // Keep stride dword-aligned — always true for 32bpp BGRA but be explicit.
  scaleW = scaleW & ~1;
  scaleH = scaleH & ~1;

  if (
    resources &&
    resources.fullW === fullW &&
    resources.fullH === fullH &&
    resources.scaleW === scaleW &&
    resources.scaleH === scaleH
  ) {
    return resources;
  }
  if (resources) teardown();

  const screenDC = GetDC(null);
  if (!screenDC) return null;

  const memDC = CreateCompatibleDC(screenDC);
  const scaleDC = CreateCompatibleDC(screenDC);
  if (!memDC || !scaleDC) {
    if (memDC) DeleteDC(memDC);
    if (scaleDC) DeleteDC(scaleDC);
    ReleaseDC(null, screenDC);
    return null;
  }

  const fullBitmap = CreateCompatibleBitmap(screenDC, fullW, fullH);
  if (!fullBitmap) {
    DeleteDC(memDC);
    DeleteDC(scaleDC);
    ReleaseDC(null, screenDC);
    return null;
  }

  // DIB section for the scaled output: gives us a CPU-mapped pixel buffer
  // we can read directly without a GetDIBits round-trip per frame.
  const bmi: any = {
    bmiHeader: {
      biSize: koffi.sizeof(BITMAPINFOHEADER),
      biWidth: scaleW,
      biHeight: -scaleH, // top-down
      biPlanes: 1,
      biBitCount: 32,
      biCompression: 0, // BI_RGB
      biSizeImage: 0,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    },
    bmiColors: [0],
  };
  const pixelsOut: any = [null];
  const scaleBitmap = CreateDIBSection(scaleDC, bmi, 0, pixelsOut, null, 0);
  if (!scaleBitmap || !pixelsOut[0]) {
    DeleteObject(fullBitmap);
    DeleteDC(memDC);
    DeleteDC(scaleDC);
    ReleaseDC(null, screenDC);
    return null;
  }

  SelectObject(memDC, fullBitmap);
  SelectObject(scaleDC, scaleBitmap);
  SetStretchBltMode(scaleDC, HALFTONE);

  resources = {
    screenDC,
    memDC,
    scaleDC,
    fullBitmap,
    scaleBitmap,
    scalePixels: pixelsOut[0],
    scaleStride: scaleW * 4,
    fullW,
    fullH,
    originX,
    originY,
    scaleW,
    scaleH,
  };
  return resources;
}

/**
 * Composite the system cursor onto the source DC at the cursor's screen
 * position. BitBlt does not include the cursor, so without this the viewer
 * sees a frozen pointer.
 */
function compositeCursor(memDC: any, originX: number, originY: number): void {
  try {
    const ci: any = { cbSize: koffi.sizeof(CURSORINFO), flags: 0, hCursor: null, ptScreenPos_x: 0, ptScreenPos_y: 0 };
    if (!GetCursorInfo(ci) || (ci.flags & CURSOR_SHOWING) === 0 || !ci.hCursor) return;

    // Resolve the hotspot so the drawn cursor lines up with where Windows
    // reports it.
    const copy = CopyIcon(ci.hCursor);
    if (!copy) return;
    const info: any = { fIcon: 0, xHotspot: 0, yHotspot: 0, hbmMask: null, hbmColor: null };
    let xHot = 0, yHot = 0;
    if (GetIconInfo(copy, info)) {
      xHot = info.xHotspot;
      yHot = info.yHotspot;
      if (info.hbmMask) DeleteObject(info.hbmMask);
      if (info.hbmColor) DeleteObject(info.hbmColor);
    }
    const drawX = ci.ptScreenPos_x - originX - xHot;
    const drawY = ci.ptScreenPos_y - originY - yHot;
    DrawIconEx(memDC, drawX, drawY, copy, 0, 0, 0, null, DI_NORMAL);
    DestroyIcon(copy);
  } catch {
    // best-effort cursor compositing — never break frame capture
  }
}

/**
 * Capture one frame and return it encoded as a wire-ready buffer (header +
 * BGRA payload). Returns null if capture failed.
 */
export function captureFrame(opts: CaptureOptions): Buffer | null {
  const r = ensureResources(opts);
  if (!r) return null;

  // 1. Full-resolution BitBlt of the entire virtual screen into our memDC.
  if (!BitBlt(r.memDC, 0, 0, r.fullW, r.fullH, r.screenDC, r.originX, r.originY, SRCCOPY | CAPTUREBLT)) {
    return null;
  }
  compositeCursor(r.memDC, r.originX, r.originY);

  // 2. StretchBlt down to the target resolution. HALFTONE mode does a
  //    proper averaging downscale (vs the default fast nearest neighbor)
  //    so text stays readable.
  if (!StretchBlt(
    r.scaleDC,
    0, 0, r.scaleW, r.scaleH,
    r.memDC,
    0, 0, r.fullW, r.fullH,
    SRCCOPY,
  )) {
    return null;
  }

  // 3. Read DIB pixels straight off the mapped pointer. CreateDIBSection
  //    gave us a top-down BGRA buffer of size scaleStride*scaleH.
  const byteLen = r.scaleStride * r.scaleH;
  const arr = koffi.decode(r.scalePixels, 'uint8', byteLen) as Uint8Array;
  // koffi.decode returns a Uint8Array view; copy to a Node Buffer so the
  // memory survives the next encode call.
  const payload = Buffer.from(arr);

  const frame: VideoFrame = {
    width: r.scaleW,
    height: r.scaleH,
    format: PixelFormat.BGRA8,
    payload,
  };
  return encodeVideoFrame(frame);
}

export function disposeCapture(): void {
  teardown();
}
