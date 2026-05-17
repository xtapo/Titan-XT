/**
 * InputHandler — Captures mouse/keyboard events from the video element
 * and sends them via data channel to the remote host for simulation
 */

import { CHANNEL_INPUT } from '../../shared/constants';
import { MouseMessage, KeyMessage } from '../../shared/protocol';
import { PeerConnection } from './webrtc';

export class InputHandler {
  private videoEl: HTMLVideoElement;
  private peer: PeerConnection;
  private enabled: boolean = false;
  private pendingMove: { x: number; y: number } | null = null;
  private rafHandle: number | null = null;

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

    console.log('[Input] Handler enabled');
  }

  /**
   * Stop capturing
   */
  disable(): void {
    this.enabled = false;
    this.videoEl.style.cursor = 'default';

    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.pendingMove = null;

    this.videoEl.removeEventListener('mousemove', this.onMouseMove);
    this.videoEl.removeEventListener('mousedown', this.onMouseDown);
    this.videoEl.removeEventListener('mouseup', this.onMouseUp);
    this.videoEl.removeEventListener('dblclick', this.onDblClick);
    this.videoEl.removeEventListener('contextmenu', this.onContextMenu);
    this.videoEl.removeEventListener('wheel', this.onWheel);
    this.videoEl.removeEventListener('keydown', this.onKeyDown);
    this.videoEl.removeEventListener('keyup', this.onKeyUp);

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

  // === Mouse Handlers ===

  private onMouseMove = (e: MouseEvent) => {
    // Coalesce moves to one per frame. Sending every mousemove (~120-1000Hz)
    // floods the data channel and the host's nut.js queue, causing visible lag.
    this.pendingMove = this.getRelativeCoords(e);
    if (this.rafHandle !== null) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      if (!this.pendingMove) return;
      const msg: MouseMessage = { type: 'mouse', action: 'move', ...this.pendingMove };
      this.pendingMove = null;
      this.peer.send(CHANNEL_INPUT, msg);
    });
  };

  private onMouseDown = (e: MouseEvent) => {
    const { x, y } = this.getRelativeCoords(e);
    const msg: MouseMessage = {
      type: 'mouse', action: 'click', x, y,
      button: this.getButton(e),
    };
    this.peer.send(CHANNEL_INPUT, msg);
  };

  private onMouseUp = (_e: MouseEvent) => {
    // Could send mouse-up for drag support
  };

  private onDblClick = (e: MouseEvent) => {
    e.preventDefault();
    const { x, y } = this.getRelativeCoords(e);
    const msg: MouseMessage = { type: 'mouse', action: 'dblclick', x, y };
    this.peer.send(CHANNEL_INPUT, msg);
  };

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const { x, y } = this.getRelativeCoords(e);
    const msg: MouseMessage = { type: 'mouse', action: 'contextmenu', x, y };
    this.peer.send(CHANNEL_INPUT, msg);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
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
    const msg: KeyMessage = {
      type: 'key', action: 'down',
      key: e.key, code: e.code,
      modifiers: this.getModifiers(e),
    };
    this.peer.send(CHANNEL_INPUT, msg);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    e.preventDefault();
    const msg: KeyMessage = {
      type: 'key', action: 'up',
      key: e.key, code: e.code,
      modifiers: this.getModifiers(e),
    };
    this.peer.send(CHANNEL_INPUT, msg);
  };
}
