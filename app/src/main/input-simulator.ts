import { ipcMain, screen } from 'electron';
import { MouseMessage, KeyMessage } from '../shared/protocol';

/**
 * InputSimulator — Simulates mouse and keyboard events on the host machine
 * Uses @nut-tree/nut-js for cross-platform input automation
 */

let nutMouse: any = null;
let nutKeyboard: any = null;
let nutScreen: any = null;
let nutLoaded = false;
let cachedScreenSize: { width: number; height: number } | null = null;
// Skip a redundant setPosition() in down/up/click when the cursor is already
// at the same physical pixel. Each call hops through nut.js → libuiohook,
// shaving the duplicate keeps clicks feeling instant on the host.
let lastPos: { x: number; y: number } = { x: -1, y: -1 };

/**
 * Lazy-load nut.js (it's heavy and may fail on some systems)
 */
async function loadNut(): Promise<boolean> {
  if (nutLoaded) return true;
  try {
    const nut = await import('@nut-tree-fork/nut-js');
    nutMouse = nut.mouse;
    nutKeyboard = nut.keyboard;
    nutScreen = nut.screen;

    // Configure nut.js
    nutMouse.config.autoDelayMs = 0;
    nutMouse.config.mouseSpeed = 2000;
    nutKeyboard.config.autoDelayMs = 0;

    nutLoaded = true;
    console.log('[Input] nut.js loaded successfully');
    return true;
  } catch (err) {
    console.error('[Input] Failed to load nut.js:', err);
    return false;
  }
}

/**
 * Get host screen size in physical pixels.
 * Electron's display.bounds is in DIPs (logical px), which on a HiDPI display
 * is smaller than the physical screen — using it here would clip clicks on the
 * right/bottom edges. nut.js reports physical px so we prefer that, with a
 * fallback to bounds × scaleFactor.
 */
async function getScreenPixelSize(): Promise<{ width: number; height: number }> {
  if (cachedScreenSize) return cachedScreenSize;
  try {
    const w = await nutScreen.width();
    const h = await nutScreen.height();
    if (w > 0 && h > 0) {
      cachedScreenSize = { width: w, height: h };
      return cachedScreenSize;
    }
  } catch {
    // fall through
  }
  const d = screen.getPrimaryDisplay();
  cachedScreenSize = {
    width: Math.round(d.bounds.width * d.scaleFactor),
    height: Math.round(d.bounds.height * d.scaleFactor),
  };
  return cachedScreenSize;
}

/**
 * Map key names to nut.js Key enum values
 */
function mapKey(key: string, code: string): number | null {
  // nut.js uses its own Key enum
  // We'll use a dynamic lookup approach
  const keyMap: Record<string, string> = {
    // Letters
    'a': 'A', 'b': 'B', 'c': 'C', 'd': 'D', 'e': 'E', 'f': 'F',
    'g': 'G', 'h': 'H', 'i': 'I', 'j': 'J', 'k': 'K', 'l': 'L',
    'm': 'M', 'n': 'N', 'o': 'O', 'p': 'P', 'q': 'Q', 'r': 'R',
    's': 'S', 't': 'T', 'u': 'U', 'v': 'V', 'w': 'W', 'x': 'X',
    'y': 'Y', 'z': 'Z',
    // Numbers
    '0': 'Num0', '1': 'Num1', '2': 'Num2', '3': 'Num3', '4': 'Num4',
    '5': 'Num5', '6': 'Num6', '7': 'Num7', '8': 'Num8', '9': 'Num9',
    // Special keys
    'Enter': 'Enter', 'Escape': 'Escape', 'Backspace': 'Backspace',
    'Tab': 'Tab', ' ': 'Space', 'Delete': 'Delete',
    'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
    'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp', 'PageDown': 'PageDown',
    'Insert': 'Insert',
    // Function keys
    'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4', 'F5': 'F5',
    'F6': 'F6', 'F7': 'F7', 'F8': 'F8', 'F9': 'F9', 'F10': 'F10',
    'F11': 'F11', 'F12': 'F12',
    // Modifiers
    'Control': 'LeftControl', 'Alt': 'LeftAlt', 'Shift': 'LeftShift',
    'Meta': 'LeftSuper',
    // Punctuation
    '-': 'Minus', '=': 'Equal', '[': 'LeftBracket', ']': 'RightBracket',
    '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote',
    ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Grave',
  };

  const nutKey = keyMap[key] || keyMap[key.toLowerCase()];
  return nutKey ? (nutKey as any) : null;
}

/**
 * Handle mouse event
 */
async function handleMouse(msg: MouseMessage): Promise<void> {
  if (!nutLoaded) return;

  // Use physical pixel size from nut.js so clicks on the right/bottom edges
  // are not clipped on HiDPI displays (Electron's display.bounds is logical px).
  const { width, height } = await getScreenPixelSize();

  // Convert ratio to actual coordinates, clamped inside [0, max-1] to keep
  // edge clicks targetable even when ratio rounds to exactly 1.0.
  const x = Math.min(width - 1, Math.max(0, Math.round(msg.x * width)));
  const y = Math.min(height - 1, Math.max(0, Math.round(msg.y * height)));

  // Map our protocol button → nut.js Button enum value.
  // nut.js Button: LEFT=0, MIDDLE=1, RIGHT=2.
  const btnIndex = msg.button === 'right' ? 2 : msg.button === 'middle' ? 1 : 0;

  // Skip a redundant setPosition when the cursor already matches the target —
  // saves an IPC round-trip on every button event when move+down arrive in
  // quick succession (which is the normal case for a click).
  const needsMove = x !== lastPos.x || y !== lastPos.y;

  try {
    switch (msg.action) {
      case 'move':
        if (needsMove) {
          await nutMouse.setPosition({ x, y });
          lastPos = { x, y };
        }
        break;

      case 'down':
        if (needsMove) {
          await nutMouse.setPosition({ x, y });
          lastPos = { x, y };
        }
        await nutMouse.pressButton(btnIndex);
        break;

      case 'up':
        if (needsMove) {
          await nutMouse.setPosition({ x, y });
          lastPos = { x, y };
        }
        await nutMouse.releaseButton(btnIndex);
        break;

      case 'click':
        if (needsMove) {
          await nutMouse.setPosition({ x, y });
          lastPos = { x, y };
        }
        if (msg.button === 'right') {
          await nutMouse.rightClick();
        } else if (msg.button === 'middle') {
          await nutMouse.click(1);
        } else {
          await nutMouse.leftClick();
        }
        break;

      case 'dblclick':
        if (needsMove) {
          await nutMouse.setPosition({ x, y });
          lastPos = { x, y };
        }
        await nutMouse.doubleClick();
        break;

      case 'contextmenu':
        if (needsMove) {
          await nutMouse.setPosition({ x, y });
          lastPos = { x, y };
        }
        await nutMouse.rightClick();
        break;

      case 'scroll':
        if (msg.deltaY) {
          if (msg.deltaY > 0) await nutMouse.scrollDown(Math.abs(msg.deltaY));
          else await nutMouse.scrollUp(Math.abs(msg.deltaY));
        }
        break;
    }
  } catch (err) {
    console.error('[Input] Mouse error:', err);
  }
}

/**
 * Handle keyboard event
 */
async function handleKey(msg: KeyMessage): Promise<void> {
  if (!nutLoaded) return;

  try {
    const Key = (await import('@nut-tree-fork/nut-js')).Key;
    const mappedKey = mapKey(msg.key, msg.code);

    if (!mappedKey) {
      // Try typing the character directly
      if (msg.action === 'down' && msg.key.length === 1) {
        await nutKeyboard.type(msg.key);
      }
      return;
    }

    const keyValue = (Key as any)[mappedKey];
    if (!keyValue) return;

    if (msg.action === 'down') {
      await nutKeyboard.pressKey(keyValue);
    } else if (msg.action === 'up') {
      await nutKeyboard.releaseKey(keyValue);
    }
  } catch (err) {
    console.error('[Input] Keyboard error:', err);
  }
}

/**
 * Setup IPC handler for input simulation
 */
export function setupInputSimulator(): void {
  ipcMain.handle('input:simulate', async (_event, msg: MouseMessage | KeyMessage) => {
    // Lazy load nut.js on first input
    if (!nutLoaded) {
      const loaded = await loadNut();
      if (!loaded) return { success: false, error: 'nut.js not available' };
    }

    try {
      if (msg.type === 'mouse') {
        await handleMouse(msg);
      } else if (msg.type === 'key') {
        await handleKey(msg);
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}
