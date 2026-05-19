/**
 * Metrics dashboard — viewer-side floating panel that visualises the
 * connection's vitals over the last ~60 samples (~2 minutes at the default
 * sampling interval). Mirrors what AnyDesk's "Statistics" overlay and
 * UltraViewer's network HUD show.
 *
 * Mounts inside the session view-wrapper as a draggable panel. Subscribes to
 * a push API (see ConnectionManager.onMetrics / pushMetricsSample) so it
 * doesn't need to round-trip through getStats itself.
 */

import type { PeerStats } from './webrtc';
import type { QualityPreset } from '../../shared/constants';

interface MetricSample extends PeerStats {
  timestamp: number;
  /** Auto-applied or manual quality preset at this sample. */
  preset?: QualityPreset;
}

const HISTORY_LIMIT = 60;

let panelEl: HTMLElement | null = null;
let visible = false;
let history: MetricSample[] = [];

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '--';
  return `${Math.round(ms)} ms`;
}

function fmtPct(frac: number): string {
  if (!Number.isFinite(frac)) return '--';
  return `${(frac * 100).toFixed(1)}%`;
}

function fmtBitrate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '--';
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

function buildPanel(wrapper: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  el.id = 'metrics-panel';
  el.className = 'metrics-panel hidden';
  el.innerHTML = `
    <div class="metrics-header">
      <span class="metrics-title">Đường truyền</span>
      <button class="metrics-close" data-metrics-close title="Đóng">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
    <div class="metrics-grid">
      <div class="metrics-cell">
        <div class="metrics-label">Độ trễ</div>
        <div class="metrics-value" data-metric="latency">--</div>
      </div>
      <div class="metrics-cell">
        <div class="metrics-label">Mất gói</div>
        <div class="metrics-value" data-metric="loss">--</div>
      </div>
      <div class="metrics-cell">
        <div class="metrics-label">Jitter</div>
        <div class="metrics-value" data-metric="jitter">--</div>
      </div>
      <div class="metrics-cell">
        <div class="metrics-label">FPS</div>
        <div class="metrics-value" data-metric="fps">--</div>
      </div>
      <div class="metrics-cell metrics-cell-wide">
        <div class="metrics-label">Băng thông</div>
        <div class="metrics-value" data-metric="bitrate">--</div>
      </div>
      <div class="metrics-cell metrics-cell-wide">
        <div class="metrics-label">Chất lượng hiện tại</div>
        <div class="metrics-value" data-metric="preset">--</div>
      </div>
    </div>
    <div class="metrics-charts">
      <div class="metrics-chart">
        <div class="metrics-chart-label">Độ trễ (ms) · 2 phút gần nhất</div>
        <canvas class="metrics-chart-canvas" data-chart="latency"></canvas>
      </div>
      <div class="metrics-chart">
        <div class="metrics-chart-label">Băng thông (Mbps)</div>
        <canvas class="metrics-chart-canvas" data-chart="bitrate"></canvas>
      </div>
    </div>
    <div class="metrics-footer">
      <span class="metrics-status" data-metric="status">Đang theo dõi...</span>
    </div>
  `;
  wrapper.appendChild(el);

  el.querySelector('[data-metrics-close]')?.addEventListener('click', () => {
    hideMetricsPanel();
  });

  return el;
}

function drawChart(
  canvas: HTMLCanvasElement,
  values: number[],
  color: string,
  yMin?: number,
  yMax?: number,
): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(40, rect.width);
  const h = Math.max(24, rect.height);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (values.length < 2) return;

  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return;
  const min = yMin ?? Math.min(...finite);
  const max = yMax ?? Math.max(...finite);
  const range = max - min || 1;

  // Axis line
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - 0.5);
  ctx.lineTo(w, h - 0.5);
  ctx.stroke();

  // Series
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const safe = Number.isFinite(v) ? v : min;
    const y = h - ((safe - min) / range) * h * 0.9 - 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function renderPanel(): void {
  if (!panelEl) return;
  const last = history[history.length - 1];
  const setText = (sel: string, text: string) => {
    const el = panelEl?.querySelector(`[data-metric="${sel}"]`);
    if (el) el.textContent = text;
  };

  if (last) {
    setText('latency', fmtMs(last.latency));
    setText('loss', fmtPct(last.packetLoss));
    setText('jitter', fmtMs(last.jitter));
    setText('fps', `${Math.round(last.fps)} fps`);
    setText('bitrate', fmtBitrate(last.bitrate));
    setText('preset', last.preset || '--');

    // Severity: classify at-a-glance health.
    const status = panelEl.querySelector('[data-metric="status"]') as HTMLElement | null;
    if (status) {
      let label = 'Tốt';
      let cls = 'metrics-status metrics-status-good';
      if (last.latency >= 250 || last.packetLoss >= 0.04) {
        label = 'Kém — đã giảm chất lượng';
        cls = 'metrics-status metrics-status-bad';
      } else if (last.latency >= 120 || last.packetLoss >= 0.01) {
        label = 'Trung bình';
        cls = 'metrics-status metrics-status-warn';
      }
      status.textContent = label;
      status.className = cls;
    }
  }

  const latencyCanvas = panelEl.querySelector('[data-chart="latency"]') as HTMLCanvasElement | null;
  const bitrateCanvas = panelEl.querySelector('[data-chart="bitrate"]') as HTMLCanvasElement | null;
  if (latencyCanvas) {
    drawChart(latencyCanvas, history.map((h) => h.latency), '#60a5fa', 0);
  }
  if (bitrateCanvas) {
    drawChart(bitrateCanvas, history.map((h) => h.bitrate / 1_000_000), '#34d399', 0);
  }
}

/**
 * Push a fresh sample. Capped at HISTORY_LIMIT to bound memory and
 * keep the chart sweep at a comfortable density.
 */
export function pushMetricsSample(stats: PeerStats, preset?: QualityPreset): void {
  history.push({
    ...stats,
    timestamp: Date.now(),
    preset,
  });
  if (history.length > HISTORY_LIMIT) history.shift();
  if (visible) renderPanel();
}

export function showMetricsPanel(): void {
  const wrapper = document.getElementById('video-wrapper');
  if (!wrapper) return;
  if (!panelEl) panelEl = buildPanel(wrapper);
  panelEl.classList.remove('hidden');
  visible = true;
  renderPanel();
}

export function hideMetricsPanel(): void {
  panelEl?.classList.add('hidden');
  visible = false;
}

export function toggleMetricsPanel(): void {
  if (visible) hideMetricsPanel();
  else showMetricsPanel();
}

export function isMetricsPanelOpen(): boolean {
  return visible;
}

/**
 * Clear all collected samples. Call when a new session starts so the chart
 * doesn't carry stale data from the previous session.
 */
export function resetMetricsHistory(): void {
  history = [];
  if (visible) renderPanel();
}

export function destroyMetricsPanel(): void {
  if (panelEl?.parentElement) panelEl.parentElement.removeChild(panelEl);
  panelEl = null;
  visible = false;
  history = [];
}
