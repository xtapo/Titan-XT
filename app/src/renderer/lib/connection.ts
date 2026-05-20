/**
 * Connection Manager — Handles Socket.io signaling and WebRTC lifecycle
 */

import { io, Socket } from 'socket.io-client';
import { PeerConnection } from './webrtc';
import { InputHandler } from './input-handler';
import {
  addChatMessage,
  enterHostMode,
  exitHostMode,
  addFileEntry,
  updateFileProgress,
  showReconnectingState,
  hideReconnectingState,
} from '../pages/session';
import { showToast } from '../components/toast';
import {
  CHANNEL_INPUT,
  CHANNEL_CHAT,
  CHANNEL_FILE,
  CHANNEL_SYSTEM,
  CHANNEL_ANNOTATION,
  DEFAULT_SIGNAL_SERVER,
  HEARTBEAT_INTERVAL,
  DEFAULT_QUALITY,
  DEFAULT_MAX_WIDTH,
  DEFAULT_MAX_HEIGHT,
  DEFAULT_FPS,
  DEFAULT_CODEC,
  QualityPreset,
  VideoCodec,
  ADAPTIVE_RTT_DOWNGRADE_MS,
  ADAPTIVE_RTT_UPGRADE_MS,
  ADAPTIVE_LOSS_DOWNGRADE,
  ADAPTIVE_DEBOUNCE_SAMPLES,
} from '../../shared/constants';
import {
  FileMessage,
  FileOfferMessage,
  FileChunkMessage,
  AnnotationMessage,
} from '../../shared/protocol';
import { auditLog, setActiveAuditSession } from './audit-logger';
import { pushMetricsSample, resetMetricsHistory } from './metrics';

/**
 * Recolor the toolbar's network-condition badge based on the latest sample.
 * Tiers mirror the metrics-panel status semantics so both indicators agree.
 *   <120 ms RTT and <1% loss  → "Tốt" (green)
 *   <250 ms RTT and <4% loss  → "Trung bình" (amber)
 *   ≥250 ms RTT or ≥4% loss   → "Kém" (red)
 */
function updateNetworkBadge(rttMs: number, lossFrac: number): void {
  const badge = document.getElementById('stat-network-badge');
  if (!badge) return;
  const label = badge.querySelector('.stat-network-label');
  let cls = 'stat-network-badge';
  let text = 'Tốt';
  if (rttMs <= 0) {
    cls += ' stat-network-unknown';
    text = '...';
  } else if (rttMs >= 250 || lossFrac >= 0.04) {
    cls += ' stat-network-bad';
    text = 'Kém';
  } else if (rttMs >= 120 || lossFrac >= 0.01) {
    cls += ' stat-network-warn';
    text = 'Trung bình';
  } else {
    cls += ' stat-network-good';
  }
  badge.className = cls;
  if (label) label.textContent = text;
}

export class ConnectionManager {
  private socket: Socket | null = null;
  private peer: PeerConnection | null = null;
  private inputHandler: InputHandler | null = null;
  private heartbeatTimer: number | null = null;
  private serverUrl: string;
  private machineId: string = '';
  private machineName: string = '';
  private currentQuality: QualityPreset = DEFAULT_QUALITY;
  private currentCodec: VideoCodec = DEFAULT_CODEC;
  private role: 'host' | 'viewer' | null = null;
  private partnerId: string = '';
  // Host-side: viewer's machine name captured from the incoming connect-request,
  // so the host panel can display "PC-NAME" instead of just the digit ID.
  private incomingViewerName: string = '';

  // === Auto-reconnect state (viewer-side only) ===
  // Cached so we can re-issue connect-request after a peer drop without
  // forcing the user back to home to retype the password.
  private viewerCredentials: { partnerId: string; password: string; mode: string } | null = null;
  // True while the auto-retry loop is running. Prevents handleViewerConnectFailure
  // from yanking the user back to home — we want to stay on the session UI.
  private reconnecting: boolean = false;
  private reconnectAttempt: number = 0;
  // Total retries before giving up. Higher when we know the host is rebooting.
  private reconnectMax: number = 6;
  private reconnectTimer: number | null = null;
  // Set when the user fires a destructive remote action (signout/restart/shutdown).
  // Tells the reconnect loop the disconnect is expected and to be patient
  // (longer initial wait + bigger budget while the OS comes back up).
  private expectedDisconnectKind: 'signout' | 'restart' | 'shutdown' | null = null;
  // True once disconnect()/disconnectAll() ran from a user-initiated path.
  // Suppresses auto-reconnect on the closure cascade that follows.
  private intentionalClose: boolean = false;
  // File transfer: incoming chunks are buffered until 'complete' arrives.
  private incomingFiles: Map<string, { name: string; size: number; chunks: string[]; received: number; totalChunks: number; targetHint?: 'desktop' }> = new Map();

  // === Adaptive quality (viewer-side) ===
  // The viewer watches RTT + packet loss and asks the host to step the
  // quality preset up or down. Like UltraViewer / AnyDesk reacting to a
  // congested link by trading resolution for smooth motion. Only enabled
  // when the user hasn't manually pinned a preset.
  private adaptiveEnabled: boolean = true;
  private adaptiveBadSamples: number = 0;
  private adaptiveGoodSamples: number = 0;
  // Wait this many sampling intervals after a tier change before reconsidering,
  // so we don't oscillate while the new bitrate is still stabilizing.
  private adaptiveCooldown: number = 0;

  // Track viewer-side mode (control vs view) and host-side lock state
  // separately. Either one disables input simulation:
  //   • mode='view'        — viewer chose to stop sending inputs
  //   • controlLocked=true — host forbids inputs even if viewer wants control
  // Effective allowed = (mode === 'control') && !controlLocked.
  private viewerMode: 'control' | 'view' = 'control';
  // Host-side: true once host clicks "lock control". Persisted on the host
  // for the lifetime of the session and broadcast to the viewer so its UI
  // can show a banner + grey out the Control switch.
  private controlLocked: boolean = false;
  // Viewer-side mirror — set when host pushes a control-lock message.
  private remoteControlLocked: boolean = false;

  // === Multi-monitor (viewer-side cache) ===
  // Host pushes its monitor list right after the data channel opens, plus
  // any time the active source changes. We keep a copy so the View menu
  // can render the picker without round-tripping every time it opens.
  private remoteMonitors: Array<{ id: string; name: string; isPrimary: boolean }> = [];
  private activeRemoteSourceId: string | null = null;

  // === Idle FPS optimization (viewer-side) ===
  // When the viewer window is hidden / minimized for a sustained period,
  // step down the quality preset so the host stops paying for encode +
  // bandwidth on frames nobody is watching. Snap back to the previous
  // preset the moment the window comes forward. Inspired by AnyDesk's
  // "save bandwidth when minimized" behavior.
  private idleFpsActive: boolean = false;
  private idleFpsPreviousPreset: QualityPreset | null = null;
  private idleFpsTimer: number | null = null;
  private boundVisibilityHandler = () => this.onVisibilityChange();

  constructor(serverUrl?: string) {
    this.serverUrl = serverUrl || DEFAULT_SIGNAL_SERVER;
  }

  // === Signal Server Connection ===

  async connectToServer(machineId: string, machineName: string): Promise<boolean> {
    this.machineId = machineId;
    this.machineName = machineName;

    return new Promise((resolve) => {
      this.socket = io(this.serverUrl, {
        transports: ['websocket', 'polling'],
        timeout: 10000,
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 3000,
      });

      this.socket.on('connect', () => {
        console.log('[Conn] Connected to signal server');
        this.socket!.emit('register', { machineId, machineName });
        this.startHeartbeat();
        resolve(true);
      });

      this.socket.on('registered', () => {
        console.log('[Conn] Registered with server');
      });

      this.socket.on('connect_error', (err) => {
        console.error('[Conn] Server connection error:', err.message);
        resolve(false);
      });

      // Handle incoming connection request (we are the HOST)
      this.socket.on('connect-request', (data: any) => {
        console.log(`[Conn] Incoming connection from ${data.fromId}`);
        this.incomingViewerName = data.fromName || '';
        // In auto-accept mode, respond to password challenge
      });

      // Handle password verification request
      this.socket.on('password-verify', async (data: any) => {
        console.log('[Conn] Password verification request');
        // Pass the viewer's machine id so the host's brute-force throttle can
        // count failures per identity instead of globally — a single bad
        // viewer can't lock out everyone else.
        const isValid = await this.verifyPassword(data.passwordHash, data.nonce, data.fromId);
        this.socket!.emit('connect-response', {
          toId: data.fromId,
          accepted: isValid,
          nonce: data.nonce,
        });

        if (isValid) {
          // We are the HOST — prepare to share screen
          this.setupAsHost(data.fromId);
        }
      });

      // Handle WebRTC signaling
      this.socket.on('signal', (msg: any) => {
        this.handleSignal(msg);
      });

      // Handle session ended by other party
      this.socket.on('session-ended', (_data: any) => {
        // No active session — this is the echo of our own disconnect or a
        // stale event from the server. Skip the toast so the user doesn't
        // see "Phiên kết nối đã kết thúc" right after their own click.
        if (!this.peer && !this.role) return;
        this.disconnect();
        showToast('Phiên kết nối đã kết thúc', 'info');
        // Surface the home screen so the user isn't stuck on a dead session UI.
        import('../main').then(({ navigateTo }) => navigateTo('home'));
      });

      this.socket.on('disconnect', () => {
        console.log('[Conn] Disconnected from server');
        this.stopHeartbeat();
      });
    });
  }

  // === Connect to Partner (we are VIEWER) ===

  async connectToPartner(partnerId: string, password: string, mode: string): Promise<void> {
    if (!this.socket?.connected) {
      showToast('Chưa kết nối server', 'error');
      return;
    }

    // Cache credentials so the auto-reconnect loop can re-issue the same
    // connect-request without dragging the user back to home.
    this.viewerCredentials = { partnerId, password, mode };
    this.intentionalClose = false;

    // Setup peer + ICE forwarding BEFORE sending connect-request so that
    // host's offer/ICE candidates (which arrive immediately after the host
    // accepts) have a peer to land on. Without this, Chromium drops them
    // and the viewer ends up with a black screen.
    this.setupAsViewer(partnerId, mode);

    // Send connection request
    this.socket.emit('connect-request', {
      fromId: this.machineId,
      toId: partnerId,
      fromName: this.machineName,
      mode,
    });

    // Wait for challenge nonce
    this.socket.once('connect-challenge', async (data: any) => {
      // Hash password with nonce using SHA-256 (must match host's identity.ts)
      const hash = await this.hashPassword(password, data.nonce);
      this.socket!.emit('password-verify', {
        toId: partnerId,
        passwordHash: hash,
        nonce: data.nonce,
      });
    });

    // Wait for acceptance
    this.socket.once('connect-accepted', (data: any) => {
      console.log('[Conn] Connection accepted! Session:', data.sessionId);
      // Peer is already configured; nothing more to do here.
    });

    this.socket.once('connect-rejected', () => {
      // Wrong password is not a transient failure — stop any retry loop and
      // bounce the user back so they can retype.
      this.cancelReconnect();
      this.viewerCredentials = null;
      showToast('Mật khẩu không đúng', 'error');
      this.handleViewerConnectFailure();
    });

    this.socket.once('connect-error', (data: any) => {
      // Server-reported errors (e.g. partner offline). On a normal first
      // connect this is fatal; during auto-reconnect we let the loop retry
      // because the host may simply be mid-reboot.
      if (this.reconnecting) {
        console.log('[Conn] connect-error during reconnect — will retry:', data?.error);
        return;
      }
      this.cancelReconnect();
      this.viewerCredentials = null;
      showToast(data.error || 'Lỗi kết nối', 'error');
      this.handleViewerConnectFailure();
    });
  }

  /**
   * Tear down a half-built viewer peer when the host rejects the password
   * or the server reports an error. Without this, a stale PeerConnection
   * + InputHandler stays alive across attempts and pollutes the next one.
   */
  private handleViewerConnectFailure(): void {
    this.inputHandler?.disable();
    this.peer?.close();
    this.peer = null;
    this.inputHandler = null;
    this.role = null;
    this.partnerId = '';
    // Re-import lazily to avoid a circular dep at module-load time.
    import('../pages/home').then(({ resetConnectForm }) => resetConnectForm());
    import('../main').then(({ navigateTo }) => navigateTo('home'));
  }

  // === Setup as HOST (being controlled) ===

  private async setupAsHost(viewerId: string): Promise<void> {
    console.log('[Conn] Setting up as HOST');
    this.role = 'host';
    this.partnerId = viewerId;

    // Mark the audit session so events logged below inherit role/partner.
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setActiveAuditSession({
      sessionId,
      role: 'host',
      partnerId: viewerId,
      partnerName: this.incomingViewerName || '',
    });
    auditLog('session-start', `Phiên bắt đầu — đối tác kết nối`, {
      role: 'host',
      partnerId: viewerId,
      partnerName: this.incomingViewerName || '',
      severity: 'info',
    });
    auditLog('auth-success', 'Mật khẩu xác thực thành công', {
      role: 'host',
      partnerId: viewerId,
    });

    // Optionally hide the desktop wallpaper for the duration of the session
    // — a flat solid background compresses to almost nothing, freeing
    // bitrate for the windows the viewer actually cares about. Restored
    // when the host tears down.
    this.maybeHideWallpaper().catch((err: unknown) =>
      console.warn('[Conn] hideWallpaper failed:', err),
    );

    // Navigate to session page in host mode (shows chat + status panel)
    enterHostMode(viewerId, this.incomingViewerName);

    this.peer = new PeerConnection({
      onDataMessage: (channel, data) => {
        if (channel === CHANNEL_INPUT) {
          // Defense in depth: even if a viewer's InputHandler is still
          // alive (e.g. race on lock), drop input packets while locked or
          // the viewer is in 'view' mode on this host's bookkeeping.
          if (this.controlLocked) return;
          // Forward input to main process for simulation
          window.titanAPI?.input?.simulate(data);
        } else if (channel === CHANNEL_CHAT) {
          addChatMessage(data.text, 'received');
        } else if (channel === CHANNEL_FILE) {
          this.handleFileMessage(data);
        } else if (channel === CHANNEL_SYSTEM) {
          this.handleSystemMessage(data);
        } else if (channel === CHANNEL_ANNOTATION) {
          // Viewer drew on the screen — forward to main so the transparent
          // overlay window paints the stroke on the host's actual desktop.
          this.handleHostAnnotation(data);
        }
      },
      onStateChange: (state) => {
        console.log('[Conn] Host peer state:', state);
        // Viewer dropped (disconnect, network loss, app close) — tear the
        // host UI down so the mini-panel doesn't sit there showing "Ai đang
        // xem máy tính bạn" with a phantom client.
        if (state === 'disconnected' || state === 'failed') {
          if (this.intentionalClose) return;
          this.disconnect();
          showToast('Đối tác đã ngắt kết nối', 'info');
          import('../main').then(({ navigateTo }) => navigateTo('home'));
        }
      },
    });

    this.peer.onIceCandidate = (candidate) => {
      this.socket?.emit('signal', {
        type: 'ice-candidate',
        to: viewerId,
        data: candidate.toJSON(),
      });
    };

    // Capture screen and add to peer
    try {
      // In Electron, navigator.mediaDevices.getDisplayMedia is enabled via
      // session.setDisplayMediaRequestHandler in the main process (screen-capture.ts).
      // The handler picks the source; renderer constraints below only shape the stream.
      //
      // Cap capture at the highest preset's resolution so the encoder has the
      // pixels available when the viewer asks for 4K. Lower presets clamp the
      // track via applyConstraints() in webrtc.ts, so this max isn't binding
      // when 'high'/'medium'/'low' are picked.
      //
      // audio: true asks the main-process display-media handler for the system
      // loopback track ('audio: loopback' on Windows/Linux). macOS has no
      // loopback API exposed through getDisplayMedia, so the handler returns
      // video-only there and the audio request is silently ignored.
      const sources = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: {
          width: { max: DEFAULT_MAX_WIDTH },
          height: { max: DEFAULT_MAX_HEIGHT },
          // Capture at the highest fps any preset needs (60 for 'responsive').
          // applyQualityProfile will clamp down to 30/15 for lower presets via
          // track.applyConstraints. Starting high and clamping down works reliably;
          // starting low and trying to bump up often fails on some platforms.
          frameRate: { max: 60 },
          // Hide host cursor in video stream to support local cursor rendering
          cursor: 'never' as any,
        },
      });

      this.peer.addStream(sources);
      console.log('[Conn] Screen capture successful');
    } catch (err) {
      console.error('[Conn] Screen capture failed:', err);
      showToast('Không thể chia sẻ màn hình', 'error');
    }

    // Create and send offer
    const offer = await this.peer.createOffer();
    this.socket?.emit('signal', {
      type: 'offer',
      to: viewerId,
      data: offer,
    });
  }

  // === Setup as VIEWER (controlling) ===

  private setupAsViewer(hostId: string, mode: string): void {
    console.log('[Conn] Setting up as VIEWER');
    this.role = 'viewer';
    this.partnerId = hostId;

    // Reset the metrics chart for the new session so the previous run's
    // history doesn't bleed into the panel.
    resetMetricsHistory();

    // Wire idle-FPS reduction. Removed in disconnect().
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);

    // Mark the audit session for the viewer side so log entries on this
    // machine record what the technician did rather than what was done to
    // the host.
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setActiveAuditSession({
      sessionId,
      role: 'viewer',
      partnerId: hostId,
      partnerName: '',
    });
    auditLog('session-start', `Bắt đầu phiên với ${hostId}`, {
      role: 'viewer',
      partnerId: hostId,
      details: { mode },
    });

    const videoEl = document.getElementById('remote-video') as HTMLVideoElement;

    this.peer = new PeerConnection({
      onRemoteStream: (stream) => {
        console.log('[Conn] Received remote stream');
        if (videoEl) {
          videoEl.srcObject = stream;
          // Hide overlay
          document.getElementById('video-overlay')?.classList.add('hidden');
        }
      },
      onDataMessage: (channel, data) => {
        if (channel === CHANNEL_CHAT) {
          addChatMessage(data.text, 'received');
        } else if (channel === CHANNEL_FILE) {
          this.handleFileMessage(data);
        } else if (channel === CHANNEL_SYSTEM) {
          this.handleSystemMessage(data);
        }
      },
      onChannelOpen: (channel) => {
        // Once the system channel is open on this side, ask the host for its
        // current monitor list. Doing it as a request avoids the race where
        // the host's push lands before the viewer's onmessage is wired up.
        if (channel === CHANNEL_SYSTEM && this.role === 'viewer') {
          this.peer?.send(CHANNEL_SYSTEM, {
            type: 'system',
            action: 'request-monitors',
            data: {},
          });
        }
      },
      onStateChange: (state) => {
        console.log('[Conn] Viewer peer state:', state);
        if (state === 'connected') {
          // First success or recovery — clear any retry state and let the user know.
          if (this.reconnecting) {
            this.cancelReconnect();
            hideReconnectingState();
            showToast('Đã kết nối lại', 'success');
          } else {
            showToast('Kết nối thành công!', 'success');
          }
          // Record this successful connect into history + address book (if pinned).
          this.recordSuccessfulConnect(hostId).catch(() => {});
        } else if (state === 'disconnected' || state === 'failed') {
          // Don't retry if the user (or a fatal error) intentionally tore it down.
          if (this.intentionalClose) return;
          if (!this.viewerCredentials) return;
          // Grace period: ICE drop usually beats the signal server's
          // session-ended event by a few hundred ms. Without this wait, a
          // host clicking "ngắt kết nối" causes the viewer to auto-reconnect
          // before the session-ended message arrives — and the host
          // re-accepts because its socket is still online. Two seconds is
          // long enough for the signal to land, short enough that real
          // network drops still recover quickly.
          window.setTimeout(() => {
            if (this.intentionalClose) return;
            if (!this.viewerCredentials) return;
            const pcState = (this.peer as any)?.connectionState;
            if (pcState === 'connected') return;
            this.scheduleReconnect();
          }, 2_000);
        }
      },
      onStatsUpdate: (stats) => {
        const latencyEl = document.getElementById('stat-latency');
        const fpsEl = document.getElementById('stat-fps');
        const bitrateEl = document.getElementById('stat-bitrate');
        if (latencyEl) latencyEl.textContent = `${stats.latency}ms`;
        if (fpsEl) fpsEl.textContent = `${stats.fps}fps`;
        if (bitrateEl) {
          const mbps = stats.bitrate / 1_000_000;
          bitrateEl.textContent = mbps >= 1
            ? `${mbps.toFixed(1)}Mbps`
            : `${Math.round(stats.bitrate / 1000)}kbps`;
        }
        updateNetworkBadge(stats.latency, stats.packetLoss);
        pushMetricsSample(stats, this.currentQuality);
        this.evaluateAdaptiveQuality(stats.latency, stats.packetLoss);
      },
    });

    this.peer.onIceCandidate = (candidate) => {
      this.socket?.emit('signal', {
        type: 'ice-candidate',
        to: hostId,
        data: candidate.toJSON(),
      });
    };

    // Enable input handler if control mode
    if (mode === 'control' && videoEl) {
      this.inputHandler = new InputHandler(videoEl, this.peer);
      // Enable after stream is received
      videoEl.addEventListener('loadedmetadata', () => {
        this.inputHandler?.enable();
      }, { once: true });
    }
    this.viewerMode = mode === 'view' ? 'view' : 'control';
  }

  // === View-only / control-lock ===

  /**
   * Viewer-side: switch between sending inputs ('control') and read-only
   * ('view'). The toolbar uses this to flip without tearing down the WebRTC
   * stream — chat / file transfer / video keep flowing.
   *
   * Notifies the host so the host UI can reflect "viewer is just watching"
   * and block any leftover input that races across the channel.
   */
  setViewerMode(mode: 'control' | 'view'): boolean {
    if (this.role !== 'viewer') return false;
    if (this.viewerMode === mode) return true;
    this.viewerMode = mode;

    auditLog('mode-change', `Chuyển sang chế độ ${mode === 'control' ? 'điều khiển' : 'chỉ xem'}`, {
      role: 'viewer',
      details: { mode },
    });

    const videoEl = document.getElementById('remote-video') as HTMLVideoElement | null;
    if (mode === 'control') {
      // Don't re-enable when host has locked control — the user can flip the
      // switch but inputs stay suppressed until host unlocks.
      if (!this.remoteControlLocked && videoEl && this.peer) {
        if (!this.inputHandler) {
          this.inputHandler = new InputHandler(videoEl, this.peer);
        }
        this.inputHandler.enable();
      }
    } else {
      this.inputHandler?.disable();
    }

    this.peer?.send(CHANNEL_SYSTEM, {
      type: 'system',
      action: 'mode-change',
      data: { mode },
    });
    return true;
  }

  get currentViewerMode(): 'control' | 'view' {
    return this.viewerMode;
  }

  /**
   * Read-only accessor for the current partner id, used by features that
   * need to label artifacts produced during the session (e.g. recording
   * filenames). Empty string when no session is active.
   */
  get partnerIdForRecording(): string {
    return this.partnerId;
  }

  get isControlLockedRemotely(): boolean {
    return this.remoteControlLocked;
  }

  get isControlLockedLocally(): boolean {
    return this.controlLocked;
  }

  /**
   * Host-side: lock or unlock the remote control. While locked, any
   * input message that arrives on the input channel is dropped (defense in
   * depth) and the viewer is told to disable its input handler.
   */
  setControlLocked(locked: boolean): boolean {
    if (this.role !== 'host') return false;
    this.controlLocked = locked;
    auditLog(locked ? 'control-lock' : 'control-unlock',
      locked ? 'Đã khóa quyền điều khiển' : 'Đã mở khóa quyền điều khiển',
      { role: 'host', severity: locked ? 'warn' : 'info' });
    return this.peer?.send(CHANNEL_SYSTEM, {
      type: 'system',
      action: 'control-lock',
      data: { locked },
    }) ?? false;
  }

  // === Handle WebRTC signals ===

  private async handleSignal(msg: any): Promise<void> {
    if (!this.peer) return;

    switch (msg.type) {
      case 'offer':
        const answer = await this.peer.handleOffer(msg.data);
        this.socket?.emit('signal', {
          type: 'answer',
          to: msg.from,
          data: answer,
        });
        break;

      case 'answer':
        await this.peer.handleAnswer(msg.data);
        break;

      case 'ice-candidate':
        await this.peer.addIceCandidate(msg.data);
        break;
    }
  }

  // === Password Helpers ===

  private async hashPassword(password: string, nonce: string): Promise<string> {
    const data = new TextEncoder().encode(password + nonce);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private async verifyPassword(hash: string, nonce: string, viewerId?: string): Promise<boolean> {
    try {
      if (window.titanAPI?.identity) {
        const ok = await (window as any).titanAPI.identity.verifyPassword?.(hash, nonce, viewerId) ?? false;
        if (!ok) {
          auditLog('auth-failure', 'Xác thực mật khẩu thất bại', {
            role: 'host',
            partnerId: viewerId,
            severity: 'warn',
          });
        }
        return ok;
      }
    } catch {
      return false;
    }
    return false;
  }

  // === Chat ===

  sendChat(text: string): boolean {
    if (!this.peer) return false;
    return this.peer.send(CHANNEL_CHAT, {
      type: 'chat',
      text,
      sender: this.machineName,
      timestamp: Date.now(),
    });
  }

  // === File Transfer ===

  /**
   * Send a file from local disk to the partner over the file data channel.
   * Reads the file in chunks via main process IPC and streams them as
   * base64-encoded chunk messages. Backpressure is honored by waiting
   * when the data channel buffer grows too large.
   *
   * `targetHint='desktop'` flags the offer so the receiver writes straight
   * to its OS desktop — used by drag-onto-video / drag-onto-host-panel.
   */
  async sendFile(
    filePath: string,
    fileName: string,
    fileSize: number,
    targetHint?: 'desktop',
  ): Promise<void> {
    if (!this.peer) {
      showToast('Chưa kết nối — không thể gửi file', 'error');
      return;
    }
    if (!window.titanAPI?.file?.readChunk) {
      showToast('Không có API đọc file', 'error');
      return;
    }

    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // CHUNK_SIZE MUST be a multiple of 3. Reason: each chunk is encoded to
    // base64 independently before transit. Base64 only emits `=` padding
    // when the input length isn't a multiple of 3. The receiver concatenates
    // every chunk's base64 then decodes once via `Buffer.from(s, 'base64')`
    // — and Node's base64 decoder stops at the first `=` it sees. So if any
    // non-final chunk had padding (e.g. 64*1024=65536 → 65536%3=1 → ends in
    // "=="), the decoder silently truncates the file to whatever came before
    // the first `==`, producing a "successful" save with missing data.
    // 64512 = 63 KB, 64512/3 = 21504 → no padding except possibly on the
    // very last chunk, which is safe at the end of the concatenated string.
    const CHUNK_SIZE = 64512;
    const totalChunks = Math.max(1, Math.ceil(fileSize / CHUNK_SIZE));

    // Surface in UI immediately so the sender sees feedback even on tiny files.
    addFileEntry(fileId, fileName, fileSize, 'sending');

    const offer: FileOfferMessage = {
      type: 'file', action: 'offer',
      fileId, fileName, fileSize,
      fileType: fileName.split('.').pop() || '',
      ...(targetHint ? { targetHint } : {}),
    };
    if (!this.peer.send(CHANNEL_FILE, offer)) {
      updateFileProgress(fileId, 0, 'error');
      return;
    }

    let offset = 0;
    let chunkIndex = 0;
    const channel = (this.peer as any)?.dataChannels?.get?.(CHANNEL_FILE) as RTCDataChannel | undefined;

    while (offset < fileSize) {
      const remaining = fileSize - offset;
      const size = Math.min(CHUNK_SIZE, remaining);
      const base64 = await window.titanAPI.file.readChunk(filePath, offset, size);
      if (base64 == null) {
        updateFileProgress(fileId, 0, 'error');
        showToast(`Lỗi đọc file ${fileName}`, 'error');
        // Notify receiver so it doesn't wait forever.
        this.peer.send(CHANNEL_FILE, { type: 'file', action: 'error', fileId });
        return;
      }

      const chunk: FileChunkMessage = {
        type: 'file', action: 'chunk',
        fileId, chunkIndex, totalChunks,
        data: base64,
      };

      // Backpressure: pause when the SCTP send buffer is congested.
      // Without this, large files crash the data channel. Add a timeout
      // so we don't hang forever if the channel is stuck.
      if (channel) {
        let waited = 0;
        while (channel.bufferedAmount > 1_000_000 && waited < 30_000) {
          await new Promise((r) => setTimeout(r, 100));
          waited += 100;
        }
        if (waited >= 30_000) {
          updateFileProgress(fileId, 0, 'error');
          showToast(`Timeout gửi ${fileName} — kênh bị tắc`, 'error');
          this.peer.send(CHANNEL_FILE, { type: 'file', action: 'error', fileId });
          return;
        }
      }

      if (!this.peer.send(CHANNEL_FILE, chunk)) {
        updateFileProgress(fileId, 0, 'error');
        showToast(`Mất kết nối khi gửi ${fileName}`, 'error');
        // Notify receiver so it doesn't wait forever.
        this.peer.send(CHANNEL_FILE, { type: 'file', action: 'error', fileId });
        return;
      }

      offset += size;
      chunkIndex += 1;
      const percent = Math.round((offset / fileSize) * 100);
      updateFileProgress(fileId, percent, 'sending');
    }

    // Flush bufferedAmount before sending 'complete' so all chunks are
    // guaranteed to arrive before the receiver tries to reassemble.
    if (channel) {
      let waited = 0;
      while (channel.bufferedAmount > 0 && waited < 10_000) {
        await new Promise((r) => setTimeout(r, 50));
        waited += 50;
      }
    }

    this.peer.send(CHANNEL_FILE, {
      type: 'file', action: 'complete', fileId,
    });
    updateFileProgress(fileId, 100, 'complete');
    auditLog('file-sent', `Gửi file: ${fileName}`, {
      details: { fileName, fileSize, targetHint: targetHint || 'default' },
    });
  }

  /**
   * Process incoming file messages on the receiver side.
   * offer  → register a buffer
   * chunk  → append + update progress
   * complete → write to disk via main process and mark done
   */
  private async handleFileMessage(msg: FileMessage): Promise<void> {
    if (!msg || msg.type !== 'file') return;

    if (msg.action === 'offer') {
      this.incomingFiles.set(msg.fileId, {
        name: msg.fileName,
        size: msg.fileSize,
        chunks: new Array(0),
        received: 0,
        totalChunks: 0,
        targetHint: msg.targetHint,
      });
      addFileEntry(msg.fileId, msg.fileName, msg.fileSize, 'receiving');
      return;
    }

    if (msg.action === 'chunk') {
      const entry = this.incomingFiles.get(msg.fileId);
      if (!entry) return;
      // Capture totalChunks from the first chunk message so we can verify
      // completeness before saving.
      if (entry.totalChunks === 0) {
        entry.totalChunks = msg.totalChunks;
      }
      // Store chunk by index so out-of-order arrivals (shouldn't happen on
      // ordered channels, but be defensive) still reassemble correctly.
      entry.chunks[msg.chunkIndex] = msg.data;
      entry.received += 1;
      const percent = Math.round((entry.received / msg.totalChunks) * 100);
      updateFileProgress(msg.fileId, percent, 'receiving');
      return;
    }

    if (msg.action === 'complete') {
      const entry = this.incomingFiles.get(msg.fileId);
      if (!entry) return;
      try {
        // Verify we got every chunk before writing — a missing chunk would
        // silently produce a truncated file because Array#join skips holes.
        // SCTP is ordered + reliable on a normal data channel, but we've
        // seen `peer.send` return false mid-transfer (channel closing,
        // bufferedAmount overflow handling) and that drops the chunk on
        // the sender side without surfacing here.
        const expected = entry.totalChunks;
        if (expected === 0 || entry.received < expected) {
          updateFileProgress(msg.fileId, 0, 'error');
          showToast(
            `File ${entry.name} thiếu dữ liệu (${entry.received}/${expected || '?'} chunks)`,
            'error',
          );
          return;
        }
        for (let i = 0; i < expected; i++) {
          if (typeof entry.chunks[i] !== 'string') {
            updateFileProgress(msg.fileId, 0, 'error');
            showToast(`File ${entry.name} thiếu chunk ${i}`, 'error');
            return;
          }
        }

        // Concatenate base64 chunks then hand off to main for disk write.
        const fullBase64 = entry.chunks.join('');
        const result = await window.titanAPI?.file?.saveFile(entry.name, fullBase64, entry.targetHint);
        if (result?.success) {
          updateFileProgress(msg.fileId, 100, 'complete', result.path);
          const where = entry.targetHint === 'desktop' ? ' (Desktop)' : '';
          showToast(`Đã nhận: ${entry.name}${where}`, 'success');
          auditLog('file-received', `Nhận file: ${entry.name}`, {
            details: { fileName: entry.name, fileSize: entry.size, target: entry.targetHint || 'default', path: result.path || '' },
          });
        } else {
          updateFileProgress(msg.fileId, 0, 'error');
          showToast(`Lỗi lưu ${entry.name}`, 'error');
        }
      } catch (err) {
        console.error('[Conn] saveFile failed:', err);
        updateFileProgress(msg.fileId, 0, 'error');
      } finally {
        this.incomingFiles.delete(msg.fileId);
      }
      return;
    }

    if (msg.action === 'error') {
      updateFileProgress(msg.fileId, 0, 'error');
      this.incomingFiles.delete(msg.fileId);
    }
  }

  // === Quality Control ===

  /**
   * Viewer-side: request a different quality preset from the host.
   * The host re-applies sender params + capture constraints.
   *
   * Calling this is treated as a manual pin — the adaptive controller
   * stops auto-adjusting so the user's choice sticks.
   */
  requestQuality(preset: QualityPreset): boolean {
    if (this.role !== 'viewer') return false;
    this.currentQuality = preset;
    this.adaptiveEnabled = false;
    this.adaptiveBadSamples = 0;
    this.adaptiveGoodSamples = 0;
    auditLog('quality-change', `Đổi chất lượng: ${preset}`, {
      role: 'viewer',
      details: { preset },
    });
    return this.peer?.send(CHANNEL_SYSTEM, {
      type: 'system',
      action: 'quality',
      data: { preset },
    }) ?? false;
  }

  /**
   * Re-enable the adaptive controller after a manual pin. Call this when
   * the user explicitly chooses "Auto" from the quality menu.
   */
  setAdaptiveEnabled(enabled: boolean): void {
    this.adaptiveEnabled = enabled;
    this.adaptiveBadSamples = 0;
    this.adaptiveGoodSamples = 0;
    this.adaptiveCooldown = 0;
  }

  // === Codec preference ===

  /**
   * Viewer-side: tell the host to switch encoder codec (h264 ↔ h265).
   * The host will reorder its setCodecPreferences and renegotiate (createOffer
   * → answer round-trip) so the next encoded frames use the new codec.
   *
   * No-op when WebRTC capability probing says the local browser can't decode
   * the requested codec — caller should pre-check via codecSupported().
   */
  requestCodec(codec: VideoCodec): boolean {
    if (this.role !== 'viewer') return false;
    this.currentCodec = codec;
    auditLog('codec-change', `Đổi codec: ${codec}`, {
      role: 'viewer',
      details: { codec },
    });
    return this.peer?.send(CHANNEL_SYSTEM, {
      type: 'system',
      action: 'codec',
      data: { preferred: codec },
    }) ?? false;
  }

  get codec(): VideoCodec {
    return this.currentCodec;
  }

  /**
   * Probe whether the local Chromium build can *decode* a codec. Used to
   * gray out advanced toggles on builds that don't expose the codec over
   * WebRTC (HEVC/AV1 ship behind feature flags on some channels). The check
   * looks at RTCRtpReceiver capabilities — sender capabilities are
   * irrelevant on the viewer (it doesn't encode video).
   */
  static codecSupported(codec: VideoCodec): boolean {
    try {
      const caps = (RTCRtpReceiver as any).getCapabilities?.('video');
      if (!caps?.codecs) return codec === 'h264'; // assume H.264 always works
      const target =
        codec === 'h265' ? 'video/h265'
        : codec === 'av1' ? 'video/av1'
        : codec === 'vp9' ? 'video/vp9'
        : 'video/h264';
      return (caps.codecs as Array<{ mimeType: string }>).some(
        (c) => c.mimeType.toLowerCase() === target,
      );
    } catch {
      return codec === 'h264';
    }
  }

  /**
   * Idle FPS reduction — when the viewer window stays hidden for ~3 s, step
   * down to the cheapest preset so the host stops burning bandwidth on
   * frames nobody is looking at. Restored the moment the window returns.
   *
   * Uses Page Visibility instead of focus because focus stays on the OS
   * "active app" even when our window is fully covered — visibilitychange
   * fires on minimize, alt-tab, and workspace switch.
   */
  private onVisibilityChange(): void {
    if (this.role !== 'viewer') return;
    if (document.visibilityState === 'hidden') {
      // Wait a few seconds before downgrading. Brief alt-tabs (looking up
      // a value, switching to a comm app) shouldn't trigger a costly
      // renegotiation cycle.
      if (this.idleFpsTimer) clearTimeout(this.idleFpsTimer);
      this.idleFpsTimer = window.setTimeout(() => {
        if (document.visibilityState !== 'hidden') return;
        if (this.idleFpsActive) return;
        if (!this.peer || !this.adaptiveEnabled) return;
        this.idleFpsActive = true;
        this.idleFpsPreviousPreset = this.currentQuality;
        this.currentQuality = 'tiny';
        this.peer.send(CHANNEL_SYSTEM, {
          type: 'system',
          action: 'quality',
          data: { preset: 'tiny', source: 'idle' },
        });
        console.log('[Conn] Window hidden — dropped to "tiny" to save bandwidth');
      }, 3_000);
    } else {
      if (this.idleFpsTimer) {
        clearTimeout(this.idleFpsTimer);
        this.idleFpsTimer = null;
      }
      if (!this.idleFpsActive || !this.peer) return;
      const restore = this.idleFpsPreviousPreset || DEFAULT_QUALITY;
      this.idleFpsActive = false;
      this.idleFpsPreviousPreset = null;
      this.currentQuality = restore;
      this.peer.send(CHANNEL_SYSTEM, {
        type: 'system',
        action: 'quality',
        data: { preset: restore, source: 'idle-restore' },
      });
      console.log('[Conn] Window visible — restored to', restore);
    }
  }

  // === Multi-monitor ===

  /**
   * Viewer-side: read-only access to the host's monitor list (cached from
   * the latest 'monitor-list' message). The View menu uses this to render
   * the picker without an extra round-trip.
   */
  get availableRemoteMonitors(): Array<{ id: string; name: string; isPrimary: boolean }> {
    return this.remoteMonitors;
  }

  get currentRemoteSourceId(): string | null {
    return this.activeRemoteSourceId;
  }

  /**
   * Viewer-side: ask the host to share a specific monitor.
   * The host swaps the video track in-place (no SDP renegotiation) so the
   * `<video>` element keeps playing — only the picture changes.
   */
  requestMonitor(sourceId: string): boolean {
    if (this.role !== 'viewer') return false;
    auditLog('monitor-switch', `Đổi màn hình hiển thị`, {
      role: 'viewer',
      details: { sourceId },
    });
    return (
      this.peer?.send(CHANNEL_SYSTEM, {
        type: 'system',
        action: 'switch-monitor',
        data: { sourceId },
      }) ?? false
    );
  }

  /**
   * Viewer-side: ping the host for its current monitor list. Called when
   * the View menu opens so the picker reflects any plug/unplug since the
   * initial request, and as a safety-net if the initial request was lost.
   */
  requestMonitorList(): boolean {
    if (this.role !== 'viewer') return false;
    return (
      this.peer?.send(CHANNEL_SYSTEM, {
        type: 'system',
        action: 'request-monitors',
        data: {},
      }) ?? false
    );
  }

  /**
   * Host-side: gather the current monitor list (id + name + primary flag,
   * stripped of thumbnails to keep the system message small) and push it to
   * the viewer. Called when the system channel first opens and every time
   * the active source changes.
   */
  private async pushMonitorListToViewer(): Promise<void> {
    const api = (window as any).titanAPI?.screen;
    if (!api?.getSources) return;
    try {
      const monitors = ((await api.getSources()) || []) as Array<{
        id: string;
        name: string;
        isPrimary: boolean;
      }>;
      const slim = monitors.map((m) => ({
        id: m.id,
        name: m.name,
        isPrimary: m.isPrimary,
      }));
      const activeSourceId = (await api.getSelectedSource?.()) ?? null;
      this.peer?.send(CHANNEL_SYSTEM, {
        type: 'system',
        action: 'monitor-list',
        data: { monitors: slim, activeSourceId },
      });
    } catch (err) {
      console.warn('[Conn] failed to enumerate monitors:', err);
    }
  }

  /**
   * Host-side: re-capture using the requested source id and replace the
   * existing video track so the viewer's video stays continuous (no black
   * flash, no SDP renegotiation). After swapping, push the updated monitor
   * list so the viewer's picker reflects the new active selection.
   */
  private async handleMonitorSwitch(sourceId: string | undefined): Promise<void> {
    if (!sourceId || !this.peer) return;
    const api = (window as any).titanAPI?.screen;
    if (!api?.selectSource) {
      showToast('Bản dựng này chưa hỗ trợ đổi màn hình', 'info');
      return;
    }
    try {
      // Tell the main-process display media handler which source to bind to
      // on the next getDisplayMedia call.
      await api.selectSource(sourceId);

      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: {
          width: { max: DEFAULT_MAX_WIDTH },
          height: { max: DEFAULT_MAX_HEIGHT },
          frameRate: { max: 60 },
          // Hide host cursor in video stream to support local cursor rendering
          cursor: 'never' as any,
        },
      });

      const ok = await this.peer.replaceVideoTrack(stream);
      if (!ok) {
        showToast('Không đổi được màn hình chia sẻ', 'error');
        return;
      }
      // Re-apply the active quality profile so the new track inherits the
      // same bitrate caps + framerate as the previous one.
      await this.peer.applyQualityProfile(this.currentQuality);
      // Move the annotation overlay to the new monitor so future strokes
      // land on the right desktop instead of the previous source.
      try {
        await (window as any).titanAPI?.annotation?.setSource?.(sourceId);
      } catch (err) {
        console.warn('[Conn] annotation setSource failed:', err);
      }
      await this.pushMonitorListToViewer();
      showToast('Đã đổi màn hình chia sẻ', 'success');
    } catch (err) {
      console.error('[Conn] handleMonitorSwitch error:', err);
      showToast('Không đổi được màn hình chia sẻ', 'error');
    }
  }

  get isAdaptive(): boolean {
    return this.adaptiveEnabled;
  }

  /**
   * Step the active quality up or down based on observed RTT + loss.
   *
   * Step DOWN: sustained high RTT or non-trivial packet loss for N samples.
   *   Trade resolution/bitrate for smooth motion — what UltraViewer does on a
   *   congested link.
   * Step UP:   sustained low RTT and zero loss for N samples.
   *   Climb back to a sharper preset once the network looks healthy again.
   *
   * Cooldown after each change prevents oscillation while the encoder ramps.
   */
  private evaluateAdaptiveQuality(rttMs: number, lossFrac: number): void {
    if (!this.adaptiveEnabled || this.role !== 'viewer') return;
    if (!this.peer) return;
    if (this.adaptiveCooldown > 0) {
      this.adaptiveCooldown -= 1;
      return;
    }
    // Stats reports of zero RTT happen briefly right after the connection
    // forms — ignore those samples so we don't false-positive an "upgrade".
    if (rttMs <= 0) return;

    const order: QualityPreset[] = ['max', 'ultra', 'responsive', 'high', 'medium', 'low', 'tiny'];
    const idx = order.indexOf(this.currentQuality);
    if (idx === -1) return;

    const isBad =
      rttMs >= ADAPTIVE_RTT_DOWNGRADE_MS || lossFrac >= ADAPTIVE_LOSS_DOWNGRADE;
    const isGood =
      rttMs <= ADAPTIVE_RTT_UPGRADE_MS && lossFrac < ADAPTIVE_LOSS_DOWNGRADE / 4;

    if (isBad) {
      this.adaptiveBadSamples += 1;
      this.adaptiveGoodSamples = 0;
      if (this.adaptiveBadSamples >= ADAPTIVE_DEBOUNCE_SAMPLES && idx < order.length - 1) {
        const next = order[idx + 1];
        console.log(`[Conn] Adaptive ↓ ${this.currentQuality} → ${next} (rtt=${rttMs}ms loss=${(lossFrac * 100).toFixed(1)}%)`);
        this.applyAdaptivePreset(next);
      }
    } else if (isGood) {
      this.adaptiveGoodSamples += 1;
      this.adaptiveBadSamples = 0;
      // Need ~2× the patience to climb back up than to drop, so a transient
      // burst of good samples doesn't yo-yo us into a tier we can't sustain.
      if (this.adaptiveGoodSamples >= ADAPTIVE_DEBOUNCE_SAMPLES * 2 && idx > 0) {
        const next = order[idx - 1];
        console.log(`[Conn] Adaptive ↑ ${this.currentQuality} → ${next} (rtt=${rttMs}ms loss=${(lossFrac * 100).toFixed(1)}%)`);
        this.applyAdaptivePreset(next);
      }
    } else {
      // Neutral sample — slowly drain both counters so isolated spikes don't
      // accumulate into a false trigger.
      this.adaptiveBadSamples = Math.max(0, this.adaptiveBadSamples - 1);
      this.adaptiveGoodSamples = Math.max(0, this.adaptiveGoodSamples - 1);
    }
  }

  /**
   * Apply an adaptive preset change without flipping adaptiveEnabled off
   * (which is what requestQuality does for manual user-pinned changes).
   */
  private applyAdaptivePreset(preset: QualityPreset): void {
    this.currentQuality = preset;
    this.adaptiveBadSamples = 0;
    this.adaptiveGoodSamples = 0;
    this.adaptiveCooldown = ADAPTIVE_DEBOUNCE_SAMPLES;
    this.peer?.send(CHANNEL_SYSTEM, {
      type: 'system',
      action: 'quality',
      data: { preset, source: 'auto' },
    });
  }

  get quality(): QualityPreset {
    return this.currentQuality;
  }

  /**
   * Handle a SystemMessage received on the data channel.
   * Handles quality changes (host-side) and clipboard sync (both sides).
   */
  private handleSystemMessage(msg: any): void {
    if (!msg || msg.type !== 'system') return;

    switch (msg.action) {
      case 'quality':
        if (this.role === 'host') {
          const preset: QualityPreset = msg.data?.preset;
          if (!preset) return;
          this.currentQuality = preset;
          // Mobile viewers pass `degradationPreference: 'maintain-resolution'`
          // so the encoder drops fps before pixelating text. Desktop viewers
          // omit the field — host falls back to its `maintain-framerate`
          // default in that case.
          const degPref = msg.data?.degradationPreference as RTCDegradationPreference | undefined;
          this.peer?.applyQualityProfile(preset, degPref);
        }
        break;

      case 'codec':
        // Viewer asked the host to switch encoder codec (H.264 ↔ H.265).
        // Reorder the codec preferences then create a fresh offer so the
        // next encoded frames use the chosen codec. Renegotiation is cheap —
        // the existing data channels and SSRC stay alive, only the SDP
        // codec ordering and resulting payload type change.
        if (this.role === 'host') {
          const preferred = msg.data?.preferred as VideoCodec | undefined;
          if (!preferred) return;
          this.currentCodec = preferred;
          this.peer?.setCodecPreference(preferred);
          this.peer?.renegotiate().then((offer) => {
            this.socket?.emit('signal', {
              type: 'offer',
              to: this.partnerId,
              data: offer,
            });
            console.log(`[Conn] Codec switched to ${preferred} — renegotiating`);
          }).catch((err) => {
            console.warn('[Conn] Codec renegotiation failed:', err);
          });
        }
        break;

      case 'clipboard':
        this.handleClipboardMessage(msg.data);
        break;

      case 'remote-action':
        // Only the host should ever execute these. Ignore on viewer side.
        if (this.role === 'host') {
          this.handleRemoteAction(msg.data);
        }
        break;

      case 'remote-action-result':
        if (this.role === 'viewer') {
          this.handleRemoteActionResult(msg.data);
        }
        break;

      case 'mode-change':
        // Host receives notification that viewer flipped Control/View.
        if (this.role === 'host') {
          const mode = msg.data?.mode === 'view' ? 'view' : 'control';
          import('../pages/session').then(({ updateHostViewerMode }) => {
            updateHostViewerMode(this.partnerId, mode);
          });
        }
        break;

      case 'control-lock':
        // Viewer receives lock state from host. When locked, kill the input
        // handler immediately so a held key/button can't be exploited.
        if (this.role === 'viewer') {
          const locked = !!msg.data?.locked;
          this.remoteControlLocked = locked;
          if (locked) {
            this.inputHandler?.disable();
          } else if (this.viewerMode === 'control') {
            const videoEl = document.getElementById('remote-video') as HTMLVideoElement | null;
            if (videoEl && this.peer) {
              if (!this.inputHandler) {
                this.inputHandler = new InputHandler(videoEl, this.peer);
              }
              this.inputHandler.enable();
            }
          }
          import('../pages/session').then(({ updateRemoteControlLock }) => {
            updateRemoteControlLock(locked);
          });
        }
        break;

      case 'switch-monitor':
        // Viewer asked the host to share a different monitor. Re-capture using
        // the requested source id and replace the existing track in-place.
        if (this.role === 'host') {
          this.handleMonitorSwitch(msg.data?.sourceId).catch((err) =>
            console.warn('[Conn] handleMonitorSwitch failed:', err),
          );
        }
        break;

      case 'request-monitors':
        // Viewer asked for the current monitor list (sent on system-channel
        // open). Reply with monitor-list. This is the request/response form;
        // it dodges the race where a host-initiated push lands before the
        // viewer's onmessage is wired up.
        if (this.role === 'host') {
          this.pushMonitorListToViewer().catch((err: unknown) =>
            console.warn('[Conn] pushMonitorListToViewer failed:', err),
          );
        }
        break;

      case 'monitor-list':
        // Host pushed its current list of monitors. Cache + render in the
        // viewer's View menu so the user can pick.
        if (this.role === 'viewer') {
          this.remoteMonitors = Array.isArray(msg.data?.monitors) ? msg.data.monitors : [];
          this.activeRemoteSourceId = msg.data?.activeSourceId || null;
          import('../pages/session').then(({ updateMonitorMenu }) => {
            updateMonitorMenu(this.remoteMonitors, this.activeRemoteSourceId);
          });
        }
        break;

      case 'peer-bye':
        // Partner is tearing down on purpose. Mark this side intentional too
        // so the viewer's onStateChange grace timer doesn't fire reconnect
        // when the peer subsequently goes to 'disconnected'/'failed'.
        // Travels over the data channel, so it's independent of the signal
        // server's deploy state — works even if the server hasn't been
        // restarted with the matching peer-disconnect handler.
        if (!this.intentionalClose) {
          this.intentionalClose = true;
          this.cancelReconnect();
          this.viewerCredentials = null;
          this.disconnect();
          showToast('Phiên kết nối đã kết thúc', 'info');
          import('../main').then(({ navigateTo }) => navigateTo('home'));
        }
        break;
    }
  }

  /**
   * Execute a remote action on this host machine and report the result back
   * to the viewer. Used for Lock / Sign out / Restart / Shutdown / etc.
   */
  private async handleRemoteAction(data: any): Promise<void> {
    const action = data?.action as string | undefined;
    const requestId = data?.requestId as string | undefined;
    if (!action) return;
    auditLog('remote-action', `Nhận lệnh hệ thống từ đối tác: ${action}`, {
      role: 'host',
      details: { action },
      severity: action === 'shutdown' || action === 'restart' || action === 'signout' ? 'warn' : 'info',
    });
    let result: { success: boolean; error?: string } = { success: false, error: 'No system API' };
    try {
      if ((window as any).titanAPI?.system?.execute) {
        result = await (window as any).titanAPI.system.execute(action);
      }
    } catch (err: any) {
      result = { success: false, error: err?.message || String(err) };
    }
    this.peer?.send(CHANNEL_SYSTEM, {
      type: 'system',
      action: 'remote-action-result',
      data: { requestId, action, ...result },
    });
  }

  /**
   * Show the result of a remote action on the viewer side.
   */
  private handleRemoteActionResult(data: any): void {
    if (!data) return;
    const action = data.action as string | undefined;
    const isWallpaper = action === 'hide-wallpaper' || action === 'restore-wallpaper';

    // Wallpaper toggle owns its own UX (the menu checkmark + a tailored toast)
    // so we don't fire the generic toast for it. On failure, roll the optimistic
    // local state back via the session module.
    if (isWallpaper) {
      import('../pages/session').then(({ onWallpaperResult }) => {
        onWallpaperResult(action!, !!data.success, data.error);
      });
      return;
    }

    if (data.success) {
      showToast('Đã thực hiện trên máy đối tác', 'success');
    } else {
      showToast(`Lỗi: ${data.error || 'Không thể thực hiện'}`, 'error');
    }
  }

  /**
   * Viewer-side: ask the host to run a privileged system action.
   * Returns false when the data channel isn't ready.
   */
  sendRemoteAction(action: string): boolean {
    if (this.role !== 'viewer') return false;
    auditLog('remote-action', `Gửi lệnh hệ thống: ${action}`, {
      role: 'viewer',
      details: { action },
      severity: action === 'shutdown' || action === 'restart' || action === 'signout' ? 'warn' : 'info',
    });
    return (
      this.peer?.send(CHANNEL_SYSTEM, {
        type: 'system',
        action: 'remote-action',
        data: { action, requestId: `${Date.now()}` },
      }) ?? false
    );
  }

  // === Clipboard Sync ===

  /**
   * Handle clipboard system messages.
   *
   * HOST receives:
   *   'viewer-to-host'    — viewer sent clipboard text to paste on host
   *   'request-from-host' — viewer wants to read host clipboard (after Ctrl+C)
   *
   * VIEWER receives:
   *   'host-to-viewer'    — host sent its clipboard text back
   */
  private async handleClipboardMessage(data: any): Promise<void> {
    if (!data?.direction) return;

    if (this.role === 'host') {
      if (data.direction === 'viewer-to-host' && typeof data.text === 'string') {
        // Viewer wants to paste → write text to host clipboard, then simulate Ctrl+V
        try {
          await window.titanAPI?.clipboard?.write(data.text);
          console.log('[Conn] Clipboard received from viewer, simulating paste');
          auditLog('clipboard-sync', `Đối tác dán nội dung (${data.text.length} ký tự)`, {
            role: 'host',
            details: { direction: 'viewer-to-host', length: data.text.length },
          });
          // Simulate Ctrl+V on the host
          await window.titanAPI?.input?.simulate({ type: 'key', action: 'down', key: 'Control', code: 'ControlLeft', modifiers: ['ctrl'] });
          await window.titanAPI?.input?.simulate({ type: 'key', action: 'down', key: 'v', code: 'KeyV', modifiers: ['ctrl'] });
          await window.titanAPI?.input?.simulate({ type: 'key', action: 'up', key: 'v', code: 'KeyV', modifiers: ['ctrl'] });
          await window.titanAPI?.input?.simulate({ type: 'key', action: 'up', key: 'Control', code: 'ControlLeft', modifiers: [] });
        } catch (err) {
          console.error('[Conn] Clipboard paste on host failed:', err);
        }
      } else if (data.direction === 'viewer-to-host-no-paste' && typeof data.text === 'string') {
        // Same as above but the viewer is just syncing — no Ctrl+V follow-up.
        try {
          await window.titanAPI?.clipboard?.write(data.text);
          auditLog('clipboard-sync', `Đối tác đồng bộ clipboard (${data.text.length} ký tự)`, {
            role: 'host',
            details: { direction: 'viewer-to-host-sync', length: data.text.length },
          });
        } catch (err) {
          console.error('[Conn] Clipboard sync on host failed:', err);
        }
      } else if (data.direction === 'request-from-host') {
        // Viewer wants host clipboard → read it and send back
        try {
          // Small delay to let the copy operation complete on the OS
          await new Promise((r) => setTimeout(r, 100));
          const text = await window.titanAPI?.clipboard?.read();
          if (text != null) {
            this.peer?.send(CHANNEL_SYSTEM, {
              type: 'system',
              action: 'clipboard',
              data: { direction: 'host-to-viewer', text },
            });
            auditLog('clipboard-sync', `Đối tác sao chép từ máy này (${text.length} ký tự)`, {
              role: 'host',
              details: { direction: 'host-to-viewer', length: text.length },
            });
            console.log('[Conn] Clipboard sent to viewer:', text.length, 'chars');
          }
        } catch (err) {
          console.error('[Conn] Failed to read host clipboard:', err);
        }
      }
    } else if (this.role === 'viewer') {
      if (data.direction === 'host-to-viewer' && typeof data.text === 'string') {
        // Host sent clipboard content → write to viewer's local clipboard
        try {
          await window.titanAPI?.clipboard?.write(data.text);
          auditLog('clipboard-sync', `Sao chép từ máy đối tác (${data.text.length} ký tự)`, {
            role: 'viewer',
            details: { direction: 'host-to-viewer', length: data.text.length },
          });
          console.log('[Conn] Clipboard received from host:', data.text.length, 'chars');
        } catch (err) {
          console.error('[Conn] Failed to write to local clipboard:', err);
        }
      }
    }
  }

  /**
   * Viewer-side: explicitly request the host's clipboard. Useful for the
   * "Sync clipboard now" menu entry — without this, sync only happens on
   * Ctrl+C/V/X. Returns false when the data channel isn't ready.
   */
  pullHostClipboard(): boolean {
    if (this.role !== 'viewer') return false;
    return (
      this.peer?.send(CHANNEL_SYSTEM, {
        type: 'system',
        action: 'clipboard',
        data: { direction: 'request-from-host' },
      }) ?? false
    );
  }

  /**
   * Viewer-side: push the local clipboard's current contents to the host
   * without a paste keystroke. Useful when the user wants the host to see
   * a snippet without triggering an immediate paste.
   */
  async pushClipboardToHost(): Promise<boolean> {
    if (this.role !== 'viewer') return false;
    try {
      const text = await window.titanAPI?.clipboard?.read();
      if (text == null) return false;
      return (
        this.peer?.send(CHANNEL_SYSTEM, {
          type: 'system',
          action: 'clipboard',
          data: { direction: 'viewer-to-host-no-paste', text },
        }) ?? false
      );
    } catch {
      return false;
    }
  }

  // === Heartbeat ===

  private startHeartbeat(): void {
    this.heartbeatTimer = window.setInterval(() => {
      this.socket?.emit('ping');
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Viewer-side: send an annotation message to the host. The host renders
   * the stroke on a transparent click-through overlay that covers the
   * shared monitor — what UltraViewer / TeamViewer call "screen drawing"
   * for live remote support.
   */
  sendAnnotation(msg: AnnotationMessage): boolean {
    if (this.role !== 'viewer') return false;
    return this.peer?.send(CHANNEL_ANNOTATION, msg) ?? false;
  }

  /**
   * Host-side: relay an incoming annotation message to the main process so
   * the transparent overlay window can paint the stroke. Best-effort —
   * a missing IPC bridge just means the host build doesn't ship the
   * annotation overlay yet.
   */
  private handleHostAnnotation(msg: AnnotationMessage): void {
    if (!msg || msg.type !== 'annotation') return;
    const api = (window as any).titanAPI?.annotation;
    if (!api?.relay) return;
    try {
      api.relay(msg);
    } catch (err) {
      console.warn('[Conn] annotation relay failed:', err);
    }
  }

  // === Disconnect ===

  disconnect(): void {
    this.intentionalClose = true;
    this.cancelReconnect();
    if (this.idleFpsTimer) {
      clearTimeout(this.idleFpsTimer);
      this.idleFpsTimer = null;
    }
    this.idleFpsActive = false;
    this.idleFpsPreviousPreset = null;
    document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
    if (this.role) {
      auditLog('session-end', 'Phiên kết thúc', {
        role: this.role,
        partnerId: this.partnerId,
      });
      setActiveAuditSession(null);
    }
    // Tell the partner we're leaving on purpose. Two paths so this works
    // even if one of them is broken at the moment:
    //   1) data channel → instant, doesn't depend on the signal server
    //   2) signal server → fallback when the data channel already closed
    try {
      this.peer?.send(CHANNEL_SYSTEM, {
        type: 'system',
        action: 'peer-bye',
      });
    } catch {
      // best-effort
    }
    if (this.partnerId && this.socket?.connected) {
      this.socket.emit('peer-disconnect', { toId: this.partnerId });
    }
    this.viewerCredentials = null;
    this.inputHandler?.disable();
    // Hold the peer reference and close it on a short delay so the SCTP
    // data channel has time to flush peer-bye. Calling pc.close()
    // synchronously here drops queued messages, leaving the partner to
    // wait out a 10–30 s ICE timeout before its UI tears down.
    const peerToClose = this.peer;
    this.peer = null;
    this.inputHandler = null;
    if (peerToClose) {
      setTimeout(() => {
        try {
          peerToClose.close();
        } catch {
          // best-effort
        }
      }, 250);
    }
    if (this.role === 'host') {
      exitHostMode();
      // Tear down the host-side annotation overlay so it doesn't dangle as
      // a transparent window above the desktop after the session ends.
      try {
        (window as any).titanAPI?.annotation?.close?.();
      } catch (e) {
        console.warn('[Conn] annotation close failed:', e);
      }
      // Always try to restore — restoreWallpaper is a no-op when the user
      // had hideWallpaper turned off, so we don't need to track the flag.
      window.titanAPI?.wallpaper?.restore().catch((err: unknown) =>
        console.warn('[Conn] restoreWallpaper failed:', err),
      );
    }
    this.role = null;
    this.partnerId = '';
    this.historyRecordedFor = null;
    // Reset the network badge so the next session doesn't inherit the prior
    // one's color before the first stats sample lands.
    const badge = document.getElementById('stat-network-badge');
    if (badge) {
      badge.className = 'stat-network-badge stat-network-unknown';
      const label = badge.querySelector('.stat-network-label');
      if (label) label.textContent = '--';
    }
  }

  disconnectAll(): void {
    this.disconnect();
    this.stopHeartbeat();
    this.socket?.disconnect();
    this.socket = null;
  }

  get isConnectedToServer(): boolean {
    return this.socket?.connected ?? false;
  }

  /**
   * Persist a successful viewer connect into the local history list and bump
   * the matching address-book entry's lastConnectedAt. Idempotent for the
   * lifetime of the current session — we only record the first transition to
   * the connected state, not every ICE flap.
   */
  private historyRecordedFor: string | null = null;
  private async recordSuccessfulConnect(hostId: string): Promise<void> {
    if (!hostId || hostId.length < 9) return;
    if (this.historyRecordedFor === hostId) return;
    this.historyRecordedFor = hostId;

    const api = (window as any).titanAPI;
    try {
      await api?.history?.add({
        machineId: hostId,
        machineName: '',
        lastConnected: Date.now(),
        totalSessions: 1,
        lastPassword: this.viewerCredentials?.password || '',
      });
    } catch {
      // best-effort
    }
    try {
      const list = (await api?.addressBook?.get()) || [];
      const match = list.find((e: any) => e.machineId === hostId);
      if (match) await api?.addressBook?.touch(match.id);
    } catch {
      // best-effort
    }
  }

  // === Auto-reconnect (viewer-side) ===

  /**
   * Read the user's wallpaper preference from settings and ask the main
   * process to blank the desktop. Best-effort — failures shouldn't block
   * the session from coming up. Restored from disconnect().
   */
  private async maybeHideWallpaper(): Promise<void> {
    try {
      const settings = await window.titanAPI?.settings?.get();
      if (!settings?.hideWallpaper) return;
      await window.titanAPI?.wallpaper?.hide();
    } catch (err) {
      console.warn('[Conn] maybeHideWallpaper error:', err);
    }
  }

  /**
   * Public hook called by the session UI right before the user fires a
   * destructive remote action. Lets the reconnect loop be patient (longer
   * initial wait + bigger budget) because the host OS is about to restart.
   *
   * Pure host-controlling actions (lock, ctrl-alt-del, task-manager) don't
   * tear down the WebRTC peer, so we ignore them here.
   */
  markExpectedDisconnect(action: string): void {
    if (action === 'signout' || action === 'restart' || action === 'shutdown') {
      this.expectedDisconnectKind = action;
    }
  }

  /**
   * Roll back markExpectedDisconnect — called when the action couldn't be
   * delivered (data channel not open, etc) so the next unrelated drop
   * doesn't sit on a long initial delay waiting for a reboot that never
   * happened.
   */
  clearExpectedDisconnect(): void {
    this.expectedDisconnectKind = null;
  }

  /**
   * Kick off the auto-retry loop. Triggered when the viewer's peer hits
   * 'disconnected' or 'failed' state without an intentional teardown.
   * Backoff steps up gradually so we don't spam the signal server, with a
   * larger budget when the host is rebooting.
   */
  private scheduleReconnect(): void {
    if (!this.viewerCredentials || this.intentionalClose) return;
    if (this.reconnecting) return;

    this.reconnecting = true;
    this.reconnectAttempt = 0;
    this.reconnectMax = this.expectedDisconnectKind ? 20 : 8;

    showReconnectingState(
      this.viewerCredentials.partnerId,
      0,
      this.reconnectMax,
      !!this.expectedDisconnectKind,
    );

    // First retry slightly delayed so the host has time to die / start coming back.
    // Restart/shutdown need much longer — give the OS ~10s before the first probe.
    const initialDelay = this.expectedDisconnectKind === 'restart'
      ? 10_000
      : this.expectedDisconnectKind === 'shutdown'
      ? 8_000
      : this.expectedDisconnectKind === 'signout'
      ? 5_000
      : 1_500;

    this.reconnectTimer = window.setTimeout(() => this.attemptReconnect(), initialDelay);
  }

  private attemptReconnect(): void {
    if (!this.reconnecting || !this.viewerCredentials) return;

    this.reconnectAttempt += 1;
    const { partnerId, password, mode } = this.viewerCredentials;

    showReconnectingState(partnerId, this.reconnectAttempt, this.reconnectMax, !!this.expectedDisconnectKind);
    console.log(`[Conn] Reconnect attempt ${this.reconnectAttempt}/${this.reconnectMax} to ${partnerId}`);

    // Tear down any half-built peer from the previous attempt before retrying.
    // Without this, a stale RTCPeerConnection in 'failed' state piggybacks on
    // the next setupAsViewer call and the reconnect never completes.
    this.inputHandler?.disable();
    this.peer?.close();
    this.peer = null;
    this.inputHandler = null;

    // Make sure the signal server is still there — if we also lost the
    // socket we need it back before connect-request can land.
    if (!this.socket?.connected) {
      console.log('[Conn] Signal socket down — waiting before next attempt');
      this.scheduleNextAttempt();
      return;
    }

    // Re-issue the original connect-request flow. connectToPartner() resets
    // intentionalClose=false and the listeners it installs are .once() so
    // they self-clean.
    this.connectToPartner(partnerId, password, mode).catch((err) => {
      console.warn('[Conn] reconnect attempt threw:', err);
    });

    // Schedule a watchdog: if peer doesn't reach 'connected' within a window,
    // assume this attempt failed and queue the next one. onStateChange will
    // cancel this if we succeed.
    this.scheduleNextAttempt();
  }

  /**
   * Schedule the next retry. Backoff: 3s, 5s, 8s, then 10s thereafter.
   * Cleared by cancelReconnect() on success or user disconnect.
   */
  private scheduleNextAttempt(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.reconnectAttempt >= this.reconnectMax) {
      this.giveUpReconnect();
      return;
    }

    const backoffSteps = [3_000, 5_000, 8_000, 10_000];
    const delay = backoffSteps[Math.min(this.reconnectAttempt, backoffSteps.length - 1)];
    this.reconnectTimer = window.setTimeout(() => {
      // If we're already connected by the time this fires, the state-change
      // handler will have called cancelReconnect; this is just the fallback.
      if (this.peer && (this.peer as any).connectionState === 'connected') return;
      this.attemptReconnect();
    }, delay);
  }

  /**
   * Stop any pending retry timer and reset retry bookkeeping.
   * Safe to call multiple times.
   */
  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this.expectedDisconnectKind = null;
  }

  /**
   * Out of attempts — clear state, surface a toast, drop the user back to home.
   */
  private giveUpReconnect(): void {
    console.log('[Conn] Giving up reconnect after', this.reconnectAttempt, 'attempts');
    this.cancelReconnect();
    this.viewerCredentials = null;
    hideReconnectingState();
    showToast('Không thể kết nối lại — đã hết số lần thử', 'error');
    this.handleViewerConnectFailure();
  }
}
