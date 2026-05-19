/**
 * InputHandler — Captures mouse/keyboard events from the video element
 * and sends them via data channel to the remote host for simulation.
 *
 * Mouse modes (toggled with Right-Ctrl, like VMware/Parsec):
 *   - Absolute (default): mouse moves on the video → host cursor jumps to
 *     that ratio of its screen. Simple, works without any browser API
 *     gating, but bypasses the host's native pointer acceleration so the
 *     feel doesn't match a local cursor.
 *   - Relative + Pointer Lock: e.movementX/Y captures raw OS-acceleration
 *     adjusted deltas; the host walks its real cursor by that delta. Result:
 *     the cursor under your hand feels like your local cursor — same speed,
 *     same accel curve — because the viewer's OS already applied them.
 *     Click on the video to lock; press ESC or Right-Ctrl to release.
 *
 * Clipboard sync:
 *   Ctrl+V → read viewer clipboard → send to host via system channel → host
 *            writes to its clipboard → host simulates Ctrl+V
 *   Ctrl+C → host simulates Ctrl+C → reads its clipboard → sends back to
 *            viewer → viewer writes to local clipboard
 */

import { CHANNEL_INPUT, CHANNEL_SYSTEM } from '../../shared/constants';
import { MouseMessage, KeyMessage } from '../../shared/protocol';
import { PeerConnection } from './webrtc';

export class InputHandler {
  private videoEl: HTMLVideoElement;
  private peer: PeerConnection;
  private enabled: boolean = false;
  // Track which keys / buttons the viewer is currently holding so we can
  // release them all if focus is lost. Without this, alt-tabbing away while
  // holding Ctrl leaves the host with a stuck Ctrl — every subsequent click
  // becomes Ctrl-click and the session feels frozen.
  private heldKeys: Set<string> = new Set();
  private heldButtons: Set<'left' | 'right' | 'middle'> = new Set();

  // Pointer-lock relative-motion mode. When the user clicks the video we
  // request pointer lock; movementX/Y then becomes raw OS-acceleration
  // adjusted deltas (already shaped by Windows' "Enhance pointer precision"
  // / macOS pointer accel) so the host cursor matches the local feel.
  private pointerLocked = false;
  // Viewer-side prediction of the remote cursor in normalized coords (0..1
  // of the host screen). Used for any 'down'/'up'/'click' messages we still
  // need to send during pointer-lock — those carry an x/y the host ignores
  // but reasonable values keep diagnostics readable. Starts at center;
  // updated by both absolute moves and accumulated relative deltas.
  private predictedX = 0.5;
  private predictedY = 0.5;
  // Hint overlay element shown when not locked, so the user knows to click.
  private hintEl: HTMLDivElement | null = null;

  constructor(videoEl: HTMLVideoElement, peer: PeerConnection) {
    this.videoEl = videoEl;
    this.peer = peer;
  }

  /**
   * Start capturing input events
   */
  enable(): void {
    if (this.enabled) return;
    this.enabled = true;

    // Hide the viewer's local OS cursor over the video. Electron's
    // desktopCapturer always bakes the host's real cursor into the video
    // stream, so if we left the local cursor visible the viewer would see
    // two pointers overlapping (their own + the captured host one).
    // Same approach as TeamViewer/AnyDesk/Parsec — show only the remote cursor.
    this.videoEl.style.cursor = 'none';
    this.videoEl.tabIndex = 0;
    this.videoEl.focus();

    // Mouse events
    this.videoEl.addEventListener('mousemove', this.onMouseMove);
    this.videoEl.addEventListener('mousedown', this.onMouseDown);
    this.videoEl.addEventListener('mouseup', this.onMouseUp);
    this.videoEl.addEventListener('dblclick', this.onDblClick);
    this.videoEl.addEventListener('contextmenu', this.onContextMenu);
    this.videoEl.addEventListener('wheel', this.onWheel, { passive: false });

    // Keyboard events
    this.videoEl.addEventListener('keydown', this.onKeyDown);
    this.videoEl.addEventListener('keyup', this.onKeyUp);

    // Keep focus
    this.videoEl.addEventListener('click', () => this.videoEl.focus());

    // Pointer-lock — relative-motion mode for matching local mouse feel.
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('pointerlockerror', this.onPointerLockError);

    this.ensureHint();
    this.updateHintVisibility();

    // Release stuck modifiers when the viewer window loses focus —
    // alt-tab, popup, or notification on the viewer side leaves the host
    // with phantom-held keys without this.
    window.addEventListener('blur', this.onWindowBlur);
    this.videoEl.addEventListener('blur', this.onWindowBlur);

    console.log('[Input] Handler enabled');
  }

  /**
   * Stop capturing
   */
  disable(): void {
    this.enabled = false;
    this.videoEl.style.cursor = 'default';

    // Drop pointer lock if held, so the user's cursor isn't stuck inside
    // the video element after the session ends.
    if (document.pointerLockElement === this.videoEl) {
      document.exitPointerLock?.();
    }
    this.pointerLocked = false;

    // Clean release any keys/buttons still tracked as held so the host
    // doesn't end up with stuck modifiers after the viewer disconnects.
    this.onWindowBlur();

    this.videoEl.removeEventListener('mousemove', this.onMouseMove);
    this.videoEl.removeEventListener('mousedown', this.onMouseDown);
    this.videoEl.removeEventListener('mouseup', this.onMouseUp);
    this.videoEl.removeEventListener('dblclick', this.onDblClick);
    this.videoEl.removeEventListener('contextmenu', this.onContextMenu);
    this.videoEl.removeEventListener('wheel', this.onWheel);
    this.videoEl.removeEventListener('keydown', this.onKeyDown);
    this.videoEl.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('pointerlockerror', this.onPointerLockError);
    window.removeEventListener('blur', this.onWindowBlur);
    this.videoEl.removeEventListener('blur', this.onWindowBlur);

    if (this.hintEl) {
      this.hintEl.remove();
      this.hintEl = null;
    }

    console.log('[Input] Handler disabled');
  }

  // === Pointer Lock ===

  /** Ask the browser for pointer lock on the video element. Idempotent. */
  private requestLock(): void {
    if (!this.enabled) return;
    if (document.pointerLockElement === this.videoEl) return;
    try {
      this.videoEl.requestPointerLock?.();
    } catch (err) {
      console.warn('[Input] requestPointerLock failed:', err);
    }
  }

  private onPointerLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.videoEl;
    this.updateHintVisibility();
    if (!this.pointerLocked) {
      // Lock dropped — release any held mouse buttons so a drag interrupted
      // by ESC doesn't leave the host with select-mode active.
      const lastX = this.predictedX;
      const lastY = this.predictedY;
      for (const button of this.heldButtons) {
        this.peer.send(CHANNEL_INPUT, {
          type: 'mouse', action: 'up', x: lastX, y: lastY, button,
        } as MouseMessage);
      }
      this.heldButtons.clear();
    }
  };

  private onPointerLockError = () => {
    console.warn('[Input] Pointer lock denied — falling back to absolute mode');
    this.pointerLocked = false;
    this.updateHintVisibility();
  };

  /** Floating hint shown over the video when not locked. */
  private ensureHint(): void {
    if (this.hintEl) return;
    const div = document.createElement('div');
    div.className = 'pointer-lock-hint';
    div.textContent = 'Nhấn vào đây để bắt chuột (ESC để thoát)';
    div.style.cssText =
      'position:absolute;top:12px;left:50%;transform:translateX(-50%);' +
      'background:rgba(0,0,0,0.66);color:#fff;font-size:12px;padding:6px 14px;' +
      'border-radius:14px;pointer-events:none;z-index:50;backdrop-filter:blur(4px);' +
      'opacity:0;transition:opacity .25s;font-weight:500;letter-spacing:.2px;';
    const wrapper = this.videoEl.parentElement;
    if (wrapper) {
      // Make sure the hint can be positioned inside the wrapper.
      if (getComputedStyle(wrapper).position === 'static') {
        wrapper.style.position = 'relative';
      }
      wrapper.appendChild(div);
    } else {
      document.body.appendChild(div);
    }
    this.hintEl = div;
  }

  private updateHintVisibility(): void {
    if (!this.hintEl) return;
    this.hintEl.style.opacity = this.pointerLocked || !this.enabled ? '0' : '1';
  }

  /**
   * Get relative coordinates (0-1) from mouse event on video
   */
  private getRelativeCoords(e: MouseEvent): { x: number; y: number } {
    const rect = this.videoEl.getBoundingClientRect();
    const { w: renderWidth, h: renderHeight, offX, offY } = this.getRenderedSize(rect);
    const localX = e.clientX - rect.left - offX;
    const localY = e.clientY - rect.top - offY;
    return {
      x: Math.max(0, Math.min(1, localX / renderWidth)),
      y: Math.max(0, Math.min(1, localY / renderHeight)),
    };
  }

  /**
   * Account for object-fit: contain — return the size of the actual video
   * pixels inside the element, plus the letterbox offset. Shared between
   * absolute coord mapping and relative-delta normalization so a movement
   * of N px maps to the same fraction in both modes.
   */
  private getRenderedSize(rect: DOMRect): { w: number; h: number; offX: number; offY: number } {
    const videoWidth = this.videoEl.videoWidth || rect.width;
    const videoHeight = this.videoEl.videoHeight || rect.height;
    const videoAspect = videoWidth / videoHeight;
    const elementAspect = rect.width / rect.height;
    let w: number, h: number, offX = 0, offY = 0;
    if (videoAspect > elementAspect) {
      w = rect.width;
      h = rect.width / videoAspect;
      offY = (rect.height - h) / 2;
    } else {
      h = rect.height;
      w = rect.height * videoAspect;
      offX = (rect.width - w) / 2;
    }
    return { w, h, offX, offY };
  }

  private getButton(e: MouseEvent): 'left' | 'right' | 'middle' {
    if (e.button === 2) return 'right';
    if (e.button === 1) return 'middle';
    return 'left';
  }

  private getModifiers(e: KeyboardEvent): ('ctrl' | 'alt' | 'shift' | 'meta')[] {
    const mods: ('ctrl' | 'alt' | 'shift' | 'meta')[] = [];
    if (e.ctrlKey) mods.push('ctrl');
    if (e.altKey) mods.push('alt');
    if (e.shiftKey) mods.push('shift');
    if (e.metaKey) mods.push('meta');
    return mods;
  }

  /**
   * Check if this is a clipboard shortcut (Ctrl+C, Ctrl+V, Ctrl+X)
   */
  private isClipboardShortcut(e: KeyboardEvent): 'copy' | 'paste' | 'cut' | null {
    const isCtrl = e.ctrlKey || e.metaKey;
    if (!isCtrl) return null;
    const k = e.key.toLowerCase();
    if (k === 'v') return 'paste';
    if (k === 'c') return 'copy';
    if (k === 'x') return 'cut';
    return null;
  }

  // === Mouse Handlers ===

  /**
   * Mouse move dispatch. Two paths share the same handler so we can react
   * instantly when the user toggles pointer-lock mid-session:
   *
   *   - Locked: e.movementX/Y holds OS-acceleration-adjusted deltas (Windows
   *     "Enhance pointer precision" / macOS pointer accel already baked in).
   *     We normalize by the rendered video size and ship as 'move-rel'. The
   *     host walks its real cursor by that fraction, so the speed and accel
   *     curve track the viewer's local mouse exactly.
   *
   *   - Not locked: fall back to absolute positioning. The cursor jumps to
   *     wherever the pointer is on the video — useful before the user has
   *     clicked to engage lock, or after pressing ESC.
   *
   * No rAF batching here. The host data channel is unreliable+unordered,
   * priority='high'; flooding lets the latest delta arrive ASAP. The 16 ms
   * round-trip rAF added in v1.x was a measurable contributor to the
   * "heavy" feel users reported.
   */
  private onMouseMove = (e: MouseEvent) => {
    if (this.pointerLocked) {
      const rect = this.videoEl.getBoundingClientRect();
      const renderSize = this.getRenderedSize(rect);
      if (renderSize.w <= 0 || renderSize.h <= 0) return;
      const dx = e.movementX / renderSize.w;
      const dy = e.movementY / renderSize.h;
      if (dx === 0 && dy === 0) return;
      this.predictedX = Math.max(0, Math.min(1, this.predictedX + dx));
      this.predictedY = Math.max(0, Math.min(1, this.predictedY + dy));
      const msg: MouseMessage = {
        type: 'mouse', action: 'move-rel',
        x: 0, y: 0, deltaX: dx, deltaY: dy,
      };
      this.peer.send(CHANNEL_INPUT, msg);
      return;
    }

    const { x, y } = this.getRelativeCoords(e);
    this.predictedX = x;
    this.predictedY = y;
    const msg: MouseMessage = { type: 'mouse', action: 'move', x, y };
    this.peer.send(CHANNEL_INPUT, msg);
  };

  private onMouseDown = (e: MouseEvent) => {
    // Click-to-lock when not locked yet. Skip the lock request if the host
    // is in view-only mode — the input handler would already be disabled in
    // that case but defending here keeps the lock indicator out of weird
    // states if the connection bounces.
    if (!this.pointerLocked) {
      this.requestLock();
    }
    const button = this.getButton(e);
    this.heldButtons.add(button);
    const msg: MouseMessage = {
      type: 'mouse', action: 'down',
      x: this.predictedX, y: this.predictedY,
      button,
    };
    this.peer.send(CHANNEL_INPUT, msg);
  };

  private onMouseUp = (e: MouseEvent) => {
    const button = this.getButton(e);
    this.heldButtons.delete(button);
    const msg: MouseMessage = {
      type: 'mouse', action: 'up',
      x: this.predictedX, y: this.predictedY,
      button,
    };
    this.peer.send(CHANNEL_INPUT, msg);
  };

  private onDblClick = (e: MouseEvent) => {
    e.preventDefault();
    const msg: MouseMessage = {
      type: 'mouse', action: 'dblclick',
      x: this.predictedX, y: this.predictedY,
    };
    this.peer.send(CHANNEL_INPUT, msg);
  };

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const msg: MouseMessage = {
      type: 'mouse', action: 'contextmenu',
      x: this.predictedX, y: this.predictedY,
    };
    this.peer.send(CHANNEL_INPUT, msg);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const msg: MouseMessage = {
      type: 'mouse', action: 'scroll',
      x: this.predictedX, y: this.predictedY,
      deltaX: Math.sign(e.deltaX) * 3,
      deltaY: Math.sign(e.deltaY) * 3,
    };
    this.peer.send(CHANNEL_INPUT, msg);
  };

  // === Keyboard Handlers ===

  private onKeyDown = (e: KeyboardEvent) => {
    e.preventDefault();

    const clipAction = this.isClipboardShortcut(e);

    if (clipAction === 'paste') {
      // Ctrl+V: Read viewer clipboard → send to host → host pastes
      this.handlePaste();
      return;
    }

    if (clipAction === 'copy' || clipAction === 'cut') {
      // Ctrl+C / Ctrl+X: Send keystroke to host → then request clipboard back
      this.handleCopyOrCut(e, clipAction);
      return;
    }

    // Normal key — send as-is
    this.heldKeys.add(e.code);
    const msg: KeyMessage = {
      type: 'key', action: 'down',
      key: e.key, code: e.code,
      modifiers: this.getModifiers(e),
    };
    this.peer.send(CHANNEL_INPUT, msg);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    e.preventDefault();

    // Skip key-up for clipboard shortcuts that were intercepted on key-down.
    // The host side already received the full key sequence via the system
    // channel, so sending an orphan key-up would confuse the nut.js simulator.
    if (this.isClipboardShortcut(e)) return;

    this.heldKeys.delete(e.code);
    const msg: KeyMessage = {
      type: 'key', action: 'up',
      key: e.key, code: e.code,
      modifiers: this.getModifiers(e),
    };
    this.peer.send(CHANNEL_INPUT, msg);
  };

  /**
   * Release every held key + button when the viewer window loses focus.
   *
   * Without this, the OS stops delivering keyup to the video element while
   * focus is elsewhere — modifier keys held during the focus loss become
   * "stuck" on the host. Every subsequent click then becomes Ctrl-click /
   * Shift-click and the session feels frozen even though packets are still
   * flowing. Same fix as VNC viewers and Parsec apply when the window blurs.
   */
  private onWindowBlur = () => {
    if (!this.enabled) return;
    if (this.heldKeys.size === 0 && this.heldButtons.size === 0) return;
    console.log('[Input] Window blurred — releasing', this.heldKeys.size, 'keys,', this.heldButtons.size, 'buttons');
    for (const code of this.heldKeys) {
      this.peer.send(CHANNEL_INPUT, {
        type: 'key', action: 'up',
        key: this.codeToKey(code), code,
        modifiers: [],
      } as KeyMessage);
    }
    this.heldKeys.clear();

    // Release any held mouse buttons at the last known coordinates so a
    // drag interrupted by a popup doesn't leave the host in select-mode.
    const lastX = this.predictedX;
    const lastY = this.predictedY;
    for (const button of this.heldButtons) {
      this.peer.send(CHANNEL_INPUT, {
        type: 'mouse', action: 'up', x: lastX, y: lastY, button,
      } as MouseMessage);
    }
    this.heldButtons.clear();
  };

  /**
   * Best-effort reverse map from KeyboardEvent.code → KeyboardEvent.key for
   * the synthetic key-up packets we emit on blur. The host's input
   * simulator keys off `code` first, so the recovered `key` only needs
   * to be plausible.
   */
  private codeToKey(code: string): string {
    if (code.startsWith('Key')) return code.slice(3).toLowerCase();
    if (code.startsWith('Digit')) return code.slice(5);
    const map: Record<string, string> = {
      ControlLeft: 'Control', ControlRight: 'Control',
      ShiftLeft: 'Shift', ShiftRight: 'Shift',
      AltLeft: 'Alt', AltRight: 'Alt',
      MetaLeft: 'Meta', MetaRight: 'Meta',
      Space: ' ', Enter: 'Enter', Escape: 'Escape',
      Backspace: 'Backspace', Tab: 'Tab', Delete: 'Delete',
    };
    return map[code] || code;
  }

  // === Clipboard Sync ===

  /**
   * Viewer presses Ctrl+V:
   * 1. Read viewer's local clipboard
   * 2. Send clipboard text to host via system channel
   * 3. Host will write to its clipboard then simulate Ctrl+V
   */
  private async handlePaste(): Promise<void> {
    try {
      const text = await window.titanAPI?.clipboard?.read();
      if (text != null) {
        this.peer.send(CHANNEL_SYSTEM, {
          type: 'system',
          action: 'clipboard',
          data: { direction: 'viewer-to-host', text },
        });
        console.log('[Input] Clipboard paste sent to host', text.length, 'chars');
      }
    } catch (err) {
      console.error('[Input] Failed to read clipboard for paste:', err);
    }
  }

  /**
   * Viewer presses Ctrl+C or Ctrl+X:
   * 1. Send the keystroke to host so it copies/cuts on its side
   * 2. Request host to read its clipboard and send it back
   */
  private handleCopyOrCut(e: KeyboardEvent, action: 'copy' | 'cut'): void {
    // Send the actual Ctrl+C / Ctrl+X keystrokes to the host
    const downMsg: KeyMessage = {
      type: 'key', action: 'down',
      key: e.key, code: e.code,
      modifiers: this.getModifiers(e),
    };
    this.peer.send(CHANNEL_INPUT, downMsg);

    // After a short delay, ask host to read its clipboard and send it back
    setTimeout(() => {
      this.peer.send(CHANNEL_SYSTEM, {
        type: 'system',
        action: 'clipboard',
        data: { direction: 'request-from-host' },
      });
      console.log(`[Input] Clipboard ${action} — requested host clipboard`);
    }, 200);
  }
}
