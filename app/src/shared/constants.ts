// === Shared Constants ===

export const APP_NAME = 'Titan-XT';
export const APP_VERSION = '1.0.0';

// Signal server
export const DEFAULT_SIGNAL_SERVER = 'http://152.67.122.105:3456';

// WebRTC ICE servers (typed as any[] for Node.js compat — used in renderer)
export const ICE_SERVERS: any[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

// Screen capture
export const DEFAULT_FPS = 30;
export const DEFAULT_MAX_WIDTH = 1920;
export const DEFAULT_MAX_HEIGHT = 1080;

// Video encoder
export const VIDEO_MAX_BITRATE = 6_000_000; // 6 Mbps — good for 1080p screen share
export const VIDEO_START_BITRATE = 2_500_000;
export const PREFERRED_VIDEO_CODECS = ['video/H264', 'video/VP9', 'video/VP8'];

// Quality presets — viewer picks one, host re-applies sender params + capture constraints
export type QualityPreset = 'high' | 'medium' | 'low';

export interface QualityProfile {
  label: string;
  maxWidth: number;
  maxHeight: number;
  maxBitrate: number; // bits/second
  maxFramerate: number;
}

export const QUALITY_PROFILES: Record<QualityPreset, QualityProfile> = {
  high: {
    label: 'Cao (1080p · 6 Mbps · 30fps)',
    maxWidth: 1920,
    maxHeight: 1080,
    maxBitrate: 6_000_000,
    maxFramerate: 30,
  },
  medium: {
    label: 'Trung bình (720p · 3 Mbps · 30fps)',
    maxWidth: 1280,
    maxHeight: 720,
    maxBitrate: 3_000_000,
    maxFramerate: 30,
  },
  low: {
    label: 'Thấp (540p · 1.5 Mbps · 15fps)',
    maxWidth: 960,
    maxHeight: 540,
    maxBitrate: 1_500_000,
    maxFramerate: 15,
  },
};

export const DEFAULT_QUALITY: QualityPreset = 'high';

// Data channel names
export const CHANNEL_INPUT = 'input';
export const CHANNEL_CHAT = 'chat';
export const CHANNEL_FILE = 'file';
export const CHANNEL_SYSTEM = 'system';

// Connection
export const HEARTBEAT_INTERVAL = 10_000;
export const RECONNECT_DELAY = 3_000;
export const MAX_RECONNECT_ATTEMPTS = 5;
