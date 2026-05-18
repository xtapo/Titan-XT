/**
 * Constants ported from app/src/shared/constants.ts.
 *
 * Trimmed to the bits the web viewer actually uses — host-only knobs (capture
 * resolution caps, encoder start bitrate, codec preferences) live on the
 * desktop app and don't apply to a receive-only browser client.
 */

export const SIGNAL_SERVER =
  (import.meta.env.VITE_SIGNAL_SERVER as string | undefined) || 'http://152.67.122.105:3456';

// WebRTC ICE servers — same set as the desktop app.
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

// Data channel names (must match desktop app)
export const CHANNEL_INPUT = 'input';
export const CHANNEL_CHAT = 'chat';
export const CHANNEL_FILE = 'file';
export const CHANNEL_SYSTEM = 'system';
export const CHANNEL_ANNOTATION = 'annotation';

export const HEARTBEAT_INTERVAL = 10_000;

export type QualityPreset = 'max' | 'ultra' | 'high' | 'medium' | 'low' | 'tiny';

// Default to 'high' (1080p) for mobile.
//
// 'medium' (720p) was too soft for sharing IDE / spreadsheet text — letters
// pixelated on the downsample. '1080p' is the sweet spot on a 6"+ phone:
// crisp text without 4K's bandwidth penalty, which on cellular forces the
// encoder to drop bitrate adaptively and the frame turns into mush. If the
// user picks 'max', the host happily encodes 4K but only LAN/wifi can keep
// up — see the "tinh chỉnh chất lượng" tip in the README.
export const DEFAULT_QUALITY: QualityPreset = 'high';

export const QUALITY_LABELS: Record<QualityPreset, string> = {
  max: 'Tối đa (4K)',
  ultra: 'Siêu nét (1440p)',
  high: 'Cao (1080p)',
  medium: 'Trung bình (720p)',
  low: 'Thấp (540p)',
  tiny: 'Rất thấp (480p)',
};
