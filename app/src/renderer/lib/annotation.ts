/**
 * Viewer-side annotation controller.
 *
 * Mounts a canvas overlay over the remote video element so the viewer can
 * draw arrows / boxes / pen strokes during a remote-support call. Each
 * stroke is mirrored to the host over CHANNEL_ANNOTATION (see ConnectionManager.sendAnnotation),
 * which paints the same shape on a transparent click-through window over
 * the host's actual desktop. UltraViewer / TeamViewer call this "screen
 * drawing"; same idea here.
 *
 * Design notes:
 *   - Coordinates sent to the host are 0-1 ratios of the source video frame.
 *     The host overlay scales them to its native resolution, so the marks
 *     line up with what the host sees on its real desktop even when the
 *     viewer sees a downscaled copy.
 *   - Pointermove is rate-limited via ANNOTATION_POINT_THROTTLE_MS so a fast
 *     wrist on a 1000Hz mouse can't flood the data channel.
 *   - Local strokes fade after the same window the host uses, so the
 *     viewer's view of their own marks matches the host's view.
 */

import { showToast } from '../components/toast';
import {
  ANNOTATION_FADE_MS,
  ANNOTATION_POINT_THROTTLE_MS,
} from '../../shared/constants';
import type {
  AnnotationMessage,
  AnnotationTool,
} from '../../shared/protocol';

interface ViewerStroke {
  id: string;
  tool: AnnotationTool;
  color: string;
  width: number;
  points: Array<{ x: number; y: number }>;
  startedAt: number;
  ended: boolean;
}

const FADE_TAIL_MS = 1200;

export class AnnotationController {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private wrapper: HTMLElement | null = null;
  private toolbar: HTMLElement | null = null;
  private active: boolean = false;
  private tool: AnnotationTool = 'arrow';
  private color: string = '#ff3b3b';
  private width: number = 4;

  private strokes: Map<string, ViewerStroke> = new Map();
  private currentStrokeId: string | null = null;
  private lastPointSentAt: number = 0;
  private rafHandle: number | null = null;

  // Bound listener handles so add/remove pair up cleanly.
  private boundPointerDown = (e: PointerEvent) => this.onPointerDown(e);
  private boundPointerMove = (e: PointerEvent) => this.onPointerMove(e);
  private boundPointerUp = (e: PointerEvent) => this.onPointerUp(e);
  private boundResize = () => this.resizeCanvas();

  // Sender wired by the page once a session connects. Kept as a callback so
  // this module doesn't pull a circular dep on ConnectionManager.
  private send: ((msg: AnnotationMessage) => void) | null = null;

  /**
   * Mount the canvas + toolbar inside the given video wrapper. Idempotent —
   * calling again with the same wrapper is a no-op.
   */
  attach(wrapper: HTMLElement, send: (msg: AnnotationMessage) => void): void {
    if (this.wrapper === wrapper && this.canvas) {
      this.send = send;
      return;
    }
    this.detach();

    this.wrapper = wrapper;
    this.send = send;

    const canvas = document.createElement('canvas');
    canvas.className = 'annotation-canvas hidden';
    wrapper.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.toolbar = this.buildToolbar();
    wrapper.appendChild(this.toolbar);

    window.addEventListener('resize', this.boundResize);
    this.resizeCanvas();
  }

  detach(): void {
    this.disable();
    if (this.canvas?.parentElement) this.canvas.parentElement.removeChild(this.canvas);
    if (this.toolbar?.parentElement) this.toolbar.parentElement.removeChild(this.toolbar);
    window.removeEventListener('resize', this.boundResize);
    this.canvas = null;
    this.ctx = null;
    this.toolbar = null;
    this.wrapper = null;
    this.strokes.clear();
  }

  /**
   * Public toggle wired to the toolbar's brush button. When enabled, the
   * canvas swallows pointer events so input doesn't reach the remote-control
   * input handler — drawing and remote-control are mutually exclusive
   * because both want the same gestures.
   */
  toggle(): void {
    if (this.active) this.disable();
    else this.enable();
  }

  enable(): void {
    if (this.active || !this.canvas) return;
    this.active = true;
    this.canvas.classList.remove('hidden');
    this.toolbar?.classList.add('annotation-toolbar-active');
    this.canvas.addEventListener('pointerdown', this.boundPointerDown);
    this.canvas.addEventListener('pointermove', this.boundPointerMove);
    this.canvas.addEventListener('pointerup', this.boundPointerUp);
    this.canvas.addEventListener('pointercancel', this.boundPointerUp);
    this.scheduleRender();
    showToast('Đang vẽ — gestures sẽ không điều khiển máy đối tác', 'info');
  }

  disable(): void {
    if (!this.active) return;
    this.active = false;
    this.canvas?.classList.add('hidden');
    this.toolbar?.classList.remove('annotation-toolbar-active');
    if (this.canvas) {
      this.canvas.removeEventListener('pointerdown', this.boundPointerDown);
      this.canvas.removeEventListener('pointermove', this.boundPointerMove);
      this.canvas.removeEventListener('pointerup', this.boundPointerUp);
      this.canvas.removeEventListener('pointercancel', this.boundPointerUp);
    }
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.currentStrokeId = null;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Wipe local + remote strokes. Bound to the toolbar's "clear" button. */
  clear(): void {
    this.strokes.clear();
    if (this.canvas && this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.send?.({ type: 'annotation', action: 'clear' });
  }

  // === Toolbar =============================================================

  private buildToolbar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'annotation-toolbar hidden';
    bar.innerHTML = `
      <button class="annotation-toolbar-btn annotation-tool-btn" data-tool="arrow" title="Mũi tên">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="5" y1="19" x2="19" y2="5"/><polyline points="9 5 19 5 19 15"/>
        </svg>
      </button>
      <button class="annotation-toolbar-btn annotation-tool-btn" data-tool="pen" title="Bút">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
        </svg>
      </button>
      <button class="annotation-toolbar-btn annotation-tool-btn" data-tool="rect" title="Khung chữ nhật">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="4" y="4" width="16" height="16" rx="1"/>
        </svg>
      </button>
      <button class="annotation-toolbar-btn annotation-tool-btn" data-tool="highlight" title="Highlight">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 21l3-3 12-12 3 3-12 12z"/><line x1="14" y1="6" x2="18" y2="10"/>
        </svg>
      </button>
      <span class="annotation-toolbar-sep"></span>
      <button class="annotation-toolbar-color" data-color="#ff3b3b" style="background:#ff3b3b" title="Đỏ"></button>
      <button class="annotation-toolbar-color" data-color="#ffd60a" style="background:#ffd60a" title="Vàng"></button>
      <button class="annotation-toolbar-color" data-color="#34d399" style="background:#34d399" title="Lá"></button>
      <button class="annotation-toolbar-color" data-color="#3b82f6" style="background:#3b82f6" title="Lam"></button>
      <span class="annotation-toolbar-sep"></span>
      <button class="annotation-toolbar-btn" data-action="clear" title="Xóa hết">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
        </svg>
      </button>
      <button class="annotation-toolbar-btn annotation-toolbar-close" data-action="exit" title="Thoát chế độ vẽ">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;
    this.refreshToolbarSelection(bar);

    bar.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('button') as HTMLElement | null;
      if (!target) return;
      const t = target.dataset.tool as AnnotationTool | undefined;
      const c = target.dataset.color;
      const a = target.dataset.action;
      if (t) {
        this.tool = t;
      } else if (c) {
        this.color = c;
      } else if (a === 'clear') {
        this.clear();
      } else if (a === 'exit') {
        this.disable();
      }
      this.refreshToolbarSelection(bar);
    });

    return bar;
  }

  private refreshToolbarSelection(bar: HTMLElement): void {
    bar.querySelectorAll<HTMLElement>('[data-tool]').forEach((el) => {
      el.classList.toggle('annotation-toolbar-btn-active', el.dataset.tool === this.tool);
    });
    bar.querySelectorAll<HTMLElement>('[data-color]').forEach((el) => {
      el.classList.toggle('annotation-toolbar-color-active', el.dataset.color === this.color);
    });
  }

  // === Canvas + drawing ====================================================

  private resizeCanvas(): void {
    if (!this.canvas || !this.ctx || !this.wrapper) return;
    const rect = this.wrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * Map a pointer event into 0-1 video-frame coordinates. Note this uses the
   * canvas bounding rect (which matches the wrapper), not the video element
   * itself, because contain-mode video can letterbox — the ratio we send
   * targets the visible area, which is also what the host overlay covers.
   */
  private toRatio(e: PointerEvent): { x: number; y: number } | null {
    if (!this.canvas) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    };
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.active || e.button !== 0) return;
    const p = this.toRatio(e);
    if (!p) return;
    e.preventDefault();
    this.canvas?.setPointerCapture(e.pointerId);

    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.currentStrokeId = id;
    this.strokes.set(id, {
      id,
      tool: this.tool,
      color: this.color,
      width: this.width,
      points: [p],
      startedAt: Date.now(),
      ended: false,
    });

    this.send?.({
      type: 'annotation',
      action: 'begin',
      strokeId: id,
      tool: this.tool,
      color: this.color,
      width: this.width,
      x: p.x,
      y: p.y,
    });
    this.lastPointSentAt = performance.now();
    this.scheduleRender();
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.active || !this.currentStrokeId) return;
    const stroke = this.strokes.get(this.currentStrokeId);
    if (!stroke) return;
    const p = this.toRatio(e);
    if (!p) return;

    // For shape tools (rect / arrow), only the first + last points matter,
    // so we replace the trailing point in-place to avoid wasting memory and
    // bandwidth on every intermediate sample.
    if (stroke.tool === 'rect' || stroke.tool === 'arrow') {
      if (stroke.points.length === 1) stroke.points.push(p);
      else stroke.points[stroke.points.length - 1] = p;
    } else {
      stroke.points.push(p);
    }
    stroke.startedAt = Date.now();

    const now = performance.now();
    if (now - this.lastPointSentAt >= ANNOTATION_POINT_THROTTLE_MS) {
      this.send?.({
        type: 'annotation',
        action: 'point',
        strokeId: stroke.id,
        x: p.x,
        y: p.y,
      });
      this.lastPointSentAt = now;
    }
    this.scheduleRender();
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.active || !this.currentStrokeId) return;
    const stroke = this.strokes.get(this.currentStrokeId);
    if (stroke) {
      const p = this.toRatio(e);
      if (p) {
        // Make sure the final point reaches the host even if the throttle
        // window swallowed it — otherwise the rendered shape's endpoint can
        // be stale by up to one throttle interval.
        if (stroke.tool === 'rect' || stroke.tool === 'arrow') {
          if (stroke.points.length === 1) stroke.points.push(p);
          else stroke.points[stroke.points.length - 1] = p;
        } else {
          stroke.points.push(p);
        }
        this.send?.({
          type: 'annotation',
          action: 'point',
          strokeId: stroke.id,
          x: p.x,
          y: p.y,
        });
      }
      stroke.ended = true;
      stroke.startedAt = Date.now();
    }
    this.send?.({
      type: 'annotation',
      action: 'end',
      strokeId: this.currentStrokeId,
    });
    this.currentStrokeId = null;
    try {
      this.canvas?.releasePointerCapture(e.pointerId);
    } catch {
      // pointer was already released — ignore
    }
    this.scheduleRender();
  }

  // === Rendering ===========================================================

  private scheduleRender(): void {
    if (this.rafHandle !== null) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      this.render();
    });
  }

  private render(): void {
    if (!this.canvas || !this.ctx || !this.wrapper) return;
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const now = Date.now();
    const expired: string[] = [];

    for (const stroke of this.strokes.values()) {
      const age = now - stroke.startedAt;
      if (stroke.ended && age >= ANNOTATION_FADE_MS) {
        expired.push(stroke.id);
        continue;
      }
      let alpha = 1;
      if (stroke.ended) {
        const remaining = ANNOTATION_FADE_MS - age;
        if (remaining < FADE_TAIL_MS) {
          alpha = Math.max(0, remaining / FADE_TAIL_MS);
        }
      }
      ctx.save();
      ctx.globalAlpha = alpha;
      this.drawStroke(stroke, w, h);
      ctx.restore();
    }
    for (const id of expired) this.strokes.delete(id);

    if (this.strokes.size > 0) this.scheduleRender();
  }

  private drawStroke(stroke: ViewerStroke, w: number, h: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const lw = Math.max(1, stroke.width);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    if (stroke.tool === 'highlight') {
      ctx.lineWidth = lw * 4;
      ctx.globalAlpha *= 0.35;
    } else {
      ctx.lineWidth = lw;
    }

    const pts = stroke.points;
    if (pts.length === 0) return;

    if (stroke.tool === 'rect' && pts.length >= 2) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      const x = Math.min(a.x, b.x) * w;
      const y = Math.min(a.y, b.y) * h;
      const rw = Math.abs(b.x - a.x) * w;
      const rh = Math.abs(b.y - a.y) * h;
      ctx.strokeRect(x, y, rw, rh);
      return;
    }

    if (stroke.tool === 'arrow' && pts.length >= 2) {
      const a = { x: pts[0].x * w, y: pts[0].y * h };
      const b = { x: pts[pts.length - 1].x * w, y: pts[pts.length - 1].y * h };
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.hypot(dx, dy) < 2) return;
      const headLen = Math.max(12, lw * 4);
      const angle = Math.atan2(dy, dx);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x - Math.cos(angle) * headLen * 0.7, b.y - Math.sin(angle) * headLen * 0.7);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - headLen * Math.cos(angle - Math.PI / 7), b.y - headLen * Math.sin(angle - Math.PI / 7));
      ctx.lineTo(b.x - headLen * Math.cos(angle + Math.PI / 7), b.y - headLen * Math.sin(angle + Math.PI / 7));
      ctx.closePath();
      ctx.fill();
      return;
    }

    // Polyline (pen / highlight)
    ctx.beginPath();
    ctx.moveTo(pts[0].x * w, pts[0].y * h);
    for (let i = 1; i < pts.length; i += 1) {
      ctx.lineTo(pts[i].x * w, pts[i].y * h);
    }
    ctx.stroke();
  }
}
