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
  /**
   * Mật khẩu dùng cho lần kết nối thành công gần nhất. Lưu cục bộ để
   * auto-fill khi chọn lại từ dropdown "Kết nối gần đây". Không bao giờ
   * gửi lên signal server.
   */
  lastPassword?: string;
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
  /**
   * Unattended access — let viewers connect with a fixed personal password
   * even when no human is at the host to read the rotating 4-char password.
   * Like AnyDesk's Personal Password / TeamViewer's Unattended Access.
   *
   * The plain password is never stored. We keep a salted SHA-256 of it so the
   * host can verify the viewer's challenge response (`SHA-256(password + nonce)`)
   * by recomputing both the rotating-password hash AND the unattended hash and
   * accepting either one.
   */
  unattendedEnabled: boolean;
  /** Salted SHA-256 of the unattended password. Empty when not configured. */
  unattendedPasswordHash: string;
  /** Random per-install salt mixed into the hash to defeat rainbow tables. */
  unattendedPasswordSalt: string;
  /**
   * Auto-launch Titan-XT hidden when Windows starts, so the host is reachable
   * without anyone clicking the icon. Effective only with the unattended flag.
   */
  unattendedAutoStart: boolean;
  /**
   * Append session events to the local audit log. Surfaced in the Settings
   * page. Defaults to true — the host owner usually wants a record of what
   * happened during a remote-support call. Disabling it stops new appends
   * but does not erase existing logs.
   */
  auditEnabled: boolean;
  /**
   * Two-way clipboard sync. When on, both peers watch their local clipboard
   * and push changes to the partner over the system data channel — copying
   * on one side makes the text/image appear on the other without an explicit
   * Ctrl+V or menu action. Off by default for privacy: a casual support
   * session shouldn't leak whatever the user happened to have copied.
   */
  clipboardSyncEnabled: boolean;
  /**
   * When clipboard sync is on, also forward image clipboards (PNG-encoded).
   * Separate flag because image payloads are much larger than text and the
   * user may want text-only sync on metered links.
   */
  clipboardSyncImages: boolean;
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
