import { ipcMain, app } from 'electron';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import koffi from 'koffi';
import { getStore } from './store';

const execAsync = promisify(exec);

/**
 * Wallpaper hide/restore — Windows only.
 *
 * Hides the desktop wallpaper while a viewer is connected so the encoder
 * doesn't waste bitrate on a static, hard-to-compress image. Same trick
 * UltraViewer/TeamViewer use for their "hide wallpaper" toggle.
 *
 * Implementation notes:
 *   - We call user32!SystemParametersInfoW directly via koffi instead of
 *     spawning PowerShell. Avoids encoding hassles, AppLocker policies, and
 *     the case where Add-Type silently fails to compile inline C# on locked-
 *     down machines.
 *   - "Hide" really means "set wallpaper to a 1×1 black BMP". Passing "" to
 *     SPI_SETDESKWALLPAPER is honored on classic Windows but Win10/11 with
 *     an active TranscodedImageCache may keep showing the cached image.
 *     A real (tiny) BMP forces the shell to actually repaint.
 *   - The original path is persisted to electron-store before hiding, so a
 *     crash mid-session doesn't leave the user without their wallpaper —
 *     `restoreOnStartup` runs on boot and re-applies it.
 */

const STORE_KEY = 'wallpaperBackup';
const SPI_SETDESKWALLPAPER = 0x0014;
const SPIF_UPDATEINIFILE = 0x01;
const SPIF_SENDCHANGE = 0x02;

interface WallpaperBackup {
  path: string;
  hiddenAt: number;
}

let user32: ReturnType<typeof koffi.load> | null = null;
let SystemParametersInfoW: any = null;

function loadUser32(): boolean {
  if (process.platform !== 'win32') return false;
  if (SystemParametersInfoW) return true;
  try {
    user32 = koffi.load('user32.dll');
    // BOOL SystemParametersInfoW(UINT uiAction, UINT uiParam, PVOID pvParam, UINT fWinIni)
    SystemParametersInfoW = user32.func(
      'int32 __stdcall SystemParametersInfoW(uint32, uint32, str16, uint32)'
    );
    return true;
  } catch (err) {
    console.error('[Wallpaper] failed to load user32:', err);
    return false;
  }
}

async function readCurrentWallpaperPath(): Promise<string> {
  if (process.platform !== 'win32') return '';
  try {
    const { stdout } = await execAsync(
      'reg query "HKCU\\Control Panel\\Desktop" /v Wallpaper'
    );
    const match = stdout.match(/Wallpaper\s+REG_SZ\s+(.*)/i);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

/**
 * Build a 1×1 black BMP and write it to %TEMP%. Cached on disk so we don't
 * thrash IO every session — same content every time. Returned path is
 * what gets fed to SPI_SETDESKWALLPAPER.
 */
function ensureBlackBmp(): string {
  const dir = path.join(app.getPath('temp'), 'titan-xt');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'blank.bmp');
  if (!fs.existsSync(file)) {
    // 24-bit BMP, 1×1, single black pixel + 3 bytes padding to 4-byte row.
    // Header layout per the BITMAPFILEHEADER + BITMAPINFOHEADER spec.
    const buf = Buffer.from([
      0x42, 0x4d,             // 'BM'
      0x3a, 0x00, 0x00, 0x00, // file size = 58
      0x00, 0x00, 0x00, 0x00, // reserved
      0x36, 0x00, 0x00, 0x00, // pixel data offset = 54
      0x28, 0x00, 0x00, 0x00, // DIB header size = 40
      0x01, 0x00, 0x00, 0x00, // width = 1
      0x01, 0x00, 0x00, 0x00, // height = 1
      0x01, 0x00,             // planes = 1
      0x18, 0x00,             // bpp = 24
      0x00, 0x00, 0x00, 0x00, // compression = none
      0x04, 0x00, 0x00, 0x00, // image size = 4
      0x13, 0x0b, 0x00, 0x00, // x pixels per meter
      0x13, 0x0b, 0x00, 0x00, // y pixels per meter
      0x00, 0x00, 0x00, 0x00, // colors used
      0x00, 0x00, 0x00, 0x00, // important colors
      // Pixel data: BGR(0,0,0) = black + 1 byte padding to 4-byte row
      0x00, 0x00, 0x00, 0x00,
    ]);
    fs.writeFileSync(file, buf);
  }
  return file;
}

function applyWallpaper(filePath: string): { ok: boolean; rc: number; error?: string } {
  if (!loadUser32() || !SystemParametersInfoW) {
    return { ok: false, rc: 0, error: 'user32 not loaded' };
  }
  try {
    const flags = SPIF_UPDATEINIFILE | SPIF_SENDCHANGE;
    const rc = SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, filePath, flags) as number;
    return { ok: rc !== 0, rc };
  } catch (err: any) {
    return { ok: false, rc: 0, error: err?.message || String(err) };
  }
}

export async function hideWallpaper(): Promise<{ success: boolean; error?: string }> {
  if (process.platform !== 'win32') {
    return { success: false, error: 'Chỉ hỗ trợ Windows' };
  }
  try {
    const store = getStore();
    const existing = store.get(STORE_KEY) as WallpaperBackup | undefined;
    // Already hidden — re-apply blank but don't clobber the saved original.
    const blank = ensureBlackBmp();
    if (!existing) {
      const current = await readCurrentWallpaperPath();
      const backup: WallpaperBackup = { path: current, hiddenAt: Date.now() };
      store.set(STORE_KEY, backup);
      console.log('[Wallpaper] backup =', current || '(none)');
    }
    const res = applyWallpaper(blank);
    if (!res.ok) {
      console.error('[Wallpaper] hide SystemParametersInfoW failed rc=', res.rc, 'err=', res.error);
      return { success: false, error: res.error || `rc=${res.rc}` };
    }
    console.log('[Wallpaper] hidden -> blank.bmp');
    return { success: true };
  } catch (err: any) {
    console.error('[Wallpaper] hide failed:', err);
    return { success: false, error: err?.message || String(err) };
  }
}

export async function restoreWallpaper(): Promise<{ success: boolean; error?: string }> {
  if (process.platform !== 'win32') {
    return { success: false, error: 'Chỉ hỗ trợ Windows' };
  }
  try {
    const store = getStore();
    const backup = store.get(STORE_KEY) as WallpaperBackup | undefined;
    if (!backup) {
      return { success: true };
    }
    // Empty original (user had no wallpaper set) — apply empty string and
    // let the shell paint the solid background color.
    const target = backup.path && fs.existsSync(backup.path) ? backup.path : '';
    const res = applyWallpaper(target);
    if (!res.ok) {
      console.error('[Wallpaper] restore SystemParametersInfoW failed rc=', res.rc, 'err=', res.error);
      return { success: false, error: res.error || `rc=${res.rc}` };
    }
    store.delete(STORE_KEY);
    console.log('[Wallpaper] restored ->', target || '(empty)');
    return { success: true };
  } catch (err: any) {
    console.error('[Wallpaper] restore failed:', err);
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * On app boot: if a previous run hid the wallpaper but never got to
 * restore it (crash, force-kill, power loss), put it back now.
 */
export async function restoreOnStartup(): Promise<void> {
  if (process.platform !== 'win32') return;
  const store = getStore();
  const backup = store.get(STORE_KEY) as WallpaperBackup | undefined;
  if (!backup) return;
  console.log('[Wallpaper] startup recovery — restoring previously hidden wallpaper');
  await restoreWallpaper();
}

export function setupWallpaper(): void {
  ipcMain.handle('wallpaper:hide', () => hideWallpaper());
  ipcMain.handle('wallpaper:restore', () => restoreWallpaper());
}
