/**
 * TouchInput — pointer events on the video element → wire-format input messages.
 *
 * Design summary (state machine, no event-mode flag soup):
 *
 *   IDLE
 *     └─ pointerdown(1) ──► PEN
 *                              ├─ moved past slop ──► PAN  (1-finger drag)
 *                              ├─ longpress timer fires ──► DRAGGING (left held)
 *                              └─ pointerup before slop ──► tap → click left
 *                                                          │  (or queue dblclick)
 *     └─ pointerdown(2 within window) ──► TWO_DOWN
 *                              ├─ both moved ──► SCROLL (2-finger pan = wheel)
 *                              └─ both up before move ──► tap → right click
 *     └─ pointerdown(3) ──► THREE_DOWN ──► tap on lift → middle click
 *
 * Why a state machine instead of poking flags from each handler:
 *   - The previous version emitted spurious right-clicks because
 *     `twoFingerScroll` was true when the *first* finger lifted (still 1
 *     pointer down), then read again on the second lift.
 *   - With explicit states, "what should this lift do?" has exactly one
 *     answer keyed on (state, pointerCount, moved-or-not, time).
 *
 * Performance touches:
 *   - All move events accumulate into one delta per animation frame, so a
 *     240 Hz active stylus / fast Bluetooth mouse doesn't flood the input
 *     channel. The desktop viewer does the same in input-handler.ts.
 *   - Pointer ballistics (acceleration curve) means small precise moves stay
 *     small while a fast flick covers a lot of ground — same trick the OS
 *     uses on a real trackpad.
 *   - Inertia scroll: after a 2-finger flick we keep emitting wheel deltas
 *     with exponential decay so the host scroll feels continuous instead of
 *     stopping the moment the fingers leave glass.
 */

import type { ConnectionManager } from './connection';
import type { MouseMessage, KeyMessage } from './protocol';

// === Tunables ===
// Slop = how far a finger can travel and still count as a tap.
// 12 CSS pixels lines up with the platform default on iOS / Android and is
// big enough that a small jitter on tap doesn't get re-classified as a pan.
const TAP_SLOP_PX = 12;
const TAP_TIME_MS = 250;
// Long-press to start a left-mouse-button-held drag. 420 ms is the same
// threshold UltraViewer / Splashtop use for their "press and drag" gesture.
const LONG_PRESS_MS = 420;
// Double-tap to dblclick. iOS uses ~300 ms; we go a touch tighter so a slow
// double tap doesn't accidentally fire a dblclick on the host.
const DBL_TAP_GAP_MS = 280;
// Pan ballistics — finger-px → screen-ratio.
// Slow drags: ~2.2× so a small finger movement covers a useful chunk of
// the host screen without feeling like dragging a heavy object. Touch
// users expect roughly phone-trackpad feel — Splashtop/Parsec sit around
// 2.0–2.5 here for the same reason.
// Fast flicks: extra gain proportional to *velocity* (px/ms), capped so a
// hard flick can traverse the screen without teleporting unpredictably.
const PAN_LINEAR = 2.2;
const PAN_VELOCITY_GAIN = 5.0;   // multiplied by px/ms
const PAN_VELOCITY_CAP = 3.5;    // max extra gain on top of linear
// Inertia scroll — exponential decay coefficient per frame at 60 Hz.
// 0.92 = ~50% velocity remains after 8 frames (~133 ms); feels snappy without
// floating forever.
const INERTIA_DECAY = 0.92;
const INERTIA_MIN_VELOCITY = 0.5; // px/frame; below this we stop the timer.

type State =
  | 'IDLE'
  | 'PEN'        // exactly one pointer, hasn't decided what it is yet
  | 'PAN'        // one-finger pan moves the cursor
  | 'DRAGGING'   // long-press fired, left button held, pointer drags
  | 'TWO_DOWN'   // two pointers, hasn't decided scroll vs right-tap
  | 'SCROLL'     // two-finger pan = wheel scroll
  | 'THREE_DOWN'; // three pointers down, tap on lift = middle click

type Pointer = {
  id: number;
  startX: number;
  startY: number;
  startT: number;
  x: number;
  y: number;
  /** Timestamp of the last move event for this pointer — used to derive
   *  px/ms velocity for ballistics. */
  lastMoveT: number;
  moved: boolean;
};

export class TouchInput {
  private videoEl: HTMLVideoElement;
  private cursorEl: HTMLDivElement | null = null;
  private conn: ConnectionManager;
  private enabled = false;

  private state: State = 'IDLE';
  private pointers = new Map<number, Pointer>();
  // Rotation in degrees applied to the parent container via CSS transform.
  // 0 = normal; 90 = clockwise; -90 = counter-clockwise. When set, we rotate
  // pointer deltas inversely so finger-right always moves cursor-right
  // *within the rotated content* — otherwise a user holding their phone in
  // portrait but viewing CSS-rotated landscape gets a session where swipe
  // direction doesn't match what they see.
  private rotation: 0 | 90 | -90 = 0;

  // Virtual cursor — 0..1 ratio of remote screen. Starts at center so first
  // tap lands somewhere visible no matter the screen size.
  private cursorX = 0.5;
  private cursorY = 0.5;

  private longPressTimer: number | null = null;
  // Last single-finger tap time + position. If the next tap arrives close
  // enough in time *and* place we promote it to a double-click.
  private lastTapTime = 0;
  private lastTapX = 0;
  private lastTapY = 0;

  // Cursor-overlay repaint coalescing — moves go out immediately for low
  // input latency, but the rotation-aware overlay paint is throttled to
  // once per frame so we don't thrash layout.
  private moveRafScheduled = false;

  // Scroll velocity tracking for inertia.
  private scrollVx = 0;
  private scrollVy = 0;
  private inertiaTimer: number | null = null;
  // Last 2-finger centroid; deltas relative to this drive the wheel.
  private lastCentroidX = 0;
  private lastCentroidY = 0;
  private lastScrollT = 0;

  // Accumulated wheel delta — only flushed when it's worth emitting (>= 1
  // wheel "tick" worth) so we don't spam the host with sub-pixel scrolls
  // that nut.js can't represent anyway.
  private wheelAccumX = 0;
  private wheelAccumY = 0;

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

    this.ensureCursor();
    this.renderCursor();
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.clearLongPress();
    this.stopInertia();
    this.pointers.clear();
    this.state = 'IDLE';
    this.videoEl.removeEventListener('pointerdown', this.onPointerDown);
    this.videoEl.removeEventListener('pointermove', this.onPointerMove);
    this.videoEl.removeEventListener('pointerup', this.onPointerUp);
    this.videoEl.removeEventListener('pointercancel', this.onPointerUp);
    this.videoEl.removeEventListener('contextmenu', this.preventEvent);
    if (this.cursorEl) {
      this.cursorEl.style.display = 'none';
    }
  }

  /** Reset cursor to center — useful after host switches monitor / resolution. */
  recenterCursor() {
    this.cursorX = 0.5;
    this.cursorY = 0.5;
    this.renderCursor();
    this.scheduleMove();
  }

  /**
   * Tell the touch handler the visual container is CSS-rotated. Pointer deltas
   * are reinterpreted so swipe direction always matches what the user sees on
   * the (rotated) screen, not the raw orientation of the phone glass.
   */
  setRotation(deg: 0 | 90 | -90) {
    this.rotation = deg;
    this.renderCursor();
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
    setTimeout(() => this.conn.sendInput(up), 30);
  }

  // === Virtual cursor overlay ===

  private ensureCursor() {
    if (this.cursorEl) {
      this.cursorEl.style.display = 'block';
      return;
    }
    const dot = document.createElement('div');
    dot.className = 'virtual-cursor';
    // Cursor must live OUTSIDE the rotated session container. Otherwise the
    // CSS transform on `.session` rotates the cursor a second time on top of
    // the rotated coords we compute from getBoundingClientRect (which are
    // already in viewport space). Appending to body keeps it in pure
    // viewport coords. pointer-events:none in CSS means it never swallows
    // the touch events that drive it.
    document.body.appendChild(dot);
    this.cursorEl = dot;
  }

  private renderCursor() {
    if (!this.cursorEl) return;
    // The video element lives inside a container that may be CSS-rotated 90°
    // or -90° via .session.rotate-cw / .rotate-ccw. We want the cursor dot
    // to sit on top of whatever pixel of the displayed (rotated) frame
    // matches (cursorX, cursorY).
    //
    // We can't just multiply by the bounding-client rect: for a rotated
    // element that returns the axis-aligned bounding box, with the rotated
    // content placed inside it. Instead, we read the rotated content's
    // intrinsic size from offsetWidth/offsetHeight (which CSS transforms do
    // NOT modify), pick the pixel inside that local space, then map to
    // viewport coords via getBoundingClientRect's center + the rotation.
    const rect = this.videoEl.getBoundingClientRect();
    const localW = this.videoEl.offsetWidth;
    const localH = this.videoEl.offsetHeight;
    const vw = this.videoEl.videoWidth || localW;
    const vh = this.videoEl.videoHeight || localH;

    // object-fit: contain — the actual video pixels are letterboxed inside
    // the element. Compute where they sit *in local (unrotated) space*.
    const videoAspect = vw / vh;
    const elementAspect = localW / localH;
    let renderW: number, renderH: number, offX = 0, offY = 0;
    if (videoAspect > elementAspect) {
      renderW = localW;
      renderH = localW / videoAspect;
      offY = (localH - renderH) / 2;
    } else {
      renderH = localH;
      renderW = localH * videoAspect;
      offX = (localW - renderW) / 2;
    }

    // Local point inside the unrotated element (origin = top-left).
    const lx = offX + this.cursorX * renderW;
    const ly = offY + this.cursorY * renderH;
    // Translate so origin = element center, then apply the rotation, then
    // translate to the bounding rect's center in viewport space.
    const ox = lx - localW / 2;
    const oy = ly - localH / 2;
    const cosA = this.rotation === 90 ? 0 : this.rotation === -90 ? 0 : 1;
    const sinA = this.rotation === 90 ? 1 : this.rotation === -90 ? -1 : 0;
    const rx = ox * cosA - oy * sinA;
    const ry = ox * sinA + oy * cosA;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    this.cursorEl.style.transform = `translate(${cx + rx}px, ${cy + ry}px)`;
  }

  private setCursorClass(name: string) {
    if (!this.cursorEl) return;
    this.cursorEl.className = `virtual-cursor ${name}`;
  }

  // === Send helpers ===

  /**
   * Send a mouse-move to the host *immediately* and schedule a cursor-overlay
   * repaint on the next frame. v1.3.x batched both into one rAF tick, which
   * added ~16 ms of input latency on top of the network RTT — perceptible
   * sluggishness even on a LAN. The host's input executor is happy to receive
   * 240 Hz of move packets; the data channel is unreliable+unordered with
   * priority='high' so flooding it just lets the latest position win.
   *
   * Cursor render still goes through rAF because reading offsetWidth /
   * getBoundingClientRect for the rotation-aware coord math triggers layout
   * on every call; coalescing to once per frame avoids jank.
   */
  private scheduleMove() {
    const msg: MouseMessage = {
      type: 'mouse',
      action: 'move',
      x: this.cursorX,
      y: this.cursorY,
    };
    this.conn.sendInput(msg);

    if (this.moveRafScheduled) return;
    this.moveRafScheduled = true;
    requestAnimationFrame(() => {
      this.moveRafScheduled = false;
      this.renderCursor();
    });
  }

  /**
   * Drain any pending move synchronously so a tap-then-click sequence can't
   * race past the host with `down` arriving before the latest `move`. Also
   * forces an immediate cursor-overlay repaint so the user sees where the
   * click landed without waiting for the next frame.
   */
  private flushMoveSync() {
    const msg: MouseMessage = {
      type: 'mouse',
      action: 'move',
      x: this.cursorX,
      y: this.cursorY,
    };
    this.conn.sendInput(msg);
    this.renderCursor();
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

  private emitWheel(dx: number, dy: number) {
    // Coalesce sub-tick deltas — nut.js / Windows scroll APIs can't represent
    // fractional wheel ticks anyway, so accumulate and emit when we cross 1.
    this.wheelAccumX += dx;
    this.wheelAccumY += dy;
    const intX = Math.trunc(this.wheelAccumX);
    const intY = Math.trunc(this.wheelAccumY);
    if (intX === 0 && intY === 0) return;
    this.wheelAccumX -= intX;
    this.wheelAccumY -= intY;
    const msg: MouseMessage = {
      type: 'mouse',
      action: 'scroll',
      x: this.cursorX,
      y: this.cursorY,
      deltaX: intX,
      deltaY: intY,
    };
    this.conn.sendInput(msg);
  }

  private vibrate(ms: number) {
    try {
      (navigator as any).vibrate?.(ms);
    } catch {
      // Some browsers (Safari) don't expose Vibration API; ignore.
    }
  }

  // === Pointer event handlers ===

  private preventEvent = (e: Event) => e.preventDefault();

  private onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    this.stopInertia();
    try {
      this.videoEl.setPointerCapture(e.pointerId);
    } catch {
      // older browsers — best effort
    }
    this.pointers.set(e.pointerId, {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startT: performance.now(),
      x: e.clientX,
      y: e.clientY,
      lastMoveT: performance.now(),
      moved: false,
    });

    const n = this.pointers.size;
    if (n === 1) {
      this.state = 'PEN';
      this.armLongPress(e.pointerId);
    } else if (n === 2) {
      this.clearLongPress();
      this.state = 'TWO_DOWN';
      this.recenterCentroid();
    } else if (n === 3) {
      this.state = 'THREE_DOWN';
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const now = performance.now();
    const dt = Math.max(1, now - p.lastMoveT);
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    p.lastMoveT = now;
    if (!p.moved && Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > TAP_SLOP_PX) {
      p.moved = true;
    }

    if (this.state === 'PEN' || this.state === 'PAN' || this.state === 'DRAGGING') {
      // 1-finger move — promote PEN to PAN once we've moved past slop.
      if (p.moved && this.state === 'PEN') {
        this.state = 'PAN';
        this.clearLongPress();
      }
      if (this.state === 'PAN' || this.state === 'DRAGGING') {
        this.applyPanDelta(dx, dy, dt);
      }
      return;
    }

    if (this.state === 'TWO_DOWN' || this.state === 'SCROLL') {
      // Once either pointer moves past slop, lock into SCROLL.
      const anyMoved = Array.from(this.pointers.values()).some((q) => q.moved);
      if (anyMoved && this.state === 'TWO_DOWN') {
        this.state = 'SCROLL';
        this.recenterCentroid();
      }
      if (this.state === 'SCROLL') {
        this.applyScrollDelta();
      }
      return;
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    try {
      this.videoEl.releasePointerCapture(e.pointerId);
    } catch {
      // already released — ignore
    }

    const elapsed = p ? performance.now() - p.startT : 0;
    const wasShortAndStill = !!p && !p.moved && elapsed < TAP_TIME_MS;
    const remaining = this.pointers.size;

    if (this.state === 'PEN') {
      this.clearLongPress();
      if (wasShortAndStill && remaining === 0) {
        this.handleSingleTap();
      }
      this.state = remaining === 0 ? 'IDLE' : this.state;
    } else if (this.state === 'PAN') {
      // No click — finger lifted while panning, host already received moves.
      if (remaining === 0) this.state = 'IDLE';
    } else if (this.state === 'DRAGGING') {
      if (remaining === 0) {
        this.flushMoveSync();
        this.emitButton('up', 'left');
        this.setCursorClass('idle');
        this.state = 'IDLE';
      }
    } else if (this.state === 'TWO_DOWN') {
      // Both fingers (or first of two) released without enough motion to be
      // a scroll → right click. Only fire when the *first* of the two lifts
      // — the second lift just returns to IDLE.
      if (wasShortAndStill && remaining <= 1) {
        // Cancel the other pointer's still-armed long-press.
        this.clearLongPress();
        this.flushMoveSync();
        this.emitButton('contextmenu', 'right');
        this.vibrate(8);
      }
      this.state = remaining === 0 ? 'IDLE' : remaining === 1 ? 'PEN' : this.state;
    } else if (this.state === 'SCROLL') {
      if (remaining < 2) {
        this.startInertia();
        this.state = remaining === 0 ? 'IDLE' : 'PEN';
      }
    } else if (this.state === 'THREE_DOWN') {
      // Three-finger tap → middle click on the first lift; suppress further
      // gestures from the remaining two until they all release.
      if (wasShortAndStill && remaining === 2) {
        this.flushMoveSync();
        this.emitButton('down', 'middle');
        this.emitButton('up', 'middle');
        this.vibrate(10);
      }
      if (remaining === 0) this.state = 'IDLE';
    }
  };

  // === Single-tap → click (or queued double-click) ===

  private handleSingleTap() {
    this.flushMoveSync();
    const now = performance.now();
    const dx = this.cursorX - this.lastTapX;
    const dy = this.cursorY - this.lastTapY;
    const closeEnough = Math.hypot(dx, dy) < 0.02; // 2% of screen
    if (now - this.lastTapTime < DBL_TAP_GAP_MS && closeEnough) {
      // Promote to double-click. Send dblclick *and* the down/up so apps that
      // listen on either signal both fire.
      this.emitButton('down', 'left');
      this.emitButton('up', 'left');
      this.emitButton('dblclick', 'left');
      this.lastTapTime = 0; // consume so a triple-tap doesn't keep promoting
      this.vibrate(6);
      return;
    }
    this.emitButton('down', 'left');
    this.emitButton('up', 'left');
    this.lastTapTime = now;
    this.lastTapX = this.cursorX;
    this.lastTapY = this.cursorY;
  }

  // === Long-press → DRAGGING ===

  private armLongPress(pointerId: number) {
    this.clearLongPress();
    this.longPressTimer = window.setTimeout(() => {
      const p = this.pointers.get(pointerId);
      if (!p || p.moved) return;
      if (this.pointers.size !== 1) return;
      this.flushMoveSync();
      this.emitButton('down', 'left');
      this.state = 'DRAGGING';
      this.setCursorClass('drag');
      this.vibrate(20);
    }, LONG_PRESS_MS);
  }

  private clearLongPress() {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  // === Pan with ballistics ===

  /**
   * Convert finger pixels into cursor-ratio delta. Linear gain handles slow
   * precise drags; an extra term proportional to *velocity* (px/ms) lets a
   * fast flick cover much more ground. The cap keeps a hard flick from
   * teleporting the cursor unpredictably.
   */
  private applyPanDelta(rawDx: number, rawDy: number, dtMs: number) {
    // Use offsetWidth/Height — those are the *unrotated* (local) element
    // dimensions. getBoundingClientRect on a rotated element returns the
    // axis-aligned bounding box, which has width/height swapped after a 90°
    // rotation; dividing by that would shrink/stretch cursor motion.
    const localW = this.videoEl.offsetWidth;
    const localH = this.videoEl.offsetHeight;
    if (localW <= 0 || localH <= 0) return;

    // Rotate finger delta into the rotated content's coordinate space so a
    // rightward swipe always moves the cursor right *as displayed*.
    const { dx, dy } = this.rotateDelta(rawDx, rawDy);

    const distance = Math.hypot(dx, dy);
    const velocity = distance / Math.max(1, dtMs); // px/ms
    const accel = PAN_LINEAR + Math.min(PAN_VELOCITY_CAP, PAN_VELOCITY_GAIN * velocity);
    this.cursorX = clamp01(this.cursorX + (dx * accel) / localW);
    this.cursorY = clamp01(this.cursorY + (dy * accel) / localH);
    this.scheduleMove();
  }

  private rotateDelta(dx: number, dy: number): { dx: number; dy: number } {
    if (this.rotation === 90) return { dx: dy, dy: -dx };
    if (this.rotation === -90) return { dx: -dy, dy: dx };
    return { dx, dy };
  }

  // === Scroll ===

  private recenterCentroid() {
    let sx = 0, sy = 0;
    for (const p of this.pointers.values()) {
      sx += p.x;
      sy += p.y;
    }
    const n = this.pointers.size || 1;
    this.lastCentroidX = sx / n;
    this.lastCentroidY = sy / n;
    this.lastScrollT = performance.now();
  }

  private applyScrollDelta() {
    let sx = 0, sy = 0;
    for (const p of this.pointers.values()) {
      sx += p.x;
      sy += p.y;
    }
    const n = this.pointers.size || 1;
    const cx = sx / n;
    const cy = sy / n;
    const rawDx = cx - this.lastCentroidX;
    const rawDy = cy - this.lastCentroidY;
    this.lastCentroidX = cx;
    this.lastCentroidY = cy;

    // Rotate the centroid delta the same way pan deltas are rotated, so
    // 2-finger vertical swipe scrolls vertically *as displayed*.
    const { dx: dxPx, dy: dyPx } = this.rotateDelta(rawDx, rawDy);

    const now = performance.now();
    const dt = Math.max(8, now - this.lastScrollT);
    this.lastScrollT = now;
    this.scrollVx = (dxPx / dt) * 16;
    this.scrollVy = (dyPx / dt) * 16;

    // Wheel direction matches finger direction inverted — like a touchpad's
    // "natural" scrolling on iOS.
    this.emitWheel(-dxPx / 18, -dyPx / 18);
  }

  // === Inertia scroll ===

  private startInertia() {
    if (Math.hypot(this.scrollVx, this.scrollVy) < 1.5) {
      // Below threshold — finger lift was deliberate, not a flick.
      this.scrollVx = 0;
      this.scrollVy = 0;
      return;
    }
    const tick = () => {
      const v = Math.hypot(this.scrollVx, this.scrollVy);
      if (v < INERTIA_MIN_VELOCITY || this.state === 'PAN' || this.state === 'DRAGGING') {
        this.stopInertia();
        return;
      }
      this.emitWheel(-this.scrollVx / 18, -this.scrollVy / 18);
      this.scrollVx *= INERTIA_DECAY;
      this.scrollVy *= INERTIA_DECAY;
      this.inertiaTimer = window.requestAnimationFrame(tick);
    };
    this.inertiaTimer = window.requestAnimationFrame(tick);
  }

  private stopInertia() {
    if (this.inertiaTimer != null) {
      cancelAnimationFrame(this.inertiaTimer);
      this.inertiaTimer = null;
    }
    this.scrollVx = 0;
    this.scrollVy = 0;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
