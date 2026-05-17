import { ipcMain, screen } from 'electron';
import { MouseMessage, KeyMessage } from '../shared/protocol';

/**
 * InputSimulator — Simulates mouse and keyboard events on the host machine
 * Uses @nut-tree/nut-js for cross-platform input automation
 */

let nutMouse: any = null;
let nutKeyboard: any = null;
let nutLoaded = false;

/**
 * Lazy-load nut.js (it's heavy and may fail on some systems)
 */
async function loadNut(): Promise<boolean> {
  if (nutLoaded) return true;
  try {
    const nut = await import('@nut-tree-fork/nut-js');
    nutMouse = nut.mouse;
    nutKeyboard = nut.keyboard;

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

  // Get actual screen dimensions
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.bounds;

  // Convert ratio to actual coordinates
  const x = Math.round(msg.x * width);
  const y = Math.round(msg.y * height);

  try {
    switch (msg.action) {
      case 'move':
        await nutMouse.setPosition({ x, y });
        break;

      case 'click':
        await nutMouse.setPosition({ x, y });
        if (msg.button === 'right') {
          await nutMouse.rightClick();
        } else if (msg.button === 'middle') {
          // Middle click - nut.js may not support directly
          await nutMouse.click(1); // Button.MIDDLE
        } else {
          await nutMouse.leftClick();
        }
        break;

      case 'dblclick':
        await nutMouse.setPosition({ x, y });
        await nutMouse.doubleClick();
        break;

      case 'contextmenu':
        await nutMouse.setPosition({ x, y });
        await nutMouse.rightClick();
        break;

      case 'scroll':
        if (msg.deltaY) {
          await nutMouse.scrollDown(msg.deltaY > 0 ? Math.abs(msg.deltaY) : 0);
          await nutMouse.scrollUp(msg.deltaY < 0 ? Math.abs(msg.deltaY) : 0);
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
