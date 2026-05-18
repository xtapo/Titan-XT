import crypto from 'crypto';
import os from 'os';
import { ipcMain, safeStorage } from 'electron';
import { getStore } from './store';
import type { AppSettings } from '../shared/types';

/**
 * Identity — Machine ID (9 digits, persistent) + Password (4 chars, random)
 *
 * Two password tracks:
 *   1. Rotating 4-char ad-hoc password (`store.password`) — what's on the
 *      home screen for "show this to the technician".
 *   2. Unattended password (settings.unattendedPasswordHash + salt) — fixed
 *      personal password the user picks once for always-on access. Never
 *      stored in plain text; we keep `SHA-256(salt + plain)` and recompute
 *      `SHA-256(plain + nonce)` from a temporary cache only during verify.
 *
 * Both tracks are accepted at the connect-challenge step. The host has no
 * way to distinguish which one the viewer used (and shouldn't — both are
 * valid by design).
 *
 * Brute-force defense: we keep a sliding-window failure counter keyed by the
 * viewer's machine id and lock the identity out after N wrong tries. The
 * lockout grows quadratically (15s, 60s, 240s, …) so a determined attacker
 * can't keep grinding 4-char passwords. Counter clears on a successful
 * verify or when the user explicitly resets it.
 */

// === Brute-force throttle ===
//
// In-memory only — wiping on app restart is intentional. A persistent counter
// would let an attacker who steals the config file set their own state, and
// the rotating password regenerates anyway, so a clean slate at boot is the
// right tradeoff.
const FAIL_WINDOW_MS = 60_000;       // failures decay after 60s of silence
const LOCKOUT_THRESHOLD = 5;         // 5 wrong tries → lockout starts
const LOCKOUT_BASE_MS = 15_000;      // 15s for the first overflow
// Backoff schedule beyond the threshold. Index = failures past threshold.
const LOCKOUT_STEPS_MS = [
  15_000,    // 6th failure → 15s
  60_000,    // 7th         → 1m
  240_000,   // 8th         → 4m
  900_000,   // 9th         → 15m
  3_600_000, // 10th+       → 1h, repeating
];

interface FailRecord {
  count: number;          // failures inside the current window
  firstAt: number;        // timestamp of the earliest failure in the window
  lockedUntil: number;    // 0 = not locked, else epoch ms
}

const failuresByViewer: Map<string, FailRecord> = new Map();

function viewerKey(viewerId: unknown): string {
  // Anything we can't recognize collapses to a single bucket so an attacker
  // can't dodge the limiter by sending different garbage every time.
  if (typeof viewerId !== 'string' || viewerId.length === 0) return '__anon__';
  return viewerId.slice(0, 32);
}

function isLockedOut(viewerId: string): { locked: boolean; retryAfterMs: number } {
  const rec = failuresByViewer.get(viewerId);
  if (!rec) return { locked: false, retryAfterMs: 0 };
  if (rec.lockedUntil <= Date.now()) return { locked: false, retryAfterMs: 0 };
  return { locked: true, retryAfterMs: rec.lockedUntil - Date.now() };
}

function recordFailure(viewerId: string): void {
  const now = Date.now();
  const existing = failuresByViewer.get(viewerId);
  let rec: FailRecord;

  if (!existing || now - existing.firstAt > FAIL_WINDOW_MS) {
    rec = { count: 1, firstAt: now, lockedUntil: 0 };
  } else {
    rec = { ...existing, count: existing.count + 1 };
  }

  if (rec.count >= LOCKOUT_THRESHOLD) {
    const stepIdx = Math.min(rec.count - LOCKOUT_THRESHOLD, LOCKOUT_STEPS_MS.length - 1);
    const lockMs = LOCKOUT_STEPS_MS[Math.max(0, stepIdx)] ?? LOCKOUT_BASE_MS;
    rec.lockedUntil = now + lockMs;
    console.warn(
      `[Identity] viewer=${viewerId} locked out for ${Math.round(lockMs / 1000)}s after ${rec.count} failed attempts`,
    );
  }
  failuresByViewer.set(viewerId, rec);
}

function clearFailures(viewerId: string): void {
  failuresByViewer.delete(viewerId);
}

function generateMachineId(): string {
  const hostname = os.hostname();
  const cpus = os.cpus();
  const networkInterfaces = os.networkInterfaces();

  let fingerprint = hostname;
  fingerprint += cpus.length > 0 ? cpus[0].model : '';
  fingerprint += os.totalmem().toString();

  for (const ifaces of Object.values(networkInterfaces)) {
    if (ifaces) {
      for (const iface of ifaces) {
        if (!iface.internal && iface.mac !== '00:00:00:00:00:00') {
          fingerprint += iface.mac;
          break;
        }
      }
    }
  }

  const hash = crypto.createHash('sha256').update(fingerprint).digest('hex');
  const num = parseInt(hash.substring(0, 12), 16) % 999_999_999;
  return (num + 100_000_000).toString().substring(0, 9);
}

function generatePassword(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < 4; i++) {
    password += chars[crypto.randomInt(chars.length)];
  }
  return password;
}

export function formatMachineId(id: string): string {
  return `${id.substring(0, 3)} ${id.substring(3, 6)} ${id.substring(6, 9)}`;
}

export function setupIdentity(): void {
  const store = getStore();

  let machineId = store.get('machineId') as string | undefined;
  if (!machineId) {
    machineId = generateMachineId();
    store.set('machineId', machineId);
    console.log(`[Identity] New Machine ID: ${formatMachineId(machineId)}`);
  } else {
    console.log(`[Identity] Machine ID: ${formatMachineId(machineId)}`);
  }

  let password = store.get('password') as string | undefined;
  if (!password) {
    password = generatePassword();
    store.set('password', password);
  }

  ipcMain.handle('identity:get', () => ({
    machineId: store.get('machineId'),
    password: store.get('password'),
    machineName: os.hostname(),
  }));

  ipcMain.handle('identity:regeneratePassword', () => {
    const newPass = generatePassword();
    store.set('password', newPass);
    return newPass;
  });

  ipcMain.handle('identity:verifyPassword', (_event: any, passwordHash: string, nonce: string, viewerId?: string) => {
    const key = viewerKey(viewerId);
    const lock = isLockedOut(key);
    if (lock.locked) {
      console.warn(`[Identity] verify rejected — viewer=${key} locked for ${Math.round(lock.retryAfterMs / 1000)}s more`);
      return false;
    }

    const currentPassword = store.get('password') as string;
    const expectedHash = crypto.createHash('sha256').update(currentPassword + nonce).digest('hex');
    if (passwordHash === expectedHash) {
      clearFailures(key);
      return true;
    }

    if (verifyUnattendedHash(passwordHash, nonce)) {
      clearFailures(key);
      return true;
    }

    recordFailure(key);
    return false;
  });

  // === Unattended password ===

  /**
   * Set / replace the unattended password. We store only `SHA-256(salt + plain)`
   * + the salt, so the plaintext is gone the moment this returns. A fresh
   * salt is generated on every set so reusing the same plain on a different
   * machine doesn't produce the same hash.
   */
  ipcMain.handle('identity:setUnattendedPassword', (_event: any, plain: string) => {
    if (typeof plain !== 'string' || plain.length < 6) {
      return { success: false, error: 'Mật khẩu phải có ít nhất 6 ký tự' };
    }
    const settings = (store.get('settings') || {}) as AppSettings;
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHash('sha256').update(salt + plain).digest('hex');
    const next: AppSettings = {
      ...settings,
      unattendedEnabled: true,
      unattendedPasswordHash: hash,
      unattendedPasswordSalt: salt,
    };
    store.set('settings', next);
    // Encrypt plain at rest so the challenge-response handler can recompute
    // SHA-256(plain + nonce) without keeping the plaintext in cleartext on
    // disk. safeStorage uses DPAPI on Windows, Keychain on macOS, libsecret
    // on Linux — falls through to base64 if the OS keystore is unavailable.
    let encoded: string;
    if (safeStorage.isEncryptionAvailable()) {
      encoded = 'enc:' + safeStorage.encryptString(plain).toString('base64');
    } else {
      encoded = 'b64:' + Buffer.from(plain, 'utf8').toString('base64');
    }
    store.set('unattendedPlain', encoded);
    return { success: true };
  });

  /**
   * Wipe the unattended password and turn the feature off. Auto-start is left
   * alone — the user may want the app to keep launching at boot for other
   * reasons (the rotating-password flow still works).
   */
  ipcMain.handle('identity:clearUnattendedPassword', () => {
    const settings = (store.get('settings') || {}) as AppSettings;
    const next: AppSettings = {
      ...settings,
      unattendedEnabled: false,
      unattendedPasswordHash: '',
      unattendedPasswordSalt: '',
    };
    store.set('settings', next);
    store.delete('unattendedPlain');
    return { success: true };
  });

  ipcMain.handle('identity:getUnattendedStatus', () => {
    const settings = (store.get('settings') || {}) as AppSettings;
    return {
      enabled: !!settings.unattendedEnabled && !!settings.unattendedPasswordHash,
      autoStart: !!settings.unattendedAutoStart,
    };
  });
}

/**
 * Verify a viewer-supplied `SHA-256(plain + nonce)` against the unattended
 * password.
 *
 * Plain is stored in the user-profile electron-store, but encrypted via
 * `safeStorage` (DPAPI / Keychain / libsecret) so a copy of the json file
 * alone isn't enough to recover the password. We decrypt it on demand to
 * recompute the challenge response and compare.
 */
function verifyUnattendedHash(passwordHash: string, nonce: string): boolean {
  const store = getStore();
  const settings = (store.get('settings') || {}) as AppSettings;
  if (!settings.unattendedEnabled) return false;
  const cached = store.get('unattendedPlain') as string | undefined;
  if (!cached) return false;

  let plain: string | null = null;
  try {
    if (cached.startsWith('enc:')) {
      const buf = Buffer.from(cached.slice(4), 'base64');
      plain = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(buf)
        : null;
    } else if (cached.startsWith('b64:')) {
      plain = Buffer.from(cached.slice(4), 'base64').toString('utf8');
    }
  } catch (err) {
    console.warn('[Identity] unattended decrypt failed:', err);
    return false;
  }
  if (!plain) return false;

  const expected = crypto.createHash('sha256').update(plain + nonce).digest('hex');
  return passwordHash === expected;
}
