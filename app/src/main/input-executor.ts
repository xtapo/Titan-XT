import { MouseMessage, KeyMessage } from '../shared/protocol';

/**
 * InputExecutor — pure execution layer over @nut-tree-fork/nut-js.
 * No Electron imports here so it can run inside the SYSTEM worker too.
 *
 * The worker calls `executeMouse` / `executeKey` directly; the Agent uses
 * this same layer as an in-process fallback when the pipe is unavailable.
 */

let nutMouse: any = null;
let nutKeyboard: any = null;
let nutScreen: any = null;
let nutLoaded = false;
let cachedScreenSize: { width: number; height: number } | null = null;
let lastPos: { x: number; y: number } = { x: -1, y: -1 };

export async function loadNut(): Promise<boolean> {
  if (nutLoaded) return true;
  try {
    const nut = await import('@nut-tree-fork/nut-js');
    nutMouse = nut.mouse;
    nutKeyboard = nut.keyboard;
    nutScreen = nut.screen;

    nutMouse.config.autoDelayMs = 0;
    nutMouse.config.mouseSpeed = 2000;
    nutKeyboard.config.autoDelayMs = 0;

    nutLoaded = true;
    return true;
  } catch (err) {
    console.error('[InputExec] Failed to load nut.js:', err);
    return false;
  }
}

export function isNutLoaded(): boolean {
  return nutLoaded;
}

/**
 * Resolve host screen size in physical pixels via nut.js. We avoid Electron's
 * `screen.getPrimaryDisplay()` here so this module remains usable inside a
 * non-Electron worker process. The agent passes a fallback when nut.js cannot
 * report a size for some reason.
 */
async function getScreenPixelSize(
  fallback?: { width: number; height: number }
): Promise<{ width: number; height: number }> {
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
  if (fallback && fallback.width > 0 && fallback.height > 0) {
    cachedScreenSize = fallback;
    return cachedScreenSize;
  }
  // Last-resort default — better than throwing.
  cachedScreenSize = { width: 1920, height: 1080 };
  return cachedScreenSize;
}

function mapKey(key: string, _code: string): string | null {
  const keyMap: Record<string, string> = {
    'a': 'A', 'b': 'B', 'c': 'C', 'd': 'D', 'e': 'E', 'f': 'F',
    'g': 'G', 'h': 'H', 'i': 'I', 'j': 'J', 'k': 'K', 'l': 'L',
    'm': 'M', 'n': 'N', 'o': 'O', 'p': 'P', 'q': 'Q', 'r': 'R',
    's': 'S', 't': 'T', 'u': 'U', 'v': 'V', 'w': 'W', 'x': 'X',
    'y': 'Y', 'z': 'Z',
    '0': 'Num0', '1': 'Num1', '2': 'Num2', '3': 'Num3', '4': 'Num4',
    '5': 'Num5', '6': 'Num6', '7': 'Num7', '8': 'Num8', '9': 'Num9',
    'Enter': 'Enter', 'Escape': 'Escape', 'Backspace': 'Backspace',
    'Tab': 'Tab', ' ': 'Space', 'Delete': 'Delete',
    'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
    'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp', 'PageDown': 'PageDown',
    'Insert': 'Insert',
    'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4', 'F5': 'F5',
    'F6': 'F6', 'F7': 'F7', 'F8': 'F8', 'F9': 'F9', 'F10': 'F10',
    'F11': 'F11', 'F12': 'F12',
    'Control': 'LeftControl', 'Alt': 'LeftAlt', 'Shift': 'LeftShift',
    'Meta': 'LeftSuper',
    '-': 'Minus', '=': 'Equal', '[': 'LeftBracket', ']': 'RightBracket',
    '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote',
    ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Grave',
  };
  const nutKey = keyMap[key] || keyMap[key.toLowerCase()];
  return nutKey || null;
}

export interface MouseExecOptions {
  /** Used when nut.js cannot report screen size (rare). */
  screenSizeFallback?: { width: number; height: number };
}

export async function executeMouse(
  msg: MouseMessage,
  opts: MouseExecOptions = {}
): Promise<void> {
  if (!nutLoaded) {
    const ok = await loadNut();
    if (!ok) throw new Error('nut.js not available');
  }

  const { width, height } = await getScreenPixelSize(opts.screenSizeFallback);
  const x = Math.min(width - 1, Math.max(0, Math.round(msg.x * width)));
  const y = Math.min(height - 1, Math.max(0, Math.round(msg.y * height)));

  const btnIndex = msg.button === 'right' ? 2 : msg.button === 'middle' ? 1 : 0;
  const needsMove = x !== lastPos.x || y !== lastPos.y;

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
      if (msg.button === 'right') await nutMouse.rightClick();
      else if (msg.button === 'middle') await nutMouse.click(1);
      else await nutMouse.leftClick();
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
}

export async function executeKey(msg: KeyMessage): Promise<void> {
  if (!nutLoaded) {
    const ok = await loadNut();
    if (!ok) throw new Error('nut.js not available');
  }

  const Key = (await import('@nut-tree-fork/nut-js')).Key;
  const mappedKey = mapKey(msg.key, msg.code);

  if (!mappedKey) {
    if (msg.action === 'down' && msg.key.length === 1) {
      await nutKeyboard.type(msg.key);
    }
    return;
  }
  const keyValue = (Key as any)[mappedKey];
  if (!keyValue) return;

  if (msg.action === 'down') await nutKeyboard.pressKey(keyValue);
  else if (msg.action === 'up') await nutKeyboard.releaseKey(keyValue);
}

export async function executeInputMessage(
  msg: MouseMessage | KeyMessage,
  opts: MouseExecOptions = {}
): Promise<void> {
  if (msg.type === 'mouse') await executeMouse(msg, opts);
  else if (msg.type === 'key') await executeKey(msg);
}
