/**
 * TouchInput — translate touch + pointer events on the video element into
 * the same MouseMessage / KeyMessage stream the desktop viewer sends.
 *
 * Touch interaction model (UltraViewer-style trackpad mode):
 *   - Single-finger drag      → cursor move (relative to video frame)
 *   - Single-finger tap       → left click at the tapped position
 *   - Two-finger tap          → right click
 *   - Two-finger drag         → vertical/horizontal scroll
 *   - Long-press then drag    → mouse-button-held drag (for selection / move)
 *   - Pinch                   → reserved for future zoom
 *
 * We use Pointer Events instead of Touch Events so a Bluetooth mouse / Apple
 * Pencil / Surface stylus on the same browser also work — it's the same API
 * across input types.
 */

import type { ConnectionManager } from './connection';
import type { MouseMessage, KeyMessage } from './protocol';

type ActivePointer = {
  id: number;
  startX: number;
  startY: number;
  startT: number;
  lastX: number;
  lastY: number;
  moved: boolean;
};

const TAP_MOVE_THRESHOLD = 10; // px on screen — under this counts as tap
const TAP_TIME_THRESHOLD = 250; // ms
const LONG_PRESS_MS = 450;
const SCROLL_DIVISOR = 16; // bigger = less scroll per finger px

export class TouchInput {
  private videoEl: HTMLVideoElement;
  private conn: ConnectionManager;
  private enabled = false;
  private pointers = new Map<number, ActivePointer>();
  // Track virtual cursor position as a 0-1 ratio. Touch is relative — we don't
  // jump the host cursor to wherever the finger lands like a touchscreen, we
  // pan it like a trackpad. Starts at center.
  private cursorX = 0.5;
  private cursorY = 0.5;
  private longPressTimer: number | null = null;
  private dragHeld = false; // true while a long-press-initiated drag is in progress
  // Two-finger gesture state
  private twoFingerScroll = false;
  private lastScrollY = 0;
  private lastScrollX = 0;

  constructor(videoEl: HTMLVideoElement, conn: ConnectionManager) {
    this.videoEl = videoEl;
    this.conn = conn;
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.videoEl.style.touchAction = 'none';
    this.videoEl.addEventListener('pointerdown', this.onPointerDown);
    this.videoEl.addEventListener('pointermove', this.onPointerMove);
    this.videoEl.addEventListener('pointerup', this.onPointerUp);
    this.videoEl.addEventListener('pointercancel', this.onPointerUp);
    this.videoEl.addEventListener('contextmenu', this.preventEvent);
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.clearLongPress();
    this.pointers.clear();
    this.videoEl.removeEventListener('pointerdown', this.onPointerDown);
    this.videoEl.removeEventListener('pointermove', this.onPointerMove);
    this.videoEl.removeEventListener('pointerup', this.onPointerUp);
    this.videoEl.removeEventListener('pointercancel', this.onPointerUp);
    this.videoEl.removeEventListener('contextmenu', this.preventEvent);
  }

  /**
   * Send the current cursor position to the host as a mouse-move.
   * Used after every pan delta and before any click so the click lands at the
   * latest position — same idea as the desktop viewer's flushMoveSync().
   */
  private emitMove() {
    const msg: MouseMessage = {
      type: 'mouse',
      action: 'move',
      x: this.cursorX,
      y: this.cursorY,
    };
    this.conn.sendInput(msg);
  }

  private emitButton(action: 'down' | 'up' | 'click' | 'dblclick' | 'contextmenu', button: 'left' | 'right' | 'middle' = 'left') {
    const msg: MouseMessage = {
      type: 'mouse',
      action,
      x: this.cursorX,
      y: this.cursorY,
      button,
    };
    this.conn.sendInput(msg);
  }

  private emitScroll(dx: number, dy: number) {
    const msg: MouseMessage = {
      type: 'mouse',
      action: 'scroll',
      x: this.cursorX,
      y: this.cursorY,
      deltaX: Math.sign(dx) * Math.max(1, Math.abs(dx)),
      deltaY: Math.sign(dy) * Math.max(1, Math.abs(dy)),
    };
    this.conn.sendInput(msg);
  }

  /**
   * Public hook for the on-screen keyboard. Splits into per-key down+up so
   * the host's input simulator sees a normal keystroke even though no real
   * keyboard fired the event.
   */
  sendKey(key: string, code: string, modifiers: ('ctrl' | 'alt' | 'shift' | 'meta')[] = []) {
    const down: KeyMessage = { type: 'key', action: 'down', key, code, modifiers };
    const up: KeyMessage = { type: 'key', action: 'up', key, code, modifiers };
    this.conn.sendInput(down);
    // Tiny gap before the up so nut.js sees a discrete press; without this,
    // some apps swallow rapid down+up as a "key repeat reset".
    setTimeout(() => this.conn.sendInput(up), 30);
  }

  // === Pointer handlers ===

  private preventEvent = (e: Event) => e.preventDefault();

  private onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    this.videoEl.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startT: performance.now(),
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
    });

    if (this.pointers.size === 1) {
      // Schedule long-press detection — fires only if the finger doesn't move
      // and isn't lifted within the window. On fire, we send mousedown so the
      // next move becomes a drag.
      this.clearLongPress();
      this.longPressTimer = window.setTimeout(() => {
        const p = this.pointers.get(e.pointerId);
        if (!p || p.moved) return;
        this.emitMove();
        this.emitButton('down', 'left');
        this.dragHeld = true;
        // Subtle haptic so the user knows drag mode armed (Android only).
        try {
          (navigator as any).vibrate?.(20);
        } catch {
          // ignore
        }
      }, LONG_PRESS_MS);
    } else if (this.pointers.size === 2) {
      // Second finger lands → cancel any pending long-press; we're scrolling.
      this.clearLongPress();
      this.twoFingerScroll = true;
      this.lastScrollY = this.averageY();
      this.lastScrollX = this.averageX();
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.lastX;
    const dy = e.clientY - p.lastY;
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > TAP_MOVE_THRESHOLD) {
      p.moved = true;
    }

    if (this.twoFingerScroll && this.pointers.size === 2) {
      const avgY = this.averageY();
      const avgX = this.averageX();
      const sdy = avgY - this.lastScrollY;
      const sdx = avgX - this.lastScrollX;
      if (Math.abs(sdy) > 1 || Math.abs(sdx) > 1) {
        this.emitScroll(-sdx / SCROLL_DIVISOR, -sdy / SCROLL_DIVISOR);
        this.lastScrollY = avgY;
        this.lastScrollX = avgX;
      }
      return;
    }

    if (this.pointers.size === 1) {
      // Trackpad-style pan: convert finger delta to cursor delta as a fraction
      // of the video element's rendered size, then clamp.
      const rect = this.videoEl.getBoundingClientRect();
      this.cursorX = clamp01(this.cursorX + dx / rect.width);
      this.cursorY = clamp01(this.cursorY + dy / rect.height);
      this.emitMove();
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    try {
      this.videoEl.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    this.clearLongPress();

    if (this.pointers.size === 1 && this.twoFingerScroll) {
      // First finger of a 2-finger gesture lifted — second finger continues
      // as a single-finger drag, which is fine.
      this.twoFingerScroll = false;
      return;
    }

    if (this.dragHeld && this.pointers.size === 0) {
      // Long-press drag → release the held mouse button at the latest pos.
      this.emitButton('up', 'left');
      this.dragHeld = false;
      return;
    }

    if (!p) return;
    const elapsed = performance.now() - p.startT;
    const isTap = !p.moved && elapsed < TAP_TIME_THRESHOLD;

    // Two-finger tap (both lifted within the window without moving) → right click
    if (this.twoFingerScroll && this.pointers.size === 0) {
      const wasShortAndStill =
        elapsed < TAP_TIME_THRESHOLD && !p.moved;
      this.twoFingerScroll = false;
      if (wasShortAndStill) {
        this.emitMove();
        this.emitButton('contextmenu', 'right');
      }
      return;
    }

    if (isTap && this.pointers.size === 0) {
      this.emitMove();
      // Synthesize a click via down+up so the host's input simulator handles
      // it the same way a real mouse would. Single 'click' messages aren't
      // emitted by the desktop viewer either.
      this.emitButton('down', 'left');
      this.emitButton('up', 'left');
    }
  };

  private clearLongPress() {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private averageY(): number {
    let sum = 0;
    for (const p of this.pointers.values()) sum += p.lastY;
    return sum / this.pointers.size;
  }
  private averageX(): number {
    let sum = 0;
    for (const p of this.pointers.values()) sum += p.lastX;
    return sum / this.pointers.size;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
