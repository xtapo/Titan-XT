// === Shared TypeScript Types ===

export interface Identity {
  machineId: string;
  password: string;
  machineName: string;
}

export interface MonitorInfo {
  id: string;
  name: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isPrimary: boolean;
  thumbnail?: string; // base64
}

export interface ConnectionHistory {
  machineId: string;
  machineName: string;
  lastConnected: number;
  totalSessions: number;
}

export interface AppSettings {
  signalServer: string;
  autoStart: boolean;
  minimizeToTray: boolean;
  quality: 'auto' | 'low' | 'medium' | 'high';
  fps: number;
  hideWallpaper: boolean;
  requireManualApproval: boolean;
  allowedIPs: string[];
}

export interface SessionState {
  sessionId: string;
  partnerId: string;
  partnerName: string;
  mode: 'control' | 'view' | 'file';
  status: 'connecting' | 'active' | 'reconnecting' | 'ended';
  startedAt: number;
  latency: number;
  fps: number;
  resolution: { width: number; height: number };
}

export type ConnectionMode = 'internet' | 'lan';

export type AppPage = 'home' | 'session' | 'settings';
