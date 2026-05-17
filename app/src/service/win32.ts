/**
 * Win32 bindings (via koffi) for the SYSTEM service host.
 *
 * Two things this module does:
 *   1. SCM service dispatcher — registers our handler so SCM treats us
 *      as a real service (StartServiceCtrlDispatcher loop).
 *   2. Spawns the worker into the active interactive session running as
 *      LocalSystem, by:
 *        a. WTSGetActiveConsoleSessionId() → user session id
 *        b. WTSQueryUserToken(sessionId)    → user token
 *        c. DuplicateTokenEx + SetTokenInformation(TokenSessionId)
 *           on a primary token cloned from our own SYSTEM token
 *        d. CreateEnvironmentBlock(userToken)
 *        e. CreateProcessAsUser(systemToken-bound-to-session, ...)
 *
 * That gives the worker:
 *   - LocalSystem privileges (so input is high-IL → can drive UAC apps)
 *   - The user's interactive desktop (so input actually reaches it)
 *   - The user's environment (PATH, locale, %APPDATA%) for native libs
 *
 * NB: this only loads on win32. The whole module is gated by callers
 * checking process.platform first.
 */

import koffi from 'koffi';
import path from 'path';

// === Type aliases ===
const HANDLE = 'void*';
const DWORD = 'uint32';
const BOOL = 'int32';
const LPVOID = 'void*';
const LPCWSTR = 'str16';
const LPWSTR = 'str16';

// === DLLs ===
const advapi32 = koffi.load('advapi32.dll');
const kernel32 = koffi.load('kernel32.dll');
const wtsapi32 = koffi.load('wtsapi32.dll');
const userenv = koffi.load('userenv.dll');

// === Structs ===
const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: DWORD,
  lpReserved: LPWSTR,
  lpDesktop: LPWSTR,
  lpTitle: LPWSTR,
  dwX: DWORD,
  dwY: DWORD,
  dwXSize: DWORD,
  dwYSize: DWORD,
  dwXCountChars: DWORD,
  dwYCountChars: DWORD,
  dwFillAttribute: DWORD,
  dwFlags: DWORD,
  wShowWindow: 'uint16',
  cbReserved2: 'uint16',
  lpReserved2: 'uint8*',
  hStdInput: HANDLE,
  hStdOutput: HANDLE,
  hStdError: HANDLE,
});

const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: HANDLE,
  hThread: HANDLE,
  dwProcessId: DWORD,
  dwThreadId: DWORD,
});

// SERVICE_STATUS lives in service-host.ts because koffi keeps a global type
// registry — declaring the struct in two modules at load time throws
// "Duplicate type name 'SERVICE_STATUS'". win32.ts doesn't use it.

// === Function bindings ===
const OpenProcessToken = advapi32.func(
  'int32 __stdcall OpenProcessToken(void*, uint32, _Out_ void**)'
);
const DuplicateTokenEx = advapi32.func(
  'int32 __stdcall DuplicateTokenEx(void*, uint32, void*, int32, int32, _Out_ void**)'
);
const SetTokenInformation = advapi32.func(
  'int32 __stdcall SetTokenInformation(void*, int32, _In_ void*, uint32)'
);
const CreateProcessAsUserW = advapi32.func(
  'int32 __stdcall CreateProcessAsUserW(void*, str16, str16, void*, void*, int32, uint32, void*, str16, _Inout_ STARTUPINFOW*, _Out_ PROCESS_INFORMATION*)'
);
const GetCurrentProcess = kernel32.func('void* __stdcall GetCurrentProcess()');
const CloseHandle = kernel32.func('int32 __stdcall CloseHandle(void*)');
const TerminateProcess = kernel32.func('int32 __stdcall TerminateProcess(void*, uint32)');
const WaitForSingleObject = kernel32.func('uint32 __stdcall WaitForSingleObject(void*, uint32)');
const GetLastError = kernel32.func('uint32 __stdcall GetLastError()');

const WTSGetActiveConsoleSessionId = kernel32.func(
  'uint32 __stdcall WTSGetActiveConsoleSessionId()'
);
const WTSQueryUserToken = wtsapi32.func(
  'int32 __stdcall WTSQueryUserToken(uint32, _Out_ void**)'
);

const CreateEnvironmentBlock = userenv.func(
  'int32 __stdcall CreateEnvironmentBlock(_Out_ void**, void*, int32)'
);
const DestroyEnvironmentBlock = userenv.func(
  'int32 __stdcall DestroyEnvironmentBlock(void*)'
);

// === Constants ===
const TOKEN_DUPLICATE = 0x0002;
const TOKEN_QUERY = 0x0008;
const TOKEN_ASSIGN_PRIMARY = 0x0001;
const TOKEN_ADJUST_DEFAULT = 0x0080;
const TOKEN_ADJUST_SESSIONID = 0x0100;
const TOKEN_ALL_ACCESS_NEEDED =
  TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID;

const SecurityImpersonation = 2;
const TokenPrimary = 1;
const TokenSessionId = 12;

const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const CREATE_NEW_CONSOLE = 0x00000010;

const STARTF_USESHOWWINDOW = 0x00000001;
const SW_HIDE = 0;

const INFINITE = 0xffffffff;

// === Errors ===
function lastErr(prefix: string): Error {
  const code = GetLastError();
  return new Error(`${prefix} failed (Win32 code=${code})`);
}

// === Public API ===

export interface SpawnedWorker {
  /** Process handle (HANDLE) — caller must close via terminateWorker. */
  handle: any;
  pid: number;
  sessionId: number;
}

/**
 * Returns the active interactive console session id, or 0xFFFFFFFF when
 * no user is logged in (matches the WTSGetActiveConsoleSessionId contract).
 */
export function getActiveSessionId(): number {
  return WTSGetActiveConsoleSessionId();
}

/**
 * Read a Windows environment block (UTF-16, double-NUL-terminated, each
 * entry "NAME=VALUE\0", terminated by an extra "\0") from a koffi pointer
 * into a Buffer covering exactly its bytes.
 */
function readEnvBlock(ptr: any): Buffer {
  // Walk the block until we hit the double-NUL terminator. Each WCHAR is
  // 2 bytes; the block ends with a UTF-16 NUL after the final entry.
  const view = koffi.decode(ptr, 'uint16', 32768); // read up to 64 KB worth
  let end = 0;
  for (let i = 0; i < view.length - 1; i++) {
    if (view[i] === 0 && view[i + 1] === 0) {
      end = i + 2;
      break;
    }
  }
  if (end === 0) end = view.length;
  return Buffer.from(view.buffer, view.byteOffset, end * 2);
}

/**
 * Build a fresh UTF-16 env block from a key→value map. Format:
 *   "NAME=VALUE\0NAME=VALUE\0...\0"
 */
function buildEnvBlockFromMap(map: Record<string, string>): Buffer {
  let str = '';
  for (const [k, v] of Object.entries(map)) {
    str += `${k}=${v}\0`;
  }
  str += '\0';
  return Buffer.from(str, 'utf16le');
}

/**
 * Take an existing env block (from CreateEnvironmentBlock) and overlay
 * extras on top. Existing entries with the same key (case-insensitive on
 * Windows) are replaced, new ones are appended.
 */
function mergeEnvBlock(existingPtr: any, extras: Record<string, string>): Buffer {
  const buf = readEnvBlock(existingPtr);
  // Decode entries.
  const entries: Array<[string, string]> = [];
  let i = 0;
  while (i < buf.length) {
    // Find next NUL (UTF-16).
    let j = i;
    while (j < buf.length - 1 && !(buf[j] === 0 && buf[j + 1] === 0)) j += 2;
    if (j === i) break; // double-NUL terminator
    const entry = buf.slice(i, j).toString('utf16le');
    const eq = entry.indexOf('=');
    if (eq > 0) entries.push([entry.slice(0, eq), entry.slice(eq + 1)]);
    i = j + 2;
  }

  // Overlay extras (case-insensitive replace).
  const lowerExtras = new Map<string, string>();
  for (const [k, v] of Object.entries(extras)) lowerExtras.set(k.toLowerCase(), v);
  const merged: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [k, v] of entries) {
    const lk = k.toLowerCase();
    if (lowerExtras.has(lk)) {
      merged.push([k, lowerExtras.get(lk)!]);
      seen.add(lk);
    } else {
      merged.push([k, v]);
    }
  }
  for (const [k, v] of Object.entries(extras)) {
    if (!seen.has(k.toLowerCase())) merged.push([k, v]);
  }

  let str = '';
  for (const [k, v] of merged) str += `${k}=${v}\0`;
  str += '\0';
  return Buffer.from(str, 'utf16le');
}

/**
 * Spawn the worker as LocalSystem inside the given interactive session.
 *
 * This is the core trick: we copy *our own* token (the service is already
 * SYSTEM), retarget it to the user's session, then CreateProcessAsUser.
 * The new process inherits SYSTEM identity but lives on the user's desktop.
 */
export function spawnWorkerInSession(
  sessionId: number,
  exePath: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): SpawnedWorker {
  // 1. Open our own process token.
  const procToken: any = [null];
  if (
    !OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS_NEEDED, procToken)
  ) {
    throw lastErr('OpenProcessToken');
  }

  // 2. Duplicate as primary token suitable for CreateProcessAsUser.
  const dupToken: any = [null];
  if (
    !DuplicateTokenEx(
      procToken[0],
      TOKEN_ALL_ACCESS_NEEDED,
      null,
      SecurityImpersonation,
      TokenPrimary,
      dupToken
    )
  ) {
    CloseHandle(procToken[0]);
    throw lastErr('DuplicateTokenEx');
  }
  CloseHandle(procToken[0]);

  // 3. Retarget the duplicated token to the user's session id.
  const sessionBuf = Buffer.alloc(4);
  sessionBuf.writeUInt32LE(sessionId, 0);
  if (!SetTokenInformation(dupToken[0], TokenSessionId, sessionBuf, 4)) {
    CloseHandle(dupToken[0]);
    throw lastErr('SetTokenInformation(TokenSessionId)');
  }

  // 4. Build environment from the user's token (so PATH, %APPDATA%, etc.
  //    match what the user would see). We need the user token for this,
  //    not our SYSTEM token. Then merge extraEnv on top so callers can
  //    inject things like ELECTRON_RUN_AS_NODE without spawning a cmd.exe
  //    wrapper (which would orphan the child on TerminateProcess).
  const userToken: any = [null];
  let envBlock: any = null;
  let synthesizedEnv: Buffer | null = null;
  if (WTSQueryUserToken(sessionId, userToken)) {
    const envOut: any = [null];
    if (CreateEnvironmentBlock(envOut, userToken[0], 0)) {
      envBlock = envOut[0];
      if (Object.keys(extraEnv).length > 0) {
        synthesizedEnv = mergeEnvBlock(envBlock, extraEnv);
        DestroyEnvironmentBlock(envBlock);
        envBlock = null; // we'll pass the merged buffer instead
      }
    }
    CloseHandle(userToken[0]);
  }
  // Fall back to no env block (Windows uses the system env) if WTSQueryUserToken
  // failed — it will only fail if no user is logged on, which we already gate.
  if (!envBlock && !synthesizedEnv && Object.keys(extraEnv).length > 0) {
    // Last resort: synthesize from extraEnv alone. Better than passing null
    // (which would inherit the SYSTEM env and skip our overrides).
    synthesizedEnv = buildEnvBlockFromMap(extraEnv);
  }

  // 5. Compose command line. CreateProcessAsUserW requires lpCommandLine to
  //    include argv[0]. Quote argv[0] safely.
  const cmdline = [`"${exePath}"`, ...args].join(' ');

  const startupInfo: any = {
    cb: koffi.sizeof(STARTUPINFOW),
    lpReserved: null,
    lpDesktop: 'winsta0\\default',
    lpTitle: null,
    dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0,
    dwXCountChars: 0, dwYCountChars: 0, dwFillAttribute: 0,
    dwFlags: STARTF_USESHOWWINDOW,
    wShowWindow: SW_HIDE,
    cbReserved2: 0,
    lpReserved2: null,
    hStdInput: null, hStdOutput: null, hStdError: null,
  };
  const procInfo: any = {
    hProcess: null,
    hThread: null,
    dwProcessId: 0,
    dwThreadId: 0,
  };

  const flags = CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_CONSOLE;

  const ok = CreateProcessAsUserW(
    dupToken[0],
    null,             // application name (we pass it inside cmdline)
    cmdline,          // command line
    null, null,
    0,                // bInheritHandles = FALSE
    flags,
    synthesizedEnv ?? envBlock,
    path.dirname(exePath),
    startupInfo,
    procInfo
  );

  if (envBlock) DestroyEnvironmentBlock(envBlock);
  CloseHandle(dupToken[0]);

  if (!ok) throw lastErr('CreateProcessAsUserW');

  CloseHandle(procInfo.hThread);

  return {
    handle: procInfo.hProcess,
    pid: procInfo.dwProcessId,
    sessionId,
  };
}

export function waitForWorker(handle: any, timeoutMs: number = INFINITE): number {
  return WaitForSingleObject(handle, timeoutMs);
}

export function terminateWorker(handle: any): void {
  try { TerminateProcess(handle, 0); } catch { /* ignore */ }
  try { CloseHandle(handle); } catch { /* ignore */ }
}
