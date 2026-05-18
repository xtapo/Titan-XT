/**
 * PeerConnection — viewer-only WebRTC wrapper for the web client.
 *
 * Slimmer than app/src/renderer/lib/webrtc.ts:
 *   - never originates an offer (host always offers, viewer answers)
 *   - never adds local tracks (no screen capture in browser)
 *   - never creates data channels (host creates them, viewer receives)
 *
 * What's preserved:
 *   - playoutDelayHint=0 / jitterBufferTarget=0 to minimize visible lag
 *     for screen share (the desktop app does the same — see webrtc.ts:65-77)
 *   - ICE candidate buffering until setRemoteDescription resolves;
 *     calling addIceCandidate too early throws InvalidStateError on Chromium
 *     and silently kills the connection
 */

import { ICE_SERVERS } from './constants';

export type ConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed';

export interface PeerStats {
  latency: number;
  fps: number;
  bitrate: number;
  packetLoss: number;
  jitter: number;
}

export interface PeerCallbacks {
  onRemoteStream?: (stream: MediaStream) => void;
  onDataMessage?: (channel: string, data: any) => void;
  onStateChange?: (state: ConnectionState) => void;
  onStatsUpdate?: (stats: PeerStats) => void;
  onChannelOpen?: (channel: string) => void;
}

export class PeerConnection {
  private pc: RTCPeerConnection;
  private dataChannels = new Map<string, RTCDataChannel>();
  private callbacks: PeerCallbacks;
  private statsInterval: number | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteSet = false;

  public onIceCandidate: ((c: RTCIceCandidate) => void) | null = null;

  constructor(callbacks: PeerCallbacks) {
    this.callbacks = callbacks;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.wireEvents();
  }

  private wireEvents() {
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.onIceCandidate?.(e.candidate);
    };

    this.pc.ontrack = (e) => {
      if (e.streams[0]) this.callbacks.onRemoteStream?.(e.streams[0]);
      // Tell Chromium to minimize the receiver-side jitter buffer so input-to-screen
      // latency stays close to RTT instead of inheriting video-call defaults.
      try {
        const r = e.receiver as any;
        if (r && 'playoutDelayHint' in r) r.playoutDelayHint = 0;
        if (r && 'jitterBufferTarget' in r) r.jitterBufferTarget = 0;
      } catch {
        // older Chromium / non-Chromium browsers — best effort
      }
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState as ConnectionState;
      this.callbacks.onStateChange?.(s);
      if (s === 'connected') this.startStats();
      else if (s === 'disconnected' || s === 'failed') this.stopStats();
    };

    this.pc.ondatachannel = (e) => this.attachChannel(e.channel);
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    this.remoteSet = true;
    await this.flushIce();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async addIceCandidate(c: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteSet) {
      this.pendingIce.push(c);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(c));
    } catch (err) {
      console.warn('[WebRTC] addIceCandidate failed:', err);
    }
  }

  private async flushIce(): Promise<void> {
    if (!this.pendingIce.length) return;
    const queued = this.pendingIce.splice(0);
    for (const c of queued) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(c));
      } catch (err) {
        console.warn('[WebRTC] flush addIceCandidate failed:', err);
      }
    }
  }

  private attachChannel(ch: RTCDataChannel) {
    this.dataChannels.set(ch.label, ch);
    ch.onmessage = (e) => {
      try {
        this.callbacks.onDataMessage?.(ch.label, JSON.parse(e.data));
      } catch {
        this.callbacks.onDataMessage?.(ch.label, e.data);
      }
    };
    ch.onopen = () => this.callbacks.onChannelOpen?.(ch.label);
    ch.onclose = () => {
      // channel closed — nothing else to do, peer state will follow
    };
  }

  send(channel: string, data: any): boolean {
    const ch = this.dataChannels.get(channel);
    if (!ch || ch.readyState !== 'open') return false;
    try {
      ch.send(typeof data === 'string' ? data : JSON.stringify(data));
      return true;
    } catch (err) {
      console.error(`[WebRTC] send(${channel}) failed:`, err);
      return false;
    }
  }

  private startStats() {
    let lastBytes = 0;
    let lastTs = 0;
    let lastLost = 0;
    let lastReceived = 0;
    this.statsInterval = window.setInterval(async () => {
      try {
        const stats = await this.pc.getStats();
        let latency = 0,
          fps = 0,
          bitrate = 0,
          packetLoss = 0,
          jitter = 0;
        stats.forEach((report: any) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            latency = report.currentRoundTripTime
              ? Math.round(report.currentRoundTripTime * 1000)
              : 0;
          }
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            fps = report.framesPerSecond || 0;
            jitter = (report.jitter || 0) * 1000;
            const bytes: number = report.bytesReceived || 0;
            const ts: number = report.timestamp || 0;
            if (lastTs > 0 && ts > lastTs) {
              const seconds = (ts - lastTs) / 1000;
              bitrate = Math.round(((bytes - lastBytes) * 8) / seconds);
            }
            lastBytes = bytes;
            lastTs = ts;
            const lost: number = report.packetsLost || 0;
            const recv: number = report.packetsReceived || 0;
            const dLost = lost - lastLost;
            const dRecv = recv - lastReceived;
            const denom = dLost + dRecv;
            packetLoss = denom > 0 ? Math.max(0, dLost / denom) : 0;
            lastLost = lost;
            lastReceived = recv;
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

  private stopStats() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  close() {
    this.stopStats();
    this.dataChannels.forEach((c) => c.close());
    this.dataChannels.clear();
    this.pc.close();
  }

  get connectionState(): string {
    return this.pc.connectionState;
  }
}
