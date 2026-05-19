// === Shared Constants ===

export const APP_NAME = 'Titan-XT';
export const APP_VERSION = '1.0.0';

// Signal server
export const DEFAULT_SIGNAL_SERVER = 'https://titan.xtapo.org';

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
// Cap capture at native 4K so the highest preset can deliver a true UHD stream
// without the OS-side downscale that 1920×1080 would force. Lower presets pull
// resolution back down via per-track applyConstraints().
export const DEFAULT_MAX_WIDTH = 3840;
export const DEFAULT_MAX_HEIGHT = 2160;

// Video encoder
// 30 Mbps ceiling — enough headroom for a 4K @ 30fps screen share with motion.
// Lower presets clamp themselves below this via QUALITY_PROFILES.maxBitrate.
export const VIDEO_MAX_BITRATE = 30_000_000;
export const VIDEO_START_BITRATE = 6_000_000;
// Video codec preference — viewer-selectable, applied on the host's sender.
//
// H.264 is the safe default: hardware-decoded on every WebRTC-capable
// device made in the last decade and the encoder ships with every modern
// GPU (NVENC / QuickSync / AMF / VideoToolbox).
//
// H.265 (HEVC) saves ~40% bitrate at the same visual quality — text stays
// sharp on cellular and 4K screen share fits in ~12 Mbps instead of ~25.
// Trade-off: encode is heavier (matters on hosts without a hardware HEVC
// encoder, e.g. older laptops, GPU-less VMs) and not every browser
// negotiates HEVC over WebRTC. Chromium added it in 107+ (so Electron 33
// with Chromium 130 is fine); Safari 13.1+ and iOS 14+ work; older Android
// Chrome may not. We probe support via RTCRtpReceiver.getCapabilities at
// runtime and disable the toggle when unavailable.
//
// AV1 (royalty-free, ~50% better than H.264 / ~20% better than HEVC at the
// same quality) is excellent for screen share text. Software encode is too
// slow for 1080p60 unless the host has hardware AV1 (Intel Arc, NVIDIA 40-series,
// AMD 7000-series); we still expose the toggle and let the codec probe gate it.
// VP9 is the older royalty-free fallback — universally available in Chromium
// and a sensible middle-ground when H.265 isn't available but the link wants
// better-than-H.264 efficiency.
export type VideoCodec = 'h264' | 'h265' | 'av1' | 'vp9';

export const DEFAULT_CODEC: VideoCodec = 'h264';

export const CODEC_LABELS: Record<VideoCodec, string> = {
  h264: 'H.264 (tương thích cao)',
  h265: 'H.265 / HEVC (giảm ~40% bitrate)',
  av1: 'AV1 (chất lượng cao nhất, cần GPU mới)',
  vp9: 'VP9 (cân bằng, tương thích rộng)',
};

// Codec ordering passed to setCodecPreferences. Order matters — the first
// codec the *answerer* also supports wins. Whatever the user picks goes
// first; the others stay as fallbacks so the negotiation still succeeds
// when the peer can't decode the preferred one.
export const PREFERRED_VIDEO_CODECS_BY_PREF: Record<VideoCodec, string[]> = {
  h264: ['video/H264', 'video/VP9', 'video/VP8', 'video/H265', 'video/AV1'],
  h265: ['video/H265', 'video/H264', 'video/VP9', 'video/VP8', 'video/AV1'],
  av1: ['video/AV1', 'video/VP9', 'video/H265', 'video/H264', 'video/VP8'],
  vp9: ['video/VP9', 'video/H264', 'video/H265', 'video/AV1', 'video/VP8'],
};

// Legacy export — keeps existing call-sites working until they thread the
// per-session preference through. Equivalent to PREFERRED_VIDEO_CODECS_BY_PREF.h264.
export const PREFERRED_VIDEO_CODECS = PREFERRED_VIDEO_CODECS_BY_PREF[DEFAULT_CODEC];

// Adaptive quality thresholds — viewer-side auto-downgrade when the network
// degrades (high RTT or packet loss). Tuned for screen share, not video chat.
export const ADAPTIVE_RTT_DOWNGRADE_MS = 250; // sustained RTT above this → drop a tier
export const ADAPTIVE_RTT_UPGRADE_MS = 90;    // RTT below this for a while → climb back up
export const ADAPTIVE_LOSS_DOWNGRADE = 0.04;  // 4% packet loss → drop a tier
export const ADAPTIVE_SAMPLE_INTERVAL_MS = 2_000;
export const ADAPTIVE_DEBOUNCE_SAMPLES = 3;   // require N consecutive samples before changing tier

// Quality presets — viewer picks one, host re-applies sender params + capture constraints
export type QualityPreset = 'max' | 'ultra' | 'responsive' | 'high' | 'medium' | 'low' | 'tiny';

export interface QualityProfile {
  label: string;
  maxWidth: number;
  maxHeight: number;
  maxBitrate: number; // bits/second
  maxFramerate: number;
}

export const QUALITY_PROFILES: Record<QualityPreset, QualityProfile> = {
  max: {
    label: 'Tối đa (4K · 25 Mbps · 30fps)',
    maxWidth: 3840,
    maxHeight: 2160,
    maxBitrate: 25_000_000,
    maxFramerate: 30,
  },
  ultra: {
    label: 'Siêu nét (1440p · 12 Mbps · 30fps)',
    maxWidth: 2560,
    maxHeight: 1440,
    maxBitrate: 12_000_000,
    maxFramerate: 30,
  },
  responsive: {
    label: 'Mượt (1080p · 10 Mbps · 60fps)',
    maxWidth: 1920,
    maxHeight: 1080,
    maxBitrate: 10_000_000,
    maxFramerate: 60,
  },
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
  tiny: {
    label: 'Rất thấp (480p · 300 kbps · 15fps)',
    maxWidth: 854,
    maxHeight: 480,
    maxBitrate: 300_000,
    maxFramerate: 15,
  },
};

export const DEFAULT_QUALITY: QualityPreset = 'high';

// Data channel names
export const CHANNEL_INPUT = 'input';
export const CHANNEL_CHAT = 'chat';
export const CHANNEL_FILE = 'file';
export const CHANNEL_SYSTEM = 'system';
// Annotation channel — viewer draws on a canvas overlay over the remote video
// and strokes are mirrored on the host's actual desktop via a transparent
// click-through window. Separate channel so high-volume mousemove-during-draw
// can't starve chat / file / system traffic.
export const CHANNEL_ANNOTATION = 'annotation';

// Annotation
// Strokes auto-fade after this long so leftover marks don't clutter the host's
// screen forever. Reset on every new point so an actively-being-drawn stroke
// doesn't disappear under the user.
export const ANNOTATION_FADE_MS = 6_000;
// Cap how often we relay mousemove during an active stroke. WebRTC data
// channels handle thousands of msg/sec but we don't need pixel-perfect
// fidelity — 60Hz feels live and keeps the channel quiet.
export const ANNOTATION_POINT_THROTTLE_MS = 16;

// Connection
export const HEARTBEAT_INTERVAL = 10_000;
export const RECONNECT_DELAY = 3_000;
export const MAX_RECONNECT_ATTEMPTS = 5;
