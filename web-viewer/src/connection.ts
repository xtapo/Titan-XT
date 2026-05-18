/**
 * ConnectionManager — viewer-side socket.io + WebRTC orchestration.
 *
 * Mirrors the desktop app's connectToPartner() flow:
 *   1. register on signal server with a random web-viewer machineId
 *   2. emit connect-request → wait for connect-challenge (nonce)
 *   3. SHA-256(password + nonce) → emit password-verify
 *   4. on connect-accepted, host's offer + ICE arrives via 'signal'
 *
 * The web viewer never plays the host role, so the host-side code paths
 * (setupAsHost, screen capture, file save, wallpaper, annotation overlay)
 * are stripped.
 */

import { io, Socket } from 'socket.io-client';
import { PeerConnection, PeerStats, ConnectionState } from './webrtc';
import { CHANNEL_INPUT, CHANNEL_SYSTEM, HEARTBEAT_INTERVAL, SIGNAL_SERVER, QualityPreset } from './constants';
import { sha256Hex } from './sha256';

export interface ConnectionEvents {
  onState: (state: ConnectionState) => void;
  onStream: (stream: MediaStream) => void;
  onStats: (stats: PeerStats) => void;
  onError: (msg: string) => void;
  onChat: (text: string, sender: string) => void;
  onDisconnect: (reason: string) => void;
}

export class ConnectionManager {
  private socket: Socket | null = null;
  private peer: PeerConnection | null = null;
  private heartbeatTimer: number | null = null;
  private machineId: string;
  private machineName: string;
  private partnerId: string = '';
  private events: ConnectionEvents;
  // Browsers can't generate a stable hardware-fingerprinted id, so we use a
  // random per-tab id with a 'web-' prefix. The server only cares that the id
  // is unique within the registry; the host UI gets the prefix as a hint.
  private static genWebId(): string {
    const n = Math.floor(Math.random() * 1_000_000_000);
    return `web${n.toString().padStart(6, '0')}`;
  }

  constructor(events: ConnectionEvents, machineName: string) {
    this.events = events;
    this.machineId = ConnectionManager.genWebId();
    this.machineName = machineName || 'Mobile Viewer';
  }

  get viewerId(): string {
    return this.machineId;
  }

  async connectToServer(serverUrl?: string): Promise<boolean> {
    const url = serverUrl || SIGNAL_SERVER;
    return new Promise((resolve) => {
      this.socket = io(url, {
        transports: ['websocket', 'polling'],
        timeout: 10_000,
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 3_000,
      });

      this.socket.on('connect', () => {
        this.socket!.emit('register', {
          machineId: this.machineId,
          machineName: this.machineName,
        });
        this.startHeartbeat();
        resolve(true);
      });

      this.socket.on('connect_error', (err) => {
        console.error('[Conn] server connect error:', err.message);
        this.events.onError('Không kết nối được signal server');
        resolve(false);
      });

      this.socket.on('signal', (msg: any) => this.handleSignal(msg));

      this.socket.on('session-ended', () => {
        // Echo of our own disconnect or peer left — surface once, then idle.
        if (!this.peer) return;
        this.events.onDisconnect('Phiên kết nối đã kết thúc');
        this.teardownPeer();
      });

      this.socket.on('disconnect', () => this.stopHeartbeat());
    });
  }

  async connectToPartner(partnerId: string, password: string): Promise<void> {
    if (!this.socket?.connected) {
      this.events.onError('Chưa kết nối server');
      return;
    }

    this.partnerId = partnerId;
    this.setupPeer(partnerId);

    this.socket.emit('connect-request', {
      fromId: this.machineId,
      toId: partnerId,
      fromName: this.machineName,
      mode: 'control',
    });

    this.socket.once('connect-challenge', async (data: any) => {
      const hash = await sha256Hex(password + data.nonce);
      this.socket!.emit('password-verify', {
        toId: partnerId,
        passwordHash: hash,
        nonce: data.nonce,
      });
    });

    this.socket.once('connect-accepted', () => {
      // Peer is wired up — host's offer arrives via 'signal' next.
    });

    this.socket.once('connect-rejected', () => {
      this.events.onError('Mật khẩu không đúng');
      this.teardownPeer();
    });

    this.socket.once('connect-error', (data: any) => {
      this.events.onError(data?.error || 'Lỗi kết nối');
      this.teardownPeer();
    });
  }

  private setupPeer(hostId: string) {
    this.peer = new PeerConnection({
      onRemoteStream: (stream) => this.events.onStream(stream),
      onStateChange: (state) => this.events.onState(state),
      onStatsUpdate: (stats) => this.events.onStats(stats),
      onDataMessage: (channel, data) => {
        if (channel === 'chat') {
          this.events.onChat(data?.text || '', data?.sender || 'Host');
        }
      },
      onChannelOpen: (channel) => {
        if (channel === CHANNEL_SYSTEM) {
          // Mirror the desktop viewer: ask the host for its monitor list as
          // soon as system channel opens. The web viewer doesn't render a
          // monitor picker (yet) but this avoids confusing the host.
          this.peer?.send(CHANNEL_SYSTEM, {
            type: 'system',
            action: 'request-monitors',
            data: {},
          });
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
  }

  private async handleSignal(msg: any): Promise<void> {
    if (!this.peer) return;
    if (msg.type === 'offer') {
      const answer = await this.peer.handleOffer(msg.data);
      this.socket?.emit('signal', { type: 'answer', to: msg.from, data: answer });
    } else if (msg.type === 'ice-candidate') {
      await this.peer.addIceCandidate(msg.data);
    }
  }

  /**
   * Send a mouse / keyboard event to the host on the input data channel.
   * Returns false when the channel hasn't opened yet — caller can drop or
   * retry; we don't queue input because stale events feel worse than missed.
   */
  sendInput(msg: any): boolean {
    return this.peer?.send(CHANNEL_INPUT, msg) ?? false;
  }

  /** Ask the host to switch quality preset. Identical wire format to desktop. */
  requestQuality(preset: QualityPreset): boolean {
    return (
      this.peer?.send(CHANNEL_SYSTEM, {
        type: 'system',
        action: 'quality',
        data: {
          preset,
          // Prefer sharp text over smooth motion on mobile.
          // The host's default is 'maintain-framerate' (drop resolution
          // first), tuned for desktop where 30fps cursor matters more than
          // pixel sharpness. On a phone the user is mostly reading/clicking
          // — they want crisp text and don't notice 15fps. The desktop app
          // ignores fields it doesn't understand, so this is forwards-safe.
          degradationPreference: 'maintain-resolution',
          source: 'mobile',
        },
      }) ?? false
    );
  }

  sendChat(text: string): boolean {
    return (
      this.peer?.send('chat', {
        type: 'chat',
        text,
        sender: this.machineName,
        timestamp: Date.now(),
      }) ?? false
    );
  }

  /**
   * User-initiated tear down. Tells the partner via data channel + signal
   * server, mirroring the desktop disconnect flow.
   */
  disconnect(): void {
    try {
      this.peer?.send(CHANNEL_SYSTEM, { type: 'system', action: 'peer-bye' });
    } catch {
      // best effort
    }
    if (this.partnerId && this.socket?.connected) {
      this.socket.emit('peer-disconnect', { toId: this.partnerId });
    }
    this.teardownPeer();
  }

  private teardownPeer() {
    this.peer?.close();
    this.peer = null;
    this.partnerId = '';
  }

  disconnectAll(): void {
    this.disconnect();
    this.stopHeartbeat();
    this.socket?.disconnect();
    this.socket = null;
  }

  private startHeartbeat() {
    this.heartbeatTimer = window.setInterval(() => {
      this.socket?.emit('ping');
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
