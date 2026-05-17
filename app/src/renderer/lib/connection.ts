/**
 * Connection Manager — Handles Socket.io signaling and WebRTC lifecycle
 */

import { io, Socket } from 'socket.io-client';
import { PeerConnection } from './webrtc';
import { InputHandler } from './input-handler';
import { addChatMessage } from '../pages/session';
import { showToast } from '../components/toast';
import { CHANNEL_INPUT, CHANNEL_CHAT, CHANNEL_SYSTEM, DEFAULT_SIGNAL_SERVER, HEARTBEAT_INTERVAL } from '../../shared/constants';

export class ConnectionManager {
  private socket: Socket | null = null;
  private peer: PeerConnection | null = null;
  private inputHandler: InputHandler | null = null;
  private heartbeatTimer: number | null = null;
  private serverUrl: string;
  private machineId: string = '';
  private machineName: string = '';

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
    this.socket.once('connect-challenge', (data: any) => {
      // Hash password with nonce
      const hash = this.hashPassword(password, data.nonce);
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

    this.peer = new PeerConnection({
      onDataMessage: (channel, data) => {
        if (channel === CHANNEL_INPUT) {
          // Forward input to main process for simulation
          window.titanAPI?.input?.simulate(data);
        } else if (channel === CHANNEL_CHAT) {
          addChatMessage(data.text, 'received');
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
      // Get screen sources using Electron's desktopCapturer
      const sources = await (navigator.mediaDevices as any).getDisplayMedia({
        audio: false,
        video: {
          displaySurface: 'monitor',
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
        if (latencyEl) latencyEl.textContent = `${stats.latency}ms`;
        if (fpsEl) fpsEl.textContent = `${stats.fps}fps`;
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

  private hashPassword(password: string, nonce: string): string {
    // Simple hash for browser (in production use SubtleCrypto)
    let hash = 0;
    const str = password + nonce;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
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

  sendChat(text: string): void {
    if (!this.peer) return;
    this.peer.send(CHANNEL_CHAT, {
      type: 'chat',
      text,
      sender: this.machineName,
      timestamp: Date.now(),
    });
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
