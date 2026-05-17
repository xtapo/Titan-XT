/**
 * InputHandler — Captures mouse/keyboard events from the video element
 * and sends them via data channel to the remote host for simulation.
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
  private lastMoveTime: number = 0;
  // 8ms ≈ 120 Hz. Cursor moves are tiny payloads on an unreliable channel,
  // so we'd rather oversample than feel laggy. Coalesced events also use
  // this same throttle bucket via getCoalescedEvents().
  private moveThrottleMs: number = 8;
  // Latest pending mouse move — flushed on the next animation frame so we
  // never send more than one move per repaint, no matter how fast the OS
  // delivers events.
  private pendingMove: { x: number; y: number; clientX: number; clientY: number } | null = null;
  private moveRafScheduled: boolean = false;
  // Track which keys / buttons the viewer is currently holding so we can
  // release them all if focus is lost. Without this, alt-tabbing away while
  // holding Ctrl leaves the host with a stuck Ctrl — every subsequent click
  // becomes Ctrl-click and the session feels frozen.
  private heldKeys: Set<string> = new Set();
  private heldButtons: Set<'left' | 'right' | 'middle'> = new Set();

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
    window.removeEventListener('blur', this.onWindowBlur);
    this.videoEl.removeEventListener('blur', this.onWindowBlur);

    console.log('[Input] Handler disabled');
  }

  /**
   * Get relative coordinates (0-1) from mouse event on video
   */
  private getRelativeCoords(e: MouseEvent): { x: number; y: number } {
    const rect = this.videoEl.getBoundingClientRect();
    const videoWidth = this.videoEl.videoWidth || rect.width;
    const videoHeight = this.videoEl.videoHeight || rect.height;

    // Account for object-fit: contain
    const videoAspect = videoWidth / videoHeight;
    const elementAspect = rect.width / rect.height;

    let renderWidth: number, renderHeight: number;
    let offsetX = 0, offsetY = 0;

    if (videoAspect > elementAspect) {
      renderWidth = rect.width;
      renderHeight = rect.width / videoAspect;
      offsetY = (rect.height - renderHeight) / 2;
    } else {
      renderHeight = rect.height;
      renderWidth = rect.height * videoAspect;
      offsetX = (rect.width - renderWidth) / 2;
    }

    const localX = e.clientX - rect.left - offsetX;
    const localY = e.clientY - rect.top - offsetY;

    return {
      x: Math.max(0, Math.min(1, localX / renderWidth)),
      y: Math.max(0, Math.min(1, localY / renderHeight)),
    };
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
   * Coalesced + rAF-paced mouse move.
   * Browsers can fire mousemove far more often than the screen repaints
   * (especially with high-poll mice). Coalescing into one packet per frame
   * keeps the data channel clean.
   */
  private onMouseMove = (e: MouseEvent) => {
    const { x, y } = this.getRelativeCoords(e);
    this.pendingMove = { x, y, clientX: e.clientX, clientY: e.clientY };

    // Hard rate-limit raw send rate as a backstop — even with rAF coalescing,
    // a foregrounded tab can repaint at 240 Hz on some monitors.
    const now = performance.now();
    if (now - this.lastMoveTime < this.moveThrottleMs) {
      this.scheduleMoveFlush();
      return;
    }
    this.lastMoveTime = now;
    this.scheduleMoveFlush();
  };

  /**
   * Flush the latest pending move on the next animation frame.
   * Multiple mousemove events between frames collapse into a single send.
   */
  private scheduleMoveFlush(): void {
    if (this.moveRafScheduled) return;
    this.moveRafScheduled = true;
    requestAnimationFrame(() => {
      this.moveRafScheduled = false;
      const move = this.pendingMove;
      this.pendingMove = null;
      if (!move) return;
      const msg: MouseMessage = { type: 'mouse', action: 'move', x: move.x, y: move.y };
      this.peer.send(CHANNEL_INPUT, msg);
    });
  }

  /**
   * Drain the pending move synchronously. Called before any button event so
   * a fast move-then-click sequence can never reach the host with `down`
   * before the latest `move` — otherwise the click would land at the
   * previous coalesce'd position. Trade: one extra packet per click, but
   * input correctness comes first.
   */
  private flushMoveSync(): void {
    const move = this.pendingMove;
    if (!move) return;
    this.pendingMove = null;
    const msg: MouseMessage = { type: 'mouse', action: 'move', x: move.x, y: move.y };
    this.peer.send(CHANNEL_INPUT, msg);
  }

  private onMouseDown = (e: MouseEvent) => {
    this.flushMoveSync();
    const { x, y } = this.getRelativeCoords(e);
    const button = this.getButton(e);
    this.heldButtons.add(button);
    const msg: MouseMessage = {
      type: 'mouse', action: 'down', x, y,
      button,
    };
    this.peer.send(CHANNEL_INPUT, msg);
  };

  private onMouseUp = (e: MouseEvent) => {
    this.flushMoveSync();
    const { x, y } = this.getRelativeCoords(e);
    const button = this.getButton(e);
    this.heldButtons.delete(button);
    const msg: MouseMessage = {
      type: 'mouse', action: 'up', x, y,
      button,
    };
    this.peer.send(CHANNEL_INPUT, msg);
  };

  private onDblClick = (e: MouseEvent) => {
    e.preventDefault();
    this.flushMoveSync();
    const { x, y } = this.getRelativeCoords(e);
    const msg: MouseMessage = { type: 'mouse', action: 'dblclick', x, y };
    this.peer.send(CHANNEL_INPUT, msg);
  };

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    this.flushMoveSync();
    const { x, y } = this.getRelativeCoords(e);
    const msg: MouseMessage = { type: 'mouse', action: 'contextmenu', x, y };
    this.peer.send(CHANNEL_INPUT, msg);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.flushMoveSync();
    const { x, y } = this.getRelativeCoords(e);
    const msg: MouseMessage = {
      type: 'mouse', action: 'scroll', x, y,
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
    const lastX = this.pendingMove?.x ?? 0;
    const lastY = this.pendingMove?.y ?? 0;
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
