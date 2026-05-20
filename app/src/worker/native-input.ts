/**
 * native-input — synchronous SendInput / SetCursorPos bindings for the Worker.
 *
 * Why this exists: nut.js dispatches its input calls through libuv's worker
 * thread pool. Those threads are spawned with the worker process and stay
 * attached to whichever desktop the process started on (`winsta0\\default`).
 * Calling `SetThreadDesktop` on the Node main thread does NOT propagate to
 * the libuv pool, so when the user locks the workstation the OS switches
 * the input desktop to `winsta0\\winlogon` but nut.js still sends every
 * click and keystroke into Default — they go nowhere.
 *
 * The fix is to inject input via SendInput from the same thread we attach
 * to the input desktop on. This module wires SendInput + SetCursorPos
 * through koffi and does its work synchronously on the Node JS thread.
 */

import koffi from 'koffi';

let bound = false;
let user32: any = null;

let SendInput: any = null;
let SetCursorPos: any = null;
let GetSystemMetrics: any = null;
let MapVirtualKeyW: any = null;
let BlockInput: any = null;

// koffi struct types
let INPUT_TYPE: any = null;

// Sizes
const INPUT_SIZE = 40; // x64

// SendInput types
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

// MOUSEEVENTF_*
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x01000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;

// KEYEVENTF_*
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const KEYEVENTF_SCANCODE = 0x0008;
const KEYEVENTF_EXTENDEDKEY = 0x0001;

// MAPVK_*
const MAPVK_VK_TO_VSC = 0;

// SM_*
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

const WHEEL_DELTA = 120;

export function bindNativeInput(): boolean {
  if (bound) return true;
  if (process.platform !== 'win32') return false;
  try {
    user32 = koffi.load('user32.dll');

    // Pass INPUT as opaque blob — koffi unions are awkward, so we manually
    // pack the 40-byte INPUT layout. cbSize = sizeof(INPUT).
    SendInput = user32.func('uint32 __stdcall SendInput(uint32, _In_ void*, int32)');
    SetCursorPos = user32.func('int32 __stdcall SetCursorPos(int32, int32)');
    GetSystemMetrics = user32.func('int32 __stdcall GetSystemMetrics(int32)');
    MapVirtualKeyW = user32.func('uint32 __stdcall MapVirtualKeyW(uint32, uint32)');
    // BlockInput: only effective when called from a process with the same
    // desktop AND running at >= the integrity level of the foreground app.
    // The Worker runs as LocalSystem on the active input desktop, so it can
    // block UAC-elevated apps too (regular admin processes cannot). The OS
    // releases the block automatically on Ctrl+Alt+Del / lock — see
    // https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-blockinput
    BlockInput = user32.func('int32 __stdcall BlockInput(int32)');

    INPUT_TYPE = null; // not used — we pack buffers manually
    bound = true;
    return true;
  } catch (err) {
    console.error('[NativeInput] failed to bind user32:', (err as Error).message);
    return false;
  }
}

let cachedScreen: { w: number; h: number } | null = null;
let cachedVirtual: { x: number; y: number; w: number; h: number } | null = null;

function getPrimary(): { w: number; h: number } {
  if (cachedScreen) return cachedScreen;
  const w = GetSystemMetrics(SM_CXSCREEN) || 1920;
  const h = GetSystemMetrics(SM_CYSCREEN) || 1080;
  cachedScreen = { w, h };
  return cachedScreen;
}

function getVirtual(): { x: number; y: number; w: number; h: number } {
  if (cachedVirtual) return cachedVirtual;
  const x = GetSystemMetrics(SM_XVIRTUALSCREEN) || 0;
  const y = GetSystemMetrics(SM_YVIRTUALSCREEN) || 0;
  const w = GetSystemMetrics(SM_CXVIRTUALSCREEN) || 1920;
  const h = GetSystemMetrics(SM_CYVIRTUALSCREEN) || 1080;
  cachedVirtual = { x, y, w, h };
  return cachedVirtual;
}

/**
 * Build a single mouse INPUT struct. dx/dy meaning depends on flags:
 *   - With MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK: 0..65535 over
 *     the virtual desktop bounds.
 *   - Without ABSOLUTE: relative pixels from current cursor.
 */
function packMouseInput(dx: number, dy: number, mouseData: number, flags: number): Buffer {
  const buf = Buffer.alloc(INPUT_SIZE);
  buf.writeUInt32LE(INPUT_MOUSE, 0);
  // 4 bytes padding to align union at offset 8 on x64.
  buf.writeInt32LE(dx, 8);
  buf.writeInt32LE(dy, 12);
  buf.writeUInt32LE(mouseData >>> 0, 16);
  buf.writeUInt32LE(flags >>> 0, 20);
  buf.writeUInt32LE(0, 24); // time = 0 -> let system fill
  // dwExtraInfo at offset 32, ULONG_PTR (8 bytes on x64). Leave 0.
  return buf;
}

function packKeybdInput(vk: number, scan: number, flags: number): Buffer {
  const buf = Buffer.alloc(INPUT_SIZE);
  buf.writeUInt32LE(INPUT_KEYBOARD, 0);
  buf.writeUInt16LE(vk & 0xffff, 8);
  buf.writeUInt16LE(scan & 0xffff, 10);
  buf.writeUInt32LE(flags >>> 0, 12);
  buf.writeUInt32LE(0, 16); // time
  // 4 bytes padding at 20-23, then ULONG_PTR at 24..32.
  return buf;
}

function sendOne(buf: Buffer): boolean {
  if (!bindNativeInput()) return false;
  const n = SendInput(1, buf, INPUT_SIZE);
  return n === 1;
}

function sendMany(bufs: Buffer[]): boolean {
  if (!bindNativeInput()) return false;
  if (bufs.length === 0) return true;
  const merged = Buffer.concat(bufs);
  const n = SendInput(bufs.length, merged, INPUT_SIZE);
  return n === bufs.length;
}

// === Public mouse API ====================================================

export interface MoveOptions {
  /** X as 0..1 ratio of virtual desktop width. */
  ratioX: number;
  /** Y as 0..1 ratio of virtual desktop height. */
  ratioY: number;
}

export function moveTo(opts: MoveOptions): void {
  if (!bindNativeInput()) return;
  const v = getVirtual();
  // SetCursorPos takes screen coords directly. Mapping ratio against the
  // primary screen would silently break multi-monitor; we use the virtual
  // desktop the same way the Agent's renderer-side coords are computed.
  const x = Math.round(v.x + Math.max(0, Math.min(1, opts.ratioX)) * (v.w - 1));
  const y = Math.round(v.y + Math.max(0, Math.min(1, opts.ratioY)) * (v.h - 1));
  SetCursorPos(x, y);
}

export function mouseButton(button: 'left' | 'right' | 'middle', kind: 'down' | 'up'): void {
  let flag = 0;
  if (button === 'left') flag = kind === 'down' ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
  else if (button === 'right') flag = kind === 'down' ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
  else flag = kind === 'down' ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
  sendOne(packMouseInput(0, 0, 0, flag));
}

export function mouseClick(button: 'left' | 'right' | 'middle'): void {
  mouseButton(button, 'down');
  mouseButton(button, 'up');
}

export function mouseDblClick(): void {
  mouseClick('left');
  mouseClick('left');
}

export function mouseScroll(deltaX: number, deltaY: number): void {
  const events: Buffer[] = [];
  if (deltaY !== 0) {
    // Web wheel convention: positive deltaY = content scrolls down (wheel
    // toward user). Win32 WHEEL: positive = wheel rotated forward (away
    // from user), which is the OPPOSITE of web. Negate to match.
    const ticks = -Math.round(deltaY) * WHEEL_DELTA;
    events.push(packMouseInput(0, 0, ticks & 0xffffffff, MOUSEEVENTF_WHEEL));
  }
  if (deltaX !== 0) {
    const ticks = Math.round(deltaX) * WHEEL_DELTA;
    events.push(packMouseInput(0, 0, ticks & 0xffffffff, MOUSEEVENTF_HWHEEL));
  }
  if (events.length) sendMany(events);
}

// === Public keyboard API =================================================

/** Map a JS event key + code to a Win32 virtual-key code. Returns 0 on miss. */
export function jsKeyToVk(key: string, code: string): number {
  // Letters
  if (key.length === 1) {
    const c = key.toUpperCase().charCodeAt(0);
    if (c >= 0x30 && c <= 0x39) return c; // '0'..'9'
    if (c >= 0x41 && c <= 0x5a) return c; // 'A'..'Z'
  }
  // Function keys
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) {
    const n = parseInt(key.slice(1), 10);
    return 0x70 + (n - 1); // VK_F1 = 0x70
  }
  // Named keys
  const map: Record<string, number> = {
    'Enter': 0x0d, 'Escape': 0x1b, 'Backspace': 0x08, 'Tab': 0x09,
    ' ': 0x20, 'Space': 0x20, 'Delete': 0x2e, 'Insert': 0x2d,
    'ArrowUp': 0x26, 'ArrowDown': 0x28, 'ArrowLeft': 0x25, 'ArrowRight': 0x27,
    'Home': 0x24, 'End': 0x23, 'PageUp': 0x21, 'PageDown': 0x22,
    'Control': 0xa2, 'ControlLeft': 0xa2, 'ControlRight': 0xa3,
    'Shift': 0xa0, 'ShiftLeft': 0xa0, 'ShiftRight': 0xa1,
    'Alt': 0xa4, 'AltLeft': 0xa4, 'AltRight': 0xa5,
    'Meta': 0x5b, 'MetaLeft': 0x5b, 'MetaRight': 0x5c,
    'CapsLock': 0x14, 'NumLock': 0x90, 'ScrollLock': 0x91,
    'PrintScreen': 0x2c, 'Pause': 0x13,
    // OEM punctuation — VK codes are layout-dependent; OEM_* are the
    // most common US layout. Listed for completeness.
    ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf,
    '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
  };
  if (map[key] !== undefined) return map[key];
  if (map[code] !== undefined) return map[code];
  return 0;
}

const EXTENDED_VKS = new Set<number>([
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, // page/home/end/arrows
  0x2d, 0x2e, // ins / del
  0x90, 0x91, 0x2c, // numlock / scroll / printscreen
  0xa3, 0xa5, 0x5c, // right ctrl/alt/win
]);

/** Press or release a key by JS key/code. Returns true on success. */
export function keySend(key: string, code: string, kind: 'down' | 'up'): boolean {
  if (!bindNativeInput()) return false;
  const vk = jsKeyToVk(key, code);
  if (vk === 0) {
    // Fallback: synthesise via Unicode (reliable for textual keys, no good
    // for shortcuts because the OS treats KEYEVENTF_UNICODE as plain text).
    if (kind === 'down' && key.length === 1) {
      const ch = key.charCodeAt(0);
      sendOne(packKeybdInput(0, ch, KEYEVENTF_UNICODE));
      sendOne(packKeybdInput(0, ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
    return false;
  }
  const scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC) & 0xff;
  let flags = kind === 'up' ? KEYEVENTF_KEYUP : 0;
  if (EXTENDED_VKS.has(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
  return sendOne(packKeybdInput(vk, scan, flags));
}

// === Public block-input API ==============================================

/**
 * Toggle BlockInput. Returns true on success. The OS clears the block
 * automatically on Ctrl+Alt+Del / lock-screen / desktop switch, so callers
 * must re-apply after each desktop change to keep it sticky across UAC dim
 * screens. Calling with `false` from any thread on the same input desktop
 * lifts the block; the worker therefore must be the only process toggling
 * it for the active session to keep the state coherent.
 */
export function setBlockInput(block: boolean): boolean {
  if (!bindNativeInput()) return false;
  if (!BlockInput) return false;
  try {
    return BlockInput(block ? 1 : 0) !== 0;
  } catch (err) {
    console.error('[NativeInput] BlockInput failed:', (err as Error).message);
    return false;
  }
}
