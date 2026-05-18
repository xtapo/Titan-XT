import { BrowserWindow, ipcMain, screen } from 'electron';
import path from 'path';
import { AnnotationMessage } from '../shared/protocol';
import { ANNOTATION_FADE_MS } from '../shared/constants';

/**
 * Annotation — host-side transparent overlay that mirrors the viewer's
 * on-screen drawings onto the actual desktop.
 *
 * Implemented as a frameless transparent BrowserWindow sized to the
 * currently-shared monitor, click-through enabled (`setIgnoreMouseEvents`)
 * so the host can keep working while marks float above the screen, and
 * always-on-top so popups/explorer can't bury the strokes.
 *
 * The overlay's HTML lives in resources/annotation-overlay.html. We feed
 * it stroke messages via IPC and it paints them on a fullscreen canvas.
 */

let overlayWindow: BrowserWindow | null = null;
let activeDisplayId: number | null = null;
let pending: AnnotationMessage[] = [];
let overlayReady = false;

/**
 * Resolve the Electron Display matching a desktopCapturer source id. The
 * source id format is `screen:<displayId>:<index>` — we extract the middle
 * segment and match against `screen.getAllDisplays()`. Falls back to the
 * primary display when nothing matches.
 */
function findDisplayForSourceId(sourceId: string | null): Electron.Display {
  const displays = screen.getAllDisplays();
  if (!sourceId) return screen.getPrimaryDisplay();
  const parts = sourceId.split(':');
  const numeric = parts.length >= 2 ? Number(parts[1]) : NaN;
  if (Number.isFinite(numeric)) {
    const match = displays.find((d) => d.id === numeric);
    if (match) return match;
  }
  // Some Electron builds prefix with `screen:0:0` style — fall back to index.
  if (parts.length >= 3) {
    const idx = Number(parts[2]);
    if (Number.isFinite(idx) && displays[idx]) return displays[idx];
  }
  return screen.getPrimaryDisplay();
}

/**
 * Create (or recreate) the overlay window targeting the given source id.
 * Idempotent — calling again with a different monitor moves the overlay.
 */
function ensureOverlay(sourceId: string | null): void {
  const display = findDisplayForSourceId(sourceId);

  if (overlayWindow && !overlayWindow.isDestroyed() && activeDisplayId === display.id) {
    overlayWindow.showInactive();
    return;
  }

  // Different monitor (or first time) — tear down + rebuild so the window
  // gets the right bounds at construction time. Resizing a transparent
  // window after creation is unreliable on Windows.
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
    overlayReady = false;
  }

  activeDisplayId = display.id;

  overlayWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    hasShadow: false,
    alwaysOnTop: true,
    // Background MUST be omitted for transparency to work. Setting it
    // (even to '#00000000') makes Chromium opaque on Windows.
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Click-through: mouse events fall through to whatever is under the
  // overlay so the host can keep using the desktop while marks are visible.
  // `forward: true` still lets us track movement for hover effects if we
  // ever need them.
  overlayWindow.setIgnoreMouseEvents(true, { forward: false });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Use the screen-saver level so popups, full-screen apps, and tooltips
  // can't cover the strokes mid-explanation.
  overlayWindow.setBounds({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
  });

  // resources/* is bundled into app.asar by electron-builder; loadFile happily
  // resolves through asar so the same relative path works dev + packaged.
  const overlayPath = path.join(__dirname, '../../resources/annotation-overlay.html');

  overlayWindow.loadFile(overlayPath).catch((err) => {
    console.error('[Annotation] failed to load overlay:', err);
  });

  overlayWindow.webContents.on('did-finish-load', () => {
    overlayReady = true;
    // Drain anything that arrived before the renderer was ready to paint.
    if (pending.length > 0 && overlayWindow && !overlayWindow.isDestroyed()) {
      for (const msg of pending) {
        overlayWindow.webContents.send('annotation:stroke', msg);
      }
      pending = [];
    }
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
    activeDisplayId = null;
    overlayReady = false;
  });

  overlayWindow.showInactive();
}

/**
 * Tear the overlay down — called when the host session ends so we don't
 * leave a transparent window dangling on the desktop.
 */
export function closeAnnotationOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
  }
  overlayWindow = null;
  activeDisplayId = null;
  overlayReady = false;
  pending = [];
}

/**
 * Wire the host-side IPC.
 *
 *  - `annotation:relay`  — renderer (host role) hands us a stroke from the
 *    viewer; we forward it to the overlay window.
 *  - `annotation:setSource` — when the host swaps which monitor is being
 *    shared, the overlay needs to follow.
 *  - `annotation:close` — torn down with the session.
 */
export function setupAnnotation(getActiveSourceId: () => string | null): void {
  ipcMain.handle('annotation:relay', (_event, msg: AnnotationMessage) => {
    if (!msg || msg.type !== 'annotation') return { success: false };
    // Make sure the overlay exists on the right monitor before forwarding.
    // Lazy-create on first stroke so an idle session doesn't waste a window.
    ensureOverlay(getActiveSourceId());

    if (!overlayWindow || overlayWindow.isDestroyed()) return { success: false };
    if (!overlayReady) {
      pending.push(msg);
      return { success: true, queued: true };
    }
    overlayWindow.webContents.send('annotation:stroke', msg);
    return { success: true };
  });

  ipcMain.handle('annotation:setSource', (_event, sourceId: string | null) => {
    // If the overlay already exists for a different display, recreate it
    // bound to the new one. ensureOverlay handles both cases.
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      ensureOverlay(sourceId);
    }
    return { success: true };
  });

  ipcMain.handle('annotation:close', () => {
    closeAnnotationOverlay();
    return { success: true };
  });
}

// Expose the fade timeout so the overlay HTML can read it from preload.
export const ANNOTATION_FADE_TIMEOUT = ANNOTATION_FADE_MS;
