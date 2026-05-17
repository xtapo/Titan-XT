/**
 * Connection Manager — Handles Socket.io signaling and WebRTC lifecycle
 */

import { io, Socket } from 'socket.io-client';
import { PeerConnection } from './webrtc';
import { InputHandler } from './input-handler';
import { addChatMessage } from '../pages/session';
import { showToast } from '../components/toast';
import {
  CHANNEL_INPUT,
  CHANNEL_CHAT,
  CHANNEL_SYSTEM,
  DEFAULT_SIGNAL_SERVER,
  HEARTBEAT_INTERVAL,
  DEFAULT_QUALITY,
  QualityPreset,
} from '../../shared/constants';

export class ConnectionManager {
  private socket: Socket | null = null;
  private peer: PeerConnection | null = null;
  private inputHandler: InputHandler | null = null;
  private heartbeatTimer: number | null = null;
  private serverUrl: string;
  private machineId: string = '';
  private machineName: string = '';
  private currentQuality: QualityPreset = DEFAULT_QUALITY;
  private role: 'host' | 'viewer' | null = null;
  private partnerId: string = '';

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
        // In auto-accept mode, respond to password challenge
      });

      // Handle password verification request
      this.socket.on('password-verify', async (data: any) => {
        console.log('[Conn] Password verification request');
        const isValid = await this.verifyPassword(data.passwordHash, data.nonce);
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
      this.socket.on('session-ended', (data: any) => {
        this.disconnect();
        showToast('Phiên kết nối đã kết thúc', 'info');
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
      this.setupAsViewer(partnerId, mode);
    });

    this.socket.once('connect-rejected', () => {
      showToast('Mật khẩu không đúng', 'error');
    });

    this.socket.once('connect-error', (data: any) => {
      showToast(data.error || 'Lỗi kết nối', 'error');
    });
  }

  // === Setup as HOST (being controlled) ===

  private async setupAsHost(viewerId: string): Promise<void> {
    console.log('[Conn] Setting up as HOST');
    this.role = 'host';
    this.partnerId = viewerId;

    this.peer = new PeerConnection({
      onDataMessage: (channel, data) => {
        if (channel === CHANNEL_INPUT) {
          // Forward input to main process for simulation
          window.titanAPI?.input?.simulate(data);
        } else if (channel === CHANNEL_CHAT) {
          addChatMessage(data.text, 'received');
        } else if (channel === CHANNEL_SYSTEM) {
          this.handleSystemMessage(data);
        }
      },
      onStateChange: (state) => {
        console.log('[Conn] Host peer state:', state);
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
      const sources = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: {
          width: { max: 1920 },
          height: { max: 1080 },
          frameRate: { max: 30 },
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
        } else if (channel === CHANNEL_SYSTEM) {
          this.handleSystemMessage(data);
        }
      },
      onStateChange: (state) => {
        console.log('[Conn] Viewer peer state:', state);
        if (state === 'connected') {
          showToast('Kết nối thành công!', 'success');
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

  private async verifyPassword(hash: string, nonce: string): Promise<boolean> {
    try {
      if (window.titanAPI?.identity) {
        return await (window as any).titanAPI.identity.verifyPassword?.(hash, nonce) ?? false;
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

  // === Quality Control ===

  /**
   * Viewer-side: request a different quality preset from the host.
   * The host re-applies sender params + capture constraints.
   */
  requestQuality(preset: QualityPreset): boolean {
    if (this.role !== 'viewer') return false;
    this.currentQuality = preset;
    return this.peer?.send(CHANNEL_SYSTEM, {
      type: 'system',
      action: 'quality',
      data: { preset },
    }) ?? false;
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
          this.peer?.applyQualityProfile(preset);
        }
        break;

      case 'clipboard':
        this.handleClipboardMessage(msg.data);
        break;
    }
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
          // Simulate Ctrl+V on the host
          await window.titanAPI?.input?.simulate({ type: 'key', action: 'down', key: 'Control', code: 'ControlLeft', modifiers: ['ctrl'] });
          await window.titanAPI?.input?.simulate({ type: 'key', action: 'down', key: 'v', code: 'KeyV', modifiers: ['ctrl'] });
          await window.titanAPI?.input?.simulate({ type: 'key', action: 'up', key: 'v', code: 'KeyV', modifiers: ['ctrl'] });
          await window.titanAPI?.input?.simulate({ type: 'key', action: 'up', key: 'Control', code: 'ControlLeft', modifiers: [] });
        } catch (err) {
          console.error('[Conn] Clipboard paste on host failed:', err);
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
          console.log('[Conn] Clipboard received from host:', data.text.length, 'chars');
        } catch (err) {
          console.error('[Conn] Failed to write to local clipboard:', err);
        }
      }
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

  // === Disconnect ===

  disconnect(): void {
    this.inputHandler?.disable();
    this.peer?.close();
    this.peer = null;
    this.inputHandler = null;
    this.role = null;
    this.partnerId = '';
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
}
