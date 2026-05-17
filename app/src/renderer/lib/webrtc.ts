/**
 * WebRTC — Peer connection wrapper for screen streaming & data channels
 */

import { ICE_SERVERS, CHANNEL_INPUT, CHANNEL_CHAT, CHANNEL_FILE, CHANNEL_SYSTEM } from '../../shared/constants';

export type ConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface PeerCallbacks {
  onRemoteStream?: (stream: MediaStream) => void;
  onDataMessage?: (channel: string, data: any) => void;
  onStateChange?: (state: ConnectionState) => void;
  onStatsUpdate?: (stats: { latency: number; fps: number }) => void;
}

export class PeerConnection {
  private pc: RTCPeerConnection;
  private dataChannels: Map<string, RTCDataChannel> = new Map();
  private callbacks: PeerCallbacks;
  private statsInterval: number | null = null;

  constructor(callbacks: PeerCallbacks) {
    this.callbacks = callbacks;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.setupPeerEvents();
  }

  private setupPeerEvents() {
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.onIceCandidate?.(e.candidate);
      }
    };

    this.pc.ontrack = (e) => {
      if (e.streams[0]) {
        this.callbacks.onRemoteStream?.(e.streams[0]);
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState as ConnectionState;
      this.callbacks.onStateChange?.(state);

      if (state === 'connected') {
        this.startStatsMonitor();
      } else if (state === 'disconnected' || state === 'failed') {
        this.stopStatsMonitor();
      }
    };

    this.pc.ondatachannel = (e) => {
      this.setupDataChannel(e.channel);
    };
  }

  // === ICE Candidate callback (set by connection manager) ===
  public onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null;

  // === Offer/Answer ===

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    // Create data channels before offer
    this.createDataChannels();

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  // === Stream ===

  addStream(stream: MediaStream): void {
    stream.getTracks().forEach((track) => {
      this.pc.addTrack(track, stream);
    });
  }

  // === Data Channels ===

  private createDataChannels(): void {
    const channels = [
      { name: CHANNEL_INPUT, ordered: false, maxRetransmits: 0 },  // Low latency
      { name: CHANNEL_CHAT, ordered: true },                       // Reliable
      { name: CHANNEL_FILE, ordered: true },                       // Reliable
      { name: CHANNEL_SYSTEM, ordered: true },                     // Reliable
    ];

    channels.forEach(({ name, ordered, maxRetransmits }) => {
      const opts: RTCDataChannelInit = { ordered };
      if (maxRetransmits !== undefined) opts.maxRetransmits = maxRetransmits;
      const ch = this.pc.createDataChannel(name, opts);
      this.setupDataChannel(ch);
    });
  }

  private setupDataChannel(channel: RTCDataChannel): void {
    this.dataChannels.set(channel.label, channel);

    channel.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        this.callbacks.onDataMessage?.(channel.label, data);
      } catch {
        // Binary data or unparseable
        this.callbacks.onDataMessage?.(channel.label, e.data);
      }
    };

    channel.onopen = () => {
      console.log(`[WebRTC] Channel open: ${channel.label}`);
    };

    channel.onclose = () => {
      console.log(`[WebRTC] Channel closed: ${channel.label}`);
    };
  }

  /**
   * Send data through a specific channel
   */
  send(channelName: string, data: any): boolean {
    const ch = this.dataChannels.get(channelName);
    if (!ch || ch.readyState !== 'open') return false;

    try {
      ch.send(typeof data === 'string' ? data : JSON.stringify(data));
      return true;
    } catch (e) {
      console.error(`[WebRTC] Send error on ${channelName}:`, e);
      return false;
    }
  }

  // === Stats Monitor ===

  private startStatsMonitor(): void {
    this.statsInterval = window.setInterval(async () => {
      try {
        const stats = await this.pc.getStats();
        let latency = 0;
        let fps = 0;

        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            latency = report.currentRoundTripTime ? Math.round(report.currentRoundTripTime * 1000) : 0;
          }
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            fps = report.framesPerSecond || 0;
          }
        });

        this.callbacks.onStatsUpdate?.({ latency, fps: Math.round(fps) });
      } catch {
        // ignore
      }
    }, 2000);
  }

  private stopStatsMonitor(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  // === Cleanup ===

  close(): void {
    this.stopStatsMonitor();
    this.dataChannels.forEach((ch) => ch.close());
    this.dataChannels.clear();
    this.pc.close();
  }

  get connectionState(): string {
    return this.pc.connectionState;
  }
}
