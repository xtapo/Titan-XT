// === Data Channel Protocol Types ===

// --- Mouse Events ---
export interface MouseMessage {
  type: 'mouse';
  action: 'move' | 'down' | 'up' | 'click' | 'dblclick' | 'contextmenu' | 'scroll';
  /** X coordinate as ratio 0-1 of screen width */
  x: number;
  /** Y coordinate as ratio 0-1 of screen height */
  y: number;
  button?: 'left' | 'right' | 'middle';
  deltaX?: number;
  deltaY?: number;
}

// --- Keyboard Events ---
export interface KeyMessage {
  type: 'key';
  action: 'down' | 'up';
  /** Key value (e.g. 'a', 'Enter', 'Escape') */
  key: string;
  /** Physical key code (e.g. 'KeyA', 'Enter') */
  code: string;
  modifiers: ('ctrl' | 'alt' | 'shift' | 'meta')[];
}

// --- Chat Messages ---
export interface ChatMessage {
  type: 'chat';
  text: string;
  sender: string;
  timestamp: number;
}

// --- File Transfer ---
export interface FileOfferMessage {
  type: 'file';
  action: 'offer';
  fileId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
}

export interface FileResponseMessage {
  type: 'file';
  action: 'accept' | 'reject';
  fileId: string;
}

export interface FileChunkMessage {
  type: 'file';
  action: 'chunk';
  fileId: string;
  chunkIndex: number;
  totalChunks: number;
  data: string; // base64 encoded chunk
}

export interface FileCompleteMessage {
  type: 'file';
  action: 'complete';
  fileId: string;
}

export interface FileErrorMessage {
  type: 'file';
  action: 'error';
  fileId: string;
  error: string;
}

export type FileMessage =
  | FileOfferMessage
  | FileResponseMessage
  | FileChunkMessage
  | FileCompleteMessage
  | FileErrorMessage;

// --- System Messages ---
export type RemoteActionId =
  | 'ctrl-alt-del'
  | 'lock'
  | 'signout'
  | 'restart'
  | 'shutdown'
  | 'task-manager'
  | 'hide-wallpaper'
  | 'restore-wallpaper';

export interface SystemMessage {
  type: 'system';
  action:
    | 'resolution'
    | 'monitors'
    | 'clipboard'
    | 'ping'
    | 'pong'
    | 'quality'
    | 'remote-action'
    | 'remote-action-result'
    | 'mode-change'
    | 'control-lock'
    | 'switch-monitor'
    | 'monitor-list';
  data: any;
}

export type ViewerMode = 'control' | 'view';

// --- Union Type ---
export type DataChannelMessage =
  | MouseMessage
  | KeyMessage
  | ChatMessage
  | FileMessage
  | SystemMessage;
