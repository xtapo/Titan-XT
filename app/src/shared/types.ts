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

/**
 * A pinned/saved machine in the user's address book ("Máy của tôi").
 * Lets users 1-click connect without retyping ID/password every time.
 */
export interface AddressBookEntry {
  /** Unique entry id (uuid-ish, generated client-side). */
  id: string;
  /** Friendly display name set by the user. */
  alias: string;
  /** 9-digit machine id of the partner. */
  machineId: string;
  /**
   * Saved password. Optional — when empty the user is prompted at connect time.
   * Stored locally only; never sent to the signal server.
   */
  password?: string;
  /** Optional group/folder name (e.g. "Khách hàng", "Văn phòng"). */
  group?: string;
  /** Free-form tags / labels. */
  tags?: string[];
  /** Optional notes (location, owner, etc.). */
  notes?: string;
  /** Default connect mode for 1-click. */
  defaultMode?: 'control' | 'view';
  /** Pinned to the top of the list. */
  favorite?: boolean;
  /** Created-at timestamp. */
  createdAt: number;
  /** Last successful connect via this entry. */
  lastConnectedAt?: number;
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
  /**
   * Absolute folder path where received files are saved.
   * Empty string falls back to <Downloads>/Titan-XT.
   */
  downloadFolder: string;
  /**
   * When true, prompt the user with a Save As dialog for every incoming file.
   * When false, save silently to downloadFolder.
   */
  askBeforeSave: boolean;
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
