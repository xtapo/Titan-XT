/**
 * desktop-attach — keep the worker thread bound to the active input desktop.
 *
 * On Windows, a single window station has multiple desktops. The user's
 * normal apps live on `winsta0\default`. The lock screen, UAC dim screen,
 * and Ctrl+Alt+Del belong to `winsta0\winlogon`. Each thread can only see
 * (and inject input into) the desktop it's currently attached to via
 * SetThreadDesktop. The service spawned us with lpDesktop="winsta0\\default",
 * so without re-attaching we go silent the moment the user locks the PC.
 *
 * Strategy:
 *   - Before every batch of input, call OpenInputDesktop() to get a handle
 *     to the desktop currently receiving input.
 *   - If it differs from what our thread is attached to, SetThreadDesktop
 *     to it. Close the previous handle.
 *   - SetThreadDesktop fails if the thread owns any windows or hooks; the
 *     worker doesn't, so this is safe.
 *
 * Note: nut.js / SendInput run on the calling thread, so as long as the
 * caller is on the Node main thread (where we attach), input goes to the
 * right desktop. We re-check on every input call because lock/unlock and
 * UAC prompts can flip the input desktop at any time.
 */

import koffi from 'koffi';

let user32: any = null;
let kernel32: any = null;
let OpenInputDesktop: any = null;
let SetThreadDesktop: any = null;
let CloseDesktop: any = null;
let GetUserObjectInformation: any = null;
let GetThreadDesktop: any = null;
let GetCurrentThreadId: any = null;
let GetLastError: any = null;

let bound = false;
// Handle of the desktop the worker thread is currently attached to.
// Owned by us — closed when we replace it.
let currentDesktop: any = null;
// Name of currentDesktop (e.g. "Default", "Winlogon"). Cached for logging.
let currentName = '';

const DESKTOP_SWITCHDESKTOP = 0x0100;
const DESKTOP_READOBJECTS = 0x0001;
const DESKTOP_WRITEOBJECTS = 0x0080;
const UOI_NAME = 2;

function bind(): boolean {
  if (bound) return true;
  if (process.platform !== 'win32') return false;
  try {
    user32 = koffi.load('user32.dll');
    kernel32 = koffi.load('kernel32.dll');
    OpenInputDesktop = user32.func('void* __stdcall OpenInputDesktop(uint32, int32, uint32)');
    SetThreadDesktop = user32.func('int32 __stdcall SetThreadDesktop(void*)');
    CloseDesktop = user32.func('int32 __stdcall CloseDesktop(void*)');
    GetUserObjectInformation = user32.func(
      'int32 __stdcall GetUserObjectInformationW(void*, int32, _Out_ void*, uint32, _Out_ uint32*)'
    );
    GetThreadDesktop = user32.func('void* __stdcall GetThreadDesktop(uint32)');
    GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()');
    GetLastError = kernel32.func('uint32 __stdcall GetLastError()');
    bound = true;
    return true;
  } catch (err) {
    console.error('[DesktopAttach] failed to bind win32:', (err as Error).message);
    return false;
  }
}

function readDesktopName(handle: any): string {
  try {
    const buf = Buffer.alloc(256);
    const out: any = [0];
    if (GetUserObjectInformation(handle, UOI_NAME, buf, buf.length, out)) {
      // UOI_NAME returns a null-terminated UTF-16 string.
      const len = (out[0] || 0) - 2; // exclude trailing NUL (2 bytes)
      if (len > 0) return buf.slice(0, Math.max(0, len)).toString('utf16le');
    }
  } catch {
    // ignore
  }
  return '';
}

/**
 * Make sure the calling (Node main) thread is attached to the desktop that
 * is currently receiving input. Cheap to call repeatedly — the common path
 * is one OpenInputDesktop + a name compare and we're done. Returns the
 * current desktop name on success ("" if win32 isn't available).
 */
export function attachToInputDesktop(): string {
  if (!bind()) return '';

  // SwitchDesktop+ReadObjects+WriteObjects is what SendInput needs.
  const access = DESKTOP_SWITCHDESKTOP | DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS;
  // OpenInputDesktop(flags=0, fInherit=FALSE, dwDesiredAccess).
  const newDesk = OpenInputDesktop(0, 0, access);
  if (!newDesk) {
    // No active input desktop right now (rare — happens during fast logoff).
    // Don't tear down our current attachment; the next call will retry.
    return currentName;
  }

  const newName = readDesktopName(newDesk);
  if (newName && newName === currentName) {
    // Already attached to the right desktop. Drop the freshly opened handle.
    CloseDesktop(newDesk);
    return currentName;
  }

  // Need to switch. SetThreadDesktop fails if the thread owns windows or
  // hooks — we don't, so this should always succeed. If it does fail, log
  // the Win32 code and keep using the previous attachment.
  if (!SetThreadDesktop(newDesk)) {
    const code = GetLastError();
    console.warn(
      `[DesktopAttach] SetThreadDesktop("${newName}") failed (code=${code}) — staying on "${currentName}"`
    );
    CloseDesktop(newDesk);
    return currentName;
  }

  // Successfully attached. Close the previous handle (if we still own one)
  // and adopt the new one. Don't close the system-default desktop handle
  // we inherited at startup — we never owned it; we only own handles we
  // got from OpenInputDesktop, so this is safe.
  if (currentDesktop) {
    try { CloseDesktop(currentDesktop); } catch { /* ignore */ }
  }
  currentDesktop = newDesk;
  if (newName !== currentName) {
    console.log(`[DesktopAttach] switched thread desktop "${currentName || '(initial)'}" -> "${newName}"`);
  }
  currentName = newName;
  return currentName;
}

/** Returns the name of the desktop the worker thread is attached to, or "" if not yet attached. */
export function currentDesktopName(): string {
  return currentName;
}
