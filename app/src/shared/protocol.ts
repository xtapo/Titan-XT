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
  /**
   * Hint from sender about where the receiver should save the file.
   * 'desktop' — drop the file straight onto the receiver's OS desktop,
   * bypassing the configured download folder + the "ask before save" dialog.
   * Used by drag-onto-video / drag-onto-host-panel for an UltraViewer-style
   * "drop and it appears on the other side's desktop" workflow.
   */
  targetHint?: 'desktop';
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

// --- Annotation (viewer draws on screen, host shows on desktop) ---
export type AnnotationTool = 'pen' | 'arrow' | 'rect' | 'highlight';

export interface AnnotationStrokeBegin {
  type: 'annotation';
  action: 'begin';
  /** Stroke id assigned by the viewer; receivers key strokes by it. */
  strokeId: string;
  tool: AnnotationTool;
  /** CSS color string. Receiver renders it as-is. */
  color: string;
  /** Line thickness in CSS px at 1080p reference; receiver scales. */
  width: number;
  /** Opening point, normalized 0-1 of source video frame. */
  x: number;
  y: number;
}

export interface AnnotationStrokePoint {
  type: 'annotation';
  action: 'point';
  strokeId: string;
  x: number;
  y: number;
}

export interface AnnotationStrokeEnd {
  type: 'annotation';
  action: 'end';
  strokeId: string;
}

export interface AnnotationClear {
  type: 'annotation';
  action: 'clear';
}

export type AnnotationMessage =
  | AnnotationStrokeBegin
  | AnnotationStrokePoint
  | AnnotationStrokeEnd
  | AnnotationClear;

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
    | 'monitor-list'
    | 'request-monitors';
  data: any;
}

export type ViewerMode = 'control' | 'view';

// --- Union Type ---
export type DataChannelMessage =
  | MouseMessage
  | KeyMessage
  | ChatMessage
  | FileMessage
  | SystemMessage
  | AnnotationMessage;
