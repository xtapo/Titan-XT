/**
 * Web viewer entry — login screen + session screen + glue.
 *
 * This file is the only place that touches the DOM directly. The
 * ConnectionManager / TouchInput modules are framework-free so they can be
 * lifted into a future React/Vue rewrite without a refactor.
 */

import { ConnectionManager } from './connection';
import { TouchInput } from './touch-input';
import { DEFAULT_QUALITY, QualityPreset, QUALITY_LABELS } from './constants';

// === DOM helpers ===
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

// === Toast ===
let toastTimer: number | null = null;
function showToast(message: string, kind: 'info' | 'error' | 'success' = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  // Force reflow so the transition fires.
  void el.offsetHeight;
  el.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 250);
  }, 2800);
}

// === Persisted partner id (last successful) ===
const LAST_PARTNER_KEY = 'titan-xt:last-partner-id';

function renderLogin() {
  const app = $<HTMLDivElement>('#app');
  const lastPartner = localStorage.getItem(LAST_PARTNER_KEY) || '';
  app.innerHTML = `
    <div class="login-screen">
      <div class="brand">
        <div class="brand-mark">◆ TITAN-XT</div>
        <div class="brand-sub">Mobile viewer</div>
      </div>
      <div class="card">
        <div class="field">
          <label class="field-label" for="partnerId">Partner ID</label>
          <input id="partnerId" type="text" inputmode="numeric" autocomplete="off"
            maxlength="11" placeholder="123 456 789" value="${formatId(lastPartner)}" />
        </div>
        <div class="field">
          <label class="field-label" for="password">Password</label>
          <input id="password" type="text" inputmode="text" autocomplete="off"
            maxlength="8" placeholder="abcd" />
        </div>
        <button id="connectBtn" class="connect-btn">Kết nối</button>
        <div id="status" class="status-line"></div>
      </div>
      <div class="server-row" id="serverStatus"><span class="status-dot offline"></span> Chưa kết nối máy chủ</div>
    </div>
  `;

  const partnerInput = $<HTMLInputElement>('#partnerId');
  const passwordInput = $<HTMLInputElement>('#password');
  const connectBtn = $<HTMLButtonElement>('#connectBtn');
  const status = $<HTMLDivElement>('#status');

  partnerInput.addEventListener('input', () => {
    // Format as "123 456 789" while typing — strip non-digits, group in 3s.
    const digits = partnerInput.value.replace(/\D/g, '').slice(0, 9);
    partnerInput.value = formatId(digits);
  });

  partnerInput.addEventListener('focus', () => partnerInput.select());

  const submit = async () => {
    const partnerId = partnerInput.value.replace(/\D/g, '');
    const password = passwordInput.value.trim();
    if (partnerId.length !== 9) {
      status.textContent = 'ID phải đúng 9 chữ số';
      status.className = 'status-line error';
      return;
    }
    if (!password) {
      status.textContent = 'Nhập password 4 ký tự';
      status.className = 'status-line error';
      return;
    }

    connectBtn.disabled = true;
    status.textContent = 'Đang kết nối máy chủ…';
    status.className = 'status-line';
    const serverStatus = $<HTMLDivElement>('#serverStatus');
    if (serverStatus) serverStatus.innerHTML = '<span class="status-dot connecting"></span> Đang kết nối…';

    await runSession(partnerId, password, status, () => {
      connectBtn.disabled = false;
    });
  };

  connectBtn.addEventListener('click', submit);
  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
}

// === Session orchestration ===

async function runSession(
  partnerId: string,
  password: string,
  status: HTMLDivElement,
  onFatal: () => void,
) {
  const conn = new ConnectionManager(
    {
      onState: (state) => {
        if (state === 'connected') {
          showToast('Đã kết nối', 'success');
          localStorage.setItem(LAST_PARTNER_KEY, partnerId);
        } else if (state === 'failed' || state === 'disconnected') {
          // Surfaced via onDisconnect once the manager tears down.
        }
      },
      onStream: (stream) => {
        const v = $<HTMLVideoElement>('#remoteVideo');
        if (v) {
          v.srcObject = stream;
          v.play().catch(() => {
            // Autoplay blocked — show a tap-to-start hint
            const overlay = $<HTMLDivElement>('#sessionOverlay');
            if (overlay) {
              overlay.classList.remove('hidden');
              overlay.querySelector('.overlay-text')!.textContent = 'Chạm để bắt đầu';
              overlay.style.pointerEvents = 'auto';
              overlay.addEventListener(
                'click',
                () => {
                  v.play();
                  overlay.classList.add('hidden');
                  overlay.style.pointerEvents = 'none';
                },
                { once: true },
              );
            }
          });
          $<HTMLDivElement>('#sessionOverlay')?.classList.add('hidden');
        }
      },
      onStats: (stats) => {
        const lat = $<HTMLSpanElement>('#statLatency');
        const fps = $<HTMLSpanElement>('#statFps');
        const br = $<HTMLSpanElement>('#statBitrate');
        const res = $<HTMLSpanElement>('#statRes');
        if (lat) lat.textContent = `${stats.latency}ms`;
        if (fps) fps.textContent = `${stats.fps}fps`;
        if (br) {
          const mbps = stats.bitrate / 1_000_000;
          br.textContent = mbps >= 1 ? `${mbps.toFixed(1)}Mbps` : `${Math.round(stats.bitrate / 1000)}kbps`;
        }
        // Surface the actual decoded frame size — when the host downscales
        // because of bandwidth pressure this is how the user finds out the
        // 'max' preset they picked is delivering 720p instead of 4K.
        if (res && stats.frameWidth && stats.frameHeight) {
          res.textContent = `${stats.frameWidth}×${stats.frameHeight}`;
        }
      },
      onError: (msg) => {
        status.textContent = msg;
        status.className = 'status-line error';
        showToast(msg, 'error');
        onFatal();
      },
      onChat: (text, sender) => {
        showToast(`${sender}: ${text}`, 'info');
      },
      onDisconnect: (reason) => {
        showToast(reason, 'info');
        renderLogin();
      },
    },
    'Mobile Viewer',
  );

  const ok = await conn.connectToServer();
  const serverStatus = $<HTMLDivElement>('#serverStatus');
  if (!ok) {
    if (serverStatus) serverStatus.innerHTML = '<span class="status-dot offline"></span> Không kết nối được máy chủ';
    onFatal();
    return;
  }
  if (serverStatus) serverStatus.innerHTML = '<span class="status-dot online"></span> Đã kết nối máy chủ';
  status.textContent = 'Đang xác thực…';
  await conn.connectToPartner(partnerId, password);

  renderSession(conn);
}

function renderSession(conn: ConnectionManager) {
  const app = $<HTMLDivElement>('#app');
  app.innerHTML = `
    <div class="session">
      <video id="remoteVideo" playsinline autoplay muted></video>
      <div id="sessionOverlay" class="session-overlay">
        <div class="spinner"></div>
        <div class="overlay-text">Đang nhận luồng…</div>
      </div>
      <div class="toolbar-top">
        <span class="stat-chip" id="statLatency">--ms</span>
        <span class="stat-chip" id="statFps">--fps</span>
        <span class="stat-chip" id="statBitrate">--kbps</span>
        <span class="stat-chip" id="statRes">--×--</span>
      </div>

      <div class="quality-panel" id="qualityPanel">
        ${(['max', 'ultra', 'responsive', 'high', 'medium', 'low', 'tiny'] as QualityPreset[])
          .map(
            (q) => `<button class="quality-option" data-quality="${q}">${QUALITY_LABELS[q]}</button>`,
          )
          .join('')}
      </div>

      <div class="kbd-panel" id="kbdPanel">
        <div class="kbd-row">
          <button class="kbd-key modifier" data-mod="ctrl">Ctrl</button>
          <button class="kbd-key modifier" data-mod="alt">Alt</button>
          <button class="kbd-key modifier" data-mod="shift">Shift</button>
          <button class="kbd-key modifier" data-mod="meta">Win</button>
          <button class="kbd-key" data-key="Escape" data-code="Escape">Esc</button>
        </div>
        <div class="kbd-row">
          <button class="kbd-key" data-key="Tab" data-code="Tab">Tab</button>
          <button class="kbd-key" data-key="Enter" data-code="Enter">↵</button>
          <button class="kbd-key" data-key="Backspace" data-code="Backspace">⌫</button>
          <button class="kbd-key" data-key="Delete" data-code="Delete">Del</button>
          <button class="kbd-key" data-key=" " data-code="Space">Space</button>
        </div>
        <div class="kbd-row">
          <button class="kbd-key" data-key="ArrowLeft" data-code="ArrowLeft">←</button>
          <button class="kbd-key" data-key="ArrowDown" data-code="ArrowDown">↓</button>
          <button class="kbd-key" data-key="ArrowUp" data-code="ArrowUp">↑</button>
          <button class="kbd-key" data-key="ArrowRight" data-code="ArrowRight">→</button>
          <button class="kbd-key" id="hiddenInputBtn">abc…</button>
        </div>
      </div>

      <div class="help-overlay" id="helpOverlay">
        <h2>Cử chỉ điều khiển</h2>
        <div class="gesture-row">
          <div class="gesture-icon">·</div>
          <div class="gesture-text"><strong>Chạm 1 ngón</strong><span>Click chuột trái</span></div>
        </div>
        <div class="gesture-row">
          <div class="gesture-icon">··</div>
          <div class="gesture-text"><strong>Chạm 2 ngón</strong><span>Click chuột phải</span></div>
        </div>
        <div class="gesture-row">
          <div class="gesture-icon">···</div>
          <div class="gesture-text"><strong>Chạm 3 ngón</strong><span>Click chuột giữa (mở tab mới…)</span></div>
        </div>
        <div class="gesture-row">
          <div class="gesture-icon">··</div>
          <div class="gesture-text"><strong>Chạm 1 ngón × 2</strong><span>Double click</span></div>
        </div>
        <div class="gesture-row">
          <div class="gesture-icon">↔</div>
          <div class="gesture-text"><strong>Vuốt 1 ngón</strong><span>Di chuyển con trỏ (có gia tốc)</span></div>
        </div>
        <div class="gesture-row">
          <div class="gesture-icon">↕↕</div>
          <div class="gesture-text"><strong>Vuốt 2 ngón</strong><span>Cuộn dọc / ngang, có quán tính</span></div>
        </div>
        <div class="gesture-row">
          <div class="gesture-icon">⏱</div>
          <div class="gesture-text"><strong>Giữ rồi kéo</strong><span>Kéo thả (giữ chuột trái)</span></div>
        </div>
        <button class="help-close" id="helpClose">Đã hiểu</button>
      </div>

      <div class="toolbar-bottom">
        <button class="tool-btn" id="btnKeyboard">
          <span class="tool-icon">⌨</span><span>Bàn phím</span>
        </button>
        <button class="tool-btn" id="btnQuality">
          <span class="tool-icon">◐</span><span>Chất lượng</span>
        </button>
        <button class="tool-btn" id="btnRotate">
          <span class="tool-icon">⟲</span><span>Xoay ngang</span>
        </button>
        <button class="tool-btn" id="btnHelp">
          <span class="tool-icon">?</span><span>Cử chỉ</span>
        </button>
        <button class="tool-btn" id="btnFullscreen">
          <span class="tool-icon">⤢</span><span>Toàn màn</span>
        </button>
        <button class="tool-btn danger" id="btnDisconnect">
          <span class="tool-icon">×</span><span>Ngắt</span>
        </button>
      </div>
    </div>
  `;

  const video = $<HTMLVideoElement>('#remoteVideo');
  const touch = new TouchInput(video, conn);
  touch.enable();

  // Re-render the virtual cursor when the viewport changes (orientation
  // change, fullscreen toggle, on-screen keyboard appearing). Without this,
  // the cursor floats off the video after the layout reshuffles.
  const onResize = () => touch.recenterCursor();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  // === Auto-rotate to landscape ===
  // Host PCs are 16:9 / 21:9, phones are 9:16 — viewing a 4K screen on a
  // portrait phone wastes ~60% of pixels on letterboxing. Try the platform
  // landscape lock first (Chrome Android only, requires fullscreen on most
  // builds), then fall back to a CSS rotation that works everywhere.
  type RotationMode = 'auto' | 'forced-landscape' | 'forced-portrait';
  let rotationMode: RotationMode = 'auto';
  const sessionEl = $<HTMLDivElement>('.session');
  const rotateBtn = $<HTMLButtonElement>('#btnRotate');

  const isPortraitNow = () =>
    (window.matchMedia?.('(orientation: portrait)').matches ?? window.innerHeight > window.innerWidth);

  const applyRotation = () => {
    const portraitDevice = isPortraitNow();
    const shouldCssRotate = rotationMode === 'forced-landscape' && portraitDevice;
    const shouldCssRotatePortrait = rotationMode === 'forced-portrait' && !portraitDevice;
    if (shouldCssRotate) {
      sessionEl.classList.add('rotate-cw');
      sessionEl.classList.remove('rotate-ccw');
      touch.setRotation(90);
    } else if (shouldCssRotatePortrait) {
      sessionEl.classList.add('rotate-ccw');
      sessionEl.classList.remove('rotate-cw');
      touch.setRotation(-90);
    } else {
      sessionEl.classList.remove('rotate-cw', 'rotate-ccw');
      touch.setRotation(0);
    }
    setTimeout(() => onResize(), 50);
  };

  // Try the native orientation lock first — only works inside fullscreen on
  // most browsers. Failure is silent; CSS rotation kicks in as fallback.
  const tryNativeLandscape = async (): Promise<boolean> => {
    try {
      const orient = (screen.orientation as any);
      if (orient?.lock) {
        await orient.lock('landscape');
        return true;
      }
    } catch {
      // Locked-out / not in fullscreen / iOS Safari (unsupported) — fall through.
    }
    return false;
  };

  const tryNativeUnlock = () => {
    try {
      (screen.orientation as any)?.unlock?.();
    } catch {
      // ignore
    }
  };

  // Default: auto-attempt landscape lock once at session start. If the
  // browser refuses (no fullscreen, iOS), CSS rotation isn't applied yet —
  // we wait for the user to tap the rotate button so they get a clear
  // affordance instead of the page flipping out from under them.
  tryNativeLandscape().catch(() => {
    // ignore — best effort
  });

  rotateBtn.addEventListener('click', async () => {
    if (rotationMode === 'auto') {
      // Step 1: try native landscape lock (free, no CSS hack).
      const locked = await tryNativeLandscape();
      if (locked) {
        // Native lock holds — UI updates via the orientationchange listener.
        showToast('Đã khoá ngang', 'success');
        return;
      }
      // Step 2: native refused → CSS-rotate as fallback.
      rotationMode = 'forced-landscape';
      applyRotation();
      showToast('Đã xoay ngang', 'success');
    } else {
      tryNativeUnlock();
      rotationMode = 'auto';
      applyRotation();
      showToast('Trở về tự động', 'info');
    }
  });

  // Ensure muted-then-unmute pattern for iOS Safari autoplay.
  video.addEventListener('loadedmetadata', () => {
    video.muted = false;
    video.play().catch(() => {
      // Stay muted — autoplay still allowed
    });
  });

  // === Bottom toolbar ===
  const kbdPanel = $<HTMLDivElement>('#kbdPanel');
  const qualityPanel = $<HTMLDivElement>('#qualityPanel');
  const helpOverlay = $<HTMLDivElement>('#helpOverlay');

  $<HTMLButtonElement>('#btnKeyboard').addEventListener('click', () => {
    qualityPanel.classList.remove('visible');
    kbdPanel.classList.toggle('visible');
  });
  $<HTMLButtonElement>('#btnQuality').addEventListener('click', () => {
    kbdPanel.classList.remove('visible');
    qualityPanel.classList.toggle('visible');
  });
  $<HTMLButtonElement>('#btnHelp').addEventListener('click', () => {
    helpOverlay.classList.add('visible');
  });
  $<HTMLButtonElement>('#helpClose').addEventListener('click', () => {
    helpOverlay.classList.remove('visible');
  });
  $<HTMLButtonElement>('#btnFullscreen').addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        // Lock to landscape on supported browsers — much nicer for screen share.
        try {
          await (screen.orientation as any)?.lock?.('landscape');
        } catch {
          // not supported / blocked
        }
      } else {
        await document.exitFullscreen();
      }
    } catch (err) {
      console.warn('fullscreen failed:', err);
    }
  });
  $<HTMLButtonElement>('#btnDisconnect').addEventListener('click', () => {
    conn.disconnectAll();
    renderLogin();
  });

  // === Quality picker ===
  // The host defaults to 'high' (1080p) on its own — no need to auto-push a
  // preset from here. Earlier versions did, with a 1.5s timer; if the user
  // tapped "Tối đa" within that window the timer fired afterwards and
  // overrode the choice back to default. Now the host keeps its default
  // until the user explicitly picks something.
  let activeQuality: QualityPreset = DEFAULT_QUALITY;
  const markQuality = (preset: QualityPreset) => {
    qualityPanel.querySelectorAll<HTMLButtonElement>('.quality-option').forEach((b) => {
      b.classList.toggle('active', b.dataset.quality === preset);
    });
  };
  markQuality(activeQuality);

  qualityPanel.querySelectorAll<HTMLButtonElement>('.quality-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.quality as QualityPreset;
      if (!preset) return;
      activeQuality = preset;
      markQuality(preset);
      conn.requestQuality(preset);
      qualityPanel.classList.remove('visible');
      showToast(`Đã đổi: ${QUALITY_LABELS[preset]}`, 'success');
    });
  });

  // === Virtual keyboard ===
  const activeMods = new Set<'ctrl' | 'alt' | 'shift' | 'meta'>();

  kbdPanel.querySelectorAll<HTMLButtonElement>('.kbd-key.modifier').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mod = btn.dataset.mod as 'ctrl' | 'alt' | 'shift' | 'meta';
      if (activeMods.has(mod)) {
        activeMods.delete(mod);
        btn.classList.remove('active');
      } else {
        activeMods.add(mod);
        btn.classList.add('active');
      }
    });
  });

  kbdPanel.querySelectorAll<HTMLButtonElement>('.kbd-key:not(.modifier)').forEach((btn) => {
    if (btn.id === 'hiddenInputBtn') return;
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      const code = btn.dataset.code;
      if (!key || !code) return;
      touch.sendKey(key, code, [...activeMods]);
      // Sticky modifiers — clear after one keypress (TeamViewer convention).
      activeMods.clear();
      kbdPanel
        .querySelectorAll<HTMLButtonElement>('.kbd-key.modifier.active')
        .forEach((m) => m.classList.remove('active'));
    });
  });

  // === Hidden text input for full keyboard ===
  // Tapping "abc…" creates an off-screen input that triggers the OS keyboard.
  // Each character typed gets translated into key down+up messages.
  $<HTMLButtonElement>('#hiddenInputBtn').addEventListener('click', () => {
    let hidden = document.getElementById('hiddenInput') as HTMLInputElement | null;
    if (!hidden) {
      hidden = document.createElement('input');
      hidden.id = 'hiddenInput';
      hidden.type = 'text';
      hidden.autocomplete = 'off';
      hidden.autocapitalize = 'off';
      hidden.spellcheck = false;
      hidden.style.position = 'fixed';
      hidden.style.left = '-9999px';
      hidden.style.top = '50%';
      hidden.style.opacity = '0';
      hidden.style.height = '1px';
      hidden.style.width = '1px';
      document.body.appendChild(hidden);

      hidden.addEventListener('beforeinput', (ev: any) => {
        const data: string = ev.data || '';
        if (data && ev.inputType === 'insertText') {
          for (const ch of data) {
            touch.sendKey(ch, charToCode(ch), []);
          }
        } else if (ev.inputType === 'deleteContentBackward') {
          touch.sendKey('Backspace', 'Backspace', []);
        }
        ev.preventDefault();
        hidden!.value = '';
      });
    }
    hidden.value = '';
    hidden.focus();
  });
}

// === Utilities ===

function formatId(digits: string): string {
  const d = digits.replace(/\D/g, '').slice(0, 9);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)} ${d.slice(3)}`;
  return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}


/**
 * Best-effort guess for KeyboardEvent.code from a single character.
 * The host's input simulator keys off `code` first, falling back to `key`,
 * so being approximately right is enough — we don't need full layout maps.
 */
function charToCode(ch: string): string {
  if (/^[a-z]$/i.test(ch)) return `Key${ch.toUpperCase()}`;
  if (/^[0-9]$/.test(ch)) return `Digit${ch}`;
  if (ch === ' ') return 'Space';
  return ch;
}

renderLogin();
