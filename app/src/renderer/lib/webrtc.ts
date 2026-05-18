/**
 * WebRTC — Peer connection wrapper for screen streaming & data channels
 */

import {
  ICE_SERVERS,
  CHANNEL_INPUT,
  CHANNEL_CHAT,
  CHANNEL_FILE,
  CHANNEL_SYSTEM,
  CHANNEL_ANNOTATION,
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
  onStatsUpdate?: (stats: PeerStats) => void;
  onChannelOpen?: (channel: string) => void;
}

export interface PeerStats {
  latency: number; // ms RTT
  fps: number;
  bitrate: number; // bits/sec
  packetLoss: number; // 0-1 fraction
  jitter: number; // ms
}

export class PeerConnection {
  private pc: RTCPeerConnection;
  private dataChannels: Map<string, RTCDataChannel> = new Map();
  private callbacks: PeerCallbacks;
  private statsInterval: number | null = null;
  // Buffer ICE candidates that arrive before setRemoteDescription completes.
  // Calling addIceCandidate before remote description is set throws
  // InvalidStateError on Chromium, which silently kills the connection.
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet: boolean = false;

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
      // Tell Chromium to minimize the jitter buffer on the receiver side.
      // Default playout buffer is tuned for video calls (smoother but ~200ms+
      // of added latency). For screen share we'd rather see frames the moment
      // they arrive — this is what shaves the visible "input → screen" delay
      // closer to the network RTT.
      try {
        const receiver: any = e.receiver;
        if (receiver && 'playoutDelayHint' in receiver) {
          receiver.playoutDelayHint = 0;
        }
        if (receiver && 'jitterBufferTarget' in receiver) {
          receiver.jitterBufferTarget = 0;
        }
      } catch {
        // Hint not supported on this Chromium build — ignore
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
    if (offer.sdp) offer.sdp = this.tuneSdp(offer.sdp);
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    this.remoteDescriptionSet = true;
    await this.flushPendingIce();
    const answer = await this.pc.createAnswer();
    if (answer.sdp) answer.sdp = this.tuneSdp(answer.sdp);
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  /**
   * Patch the SDP to bias Chromium toward an aggressive initial bitrate.
   *
   * `x-google-start-bitrate` and friends aren't exposed through setParameters
   * and the default values cap the encoder at ~300kbps for the first few
   * seconds — visible as a blurry mush right after connect. Forcing them
   * higher lets the screen come up sharp from the first frame.
   *
   * Also sets `level-asymmetry-allowed` for H.264 so both peers can pick
   * the best level independently.
   */
  private tuneSdp(sdp: string): string {
    try {
      const startKbps = Math.round(VIDEO_START_BITRATE / 1000);
      const minKbps = Math.round(VIDEO_START_BITRATE / 2000);
      const maxKbps = Math.round(VIDEO_MAX_BITRATE / 1000);

      // Inject x-google-* fmtp lines into every video codec's fmtp entry,
      // preserving any existing parameters (profile-level-id etc).
      const lines = sdp.split('\r\n');
      const result: string[] = [];
      let inVideoSection = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('m=video')) {
          inVideoSection = true;
        } else if (line.startsWith('m=')) {
          inVideoSection = false;
        }

        if (inVideoSection && line.startsWith('a=fmtp:')) {
          const hasGoogleParams = line.includes('x-google-start-bitrate');
          if (!hasGoogleParams) {
            result.push(
              `${line};x-google-start-bitrate=${startKbps};x-google-min-bitrate=${minKbps};x-google-max-bitrate=${maxKbps}`,
            );
            continue;
          }
        }
        result.push(line);
      }
      return result.join('\r\n');
    } catch (err) {
      console.warn('[WebRTC] SDP tune failed, using original:', err);
      return sdp;
    }
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    this.remoteDescriptionSet = true;
    await this.flushPendingIce();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteDescriptionSet) {
      // Queue until remote description is set; otherwise Chromium throws
      // InvalidStateError and the candidate is lost.
      this.pendingIceCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('[WebRTC] addIceCandidate failed:', err);
    }
  }

  private async flushPendingIce(): Promise<void> {
    if (this.pendingIceCandidates.length === 0) return;
    const queued = this.pendingIceCandidates.splice(0);
    for (const c of queued) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(c));
      } catch (err) {
        console.warn('[WebRTC] flush addIceCandidate failed:', err);
      }
    }
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
   * Swap the video track on the existing sender without re-negotiating.
   *
   * Used when the host changes which monitor is being shared — we keep the
   * same RTCRtpSender (and therefore the same SSRC + DTLS state) and just
   * point it at a fresh capture track. The viewer's `<video>` element keeps
   * playing without a black flash; only the picture changes.
   *
   * The old track is stopped so the OS releases the previous monitor and the
   * encoder doesn't keep two captures alive in parallel.
   */
  async replaceVideoTrack(newStream: MediaStream): Promise<boolean> {
    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) return false;

    try {
      (newTrack as any).contentHint = 'detail';
    } catch {
      // contentHint not supported — ignore
    }

    const videoSender = this.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!videoSender) {
      // No prior sender — fall through to addStream so the first call still works.
      this.addStream(newStream);
      return true;
    }

    const oldTrack = videoSender.track;
    try {
      await videoSender.replaceTrack(newTrack);
    } catch (err) {
      console.error('[WebRTC] replaceTrack failed:', err);
      return false;
    }
    // Stop the previous capture so the OS frees the old monitor's source and
    // we don't end up with two desktopCapturer sessions running in parallel.
    if (oldTrack && oldTrack !== newTrack) {
      try { oldTrack.stop(); } catch { /* ignore */ }
    }
    return true;
  }

  /**
   * Set bitrate caps + initial bitrate on the video sender.
   * Without this, WebRTC starts ~300kbps and ramps slowly — unusable for 1080p screen share.
   *
   * Key tweaks vs default WebRTC:
   *   - networkPriority='high' — video gets priority over data channels on
   *     a congested link, like UltraViewer/AnyDesk reserving bandwidth
   *     for the realtime stream.
   *   - degradationPreference='maintain-framerate' — under congestion
   *     drop resolution/quality first, keep motion smooth (cursor, scroll).
   *     Screen share with stuttery 30→10fps feels worse than blurry 30fps.
   *   - scaleResolutionDownBy=1 — never silently halve the resolution,
   *     we already control res via track constraints in applyQualityProfile.
   */
  private async applyVideoSenderTuning(sender: RTCRtpSender): Promise<void> {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      const enc = params.encodings[0] as any;
      enc.maxBitrate = VIDEO_MAX_BITRATE;
      enc.maxFramerate = 30;
      enc.scaleResolutionDownBy = 1;
      enc.networkPriority = 'high';
      enc.priority = 'high';
      (params as any).degradationPreference = 'maintain-framerate';
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
    // Input is sent as unreliable + unordered with priority='high' so a brief
    // packet drop never stalls cursor/keystrokes — same idea as Parsec/AnyDesk
    // shipping input on a separate prioritized lane from the video stream.
    const channels: Array<{
      name: string;
      ordered: boolean;
      maxRetransmits?: number;
      priority?: RTCPriorityType;
    }> = [
      { name: CHANNEL_INPUT, ordered: false, maxRetransmits: 0, priority: 'high' },
      { name: CHANNEL_CHAT, ordered: true },
      { name: CHANNEL_FILE, ordered: true, priority: 'low' },
      { name: CHANNEL_SYSTEM, ordered: true, priority: 'high' },
      // Annotation: ordered (each stroke must arrive in sequence so the host
      // overlay redraws the right path) but unreliable on point messages —
      // a missing intermediate point shows up as a slight kink, not a
      // permanent gap. Begin/end frames are infrequent enough that natural
      // SCTP retransmits handle them.
      { name: CHANNEL_ANNOTATION, ordered: true, priority: 'medium' },
    ];

    channels.forEach(({ name, ordered, maxRetransmits, priority }) => {
      const opts: RTCDataChannelInit = { ordered };
      if (maxRetransmits !== undefined) opts.maxRetransmits = maxRetransmits;
      if (priority) (opts as any).priority = priority;
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
      this.callbacks.onChannelOpen?.(channel.label);
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
    let lastPacketsLost = 0;
    let lastPacketsReceived = 0;
    this.statsInterval = window.setInterval(async () => {
      try {
        const stats = await this.pc.getStats();
        let latency = 0;
        let fps = 0;
        let bitrate = 0;
        let packetLoss = 0;
        let jitter = 0;

        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            latency = report.currentRoundTripTime ? Math.round(report.currentRoundTripTime * 1000) : 0;
          }
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            fps = report.framesPerSecond || 0;
            jitter = (report.jitter || 0) * 1000; // seconds → ms
            const bytes: number = report.bytesReceived || 0;
            const ts: number = report.timestamp || 0;
            if (lastTimestamp > 0 && ts > lastTimestamp) {
              const seconds = (ts - lastTimestamp) / 1000;
              bitrate = Math.round(((bytes - lastBytes) * 8) / seconds);
            }
            lastBytes = bytes;
            lastTimestamp = ts;

            const lost: number = report.packetsLost || 0;
            const received: number = report.packetsReceived || 0;
            const dLost = lost - lastPacketsLost;
            const dReceived = received - lastPacketsReceived;
            const denom = dLost + dReceived;
            packetLoss = denom > 0 ? Math.max(0, dLost / denom) : 0;
            lastPacketsLost = lost;
            lastPacketsReceived = received;
          }
        });

        this.callbacks.onStatsUpdate?.({
          latency,
          fps: Math.round(fps),
          bitrate,
          packetLoss,
          jitter: Math.round(jitter),
        });
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
