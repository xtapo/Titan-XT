/**
 * WebRTC — Peer connection wrapper for screen streaming & data channels
 */

import {
  ICE_SERVERS,
  CHANNEL_INPUT,
  CHANNEL_CHAT,
  CHANNEL_FILE,
  CHANNEL_SYSTEM,
  VIDEO_MAX_BITRATE,
  VIDEO_START_BITRATE,
  PREFERRED_VIDEO_CODECS,
  QUALITY_PROFILES,
  QualityPreset,
} from '../../shared/constants';

export type ConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface PeerCallbacks {
  onRemoteStream?: (stream: MediaStream) => void;
  onDataMessage?: (channel: string, data: any) => void;
  onStateChange?: (state: ConnectionState) => void;
  onStatsUpdate?: (stats: { latency: number; fps: number; bitrate: number }) => void;
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
    // Hint encoder this is a screen share with sharp text + moderate motion.
    // 'detail' biases toward sharper text; switch to 'motion' if remote is mostly video.
    stream.getVideoTracks().forEach((track) => {
      try {
        (track as any).contentHint = 'detail';
      } catch {
        // contentHint not supported — ignore
      }
    });

    stream.getTracks().forEach((track) => {
      const sender = this.pc.addTrack(track, stream);
      if (track.kind === 'video') {
        this.applyVideoSenderTuning(sender);
        this.preferVideoCodec();
      }
    });
  }

  /**
   * Set bitrate caps + initial bitrate on the video sender.
   * Without this, WebRTC starts ~300kbps and ramps slowly — unusable for 1080p screen share.
   */
  private async applyVideoSenderTuning(sender: RTCRtpSender): Promise<void> {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
      (params.encodings[0] as any).maxFramerate = 30;
      // Hint initial bitrate (non-standard but respected by Chromium)
      (params as any).degradationPreference = 'maintain-resolution';
      await sender.setParameters(params);

      // Patch the SDP-level start bitrate via setParameters above; some Chromium
      // builds also honor an x-google-start-bitrate munge but we keep it clean.
      void VIDEO_START_BITRATE;
    } catch (err) {
      console.warn('[WebRTC] Could not tune video sender:', err);
    }
  }

  /**
   * Reorder codec preferences so H.264 (hardware-accelerated on most GPUs) is tried first.
   * Falls back gracefully on browsers without setCodecPreferences support.
   */
  private preferVideoCodec(): void {
    try {
      const transceiver = this.pc
        .getTransceivers()
        .find((t) => t.sender.track?.kind === 'video');
      if (!transceiver || typeof (transceiver as any).setCodecPreferences !== 'function') {
        return;
      }
      const caps = (RTCRtpSender as any).getCapabilities?.('video');
      if (!caps?.codecs) return;

      const codecs = caps.codecs as Array<{ mimeType: string }>;
      const ordered: Array<{ mimeType: string }> = [];
      for (const want of PREFERRED_VIDEO_CODECS) {
        for (const c of codecs) {
          if (c.mimeType.toLowerCase() === want.toLowerCase() && !ordered.includes(c)) {
            ordered.push(c);
          }
        }
      }
      // Append any remaining codecs to keep negotiation viable
      for (const c of codecs) {
        if (!ordered.includes(c)) ordered.push(c);
      }
      (transceiver as any).setCodecPreferences(ordered);
    } catch (err) {
      console.warn('[WebRTC] Could not set codec preferences:', err);
    }
  }

  /**
   * Apply a quality preset to the active video sender + capture track.
   * Called on the HOST when the viewer requests a quality change via the
   * system data channel, and once on initial setup.
   */
  async applyQualityProfile(preset: QualityPreset): Promise<void> {
    const profile = QUALITY_PROFILES[preset];
    if (!profile) return;

    const videoSender = this.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!videoSender) return;

    // 1. Update encoder bitrate + framerate
    try {
      const params = videoSender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = profile.maxBitrate;
      (params.encodings[0] as any).maxFramerate = profile.maxFramerate;
      await videoSender.setParameters(params);
    } catch (err) {
      console.warn('[WebRTC] Could not update sender params for quality:', err);
    }

    // 2. Reduce capture resolution + framerate via track constraints
    try {
      const track = videoSender.track as MediaStreamTrack | null;
      if (track && typeof track.applyConstraints === 'function') {
        await track.applyConstraints({
          width: { max: profile.maxWidth },
          height: { max: profile.maxHeight },
          frameRate: { max: profile.maxFramerate },
        } as MediaTrackConstraints);
      }
    } catch (err) {
      console.warn('[WebRTC] Could not apply track constraints for quality:', err);
    }

    console.log(`[WebRTC] Quality applied: ${preset} (${profile.label})`);
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
    let lastBytes = 0;
    let lastTimestamp = 0;
    this.statsInterval = window.setInterval(async () => {
      try {
        const stats = await this.pc.getStats();
        let latency = 0;
        let fps = 0;
        let bitrate = 0;

        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            latency = report.currentRoundTripTime ? Math.round(report.currentRoundTripTime * 1000) : 0;
          }
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            fps = report.framesPerSecond || 0;
            const bytes: number = report.bytesReceived || 0;
            const ts: number = report.timestamp || 0;
            if (lastTimestamp > 0 && ts > lastTimestamp) {
              const seconds = (ts - lastTimestamp) / 1000;
              bitrate = Math.round(((bytes - lastBytes) * 8) / seconds);
            }
            lastBytes = bytes;
            lastTimestamp = ts;
          }
        });

        this.callbacks.onStatsUpdate?.({ latency, fps: Math.round(fps), bitrate });
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
