/**
 * Wire-protocol types — the subset the viewer needs.
 *
 * The full protocol lives in app/src/shared/protocol.ts on the desktop side.
 * We re-declare the messages this client actually emits or consumes so the
 * web viewer stays decoupled from the Electron tsconfig.
 */

export interface MouseMessage {
  type: 'mouse';
  action: 'move' | 'down' | 'up' | 'click' | 'dblclick' | 'contextmenu' | 'scroll';
  /** 0-1 ratio of remote screen */
  x: number;
  y: number;
  button?: 'left' | 'right' | 'middle';
  deltaX?: number;
  deltaY?: number;
}

export interface KeyMessage {
  type: 'key';
  action: 'down' | 'up';
  key: string;
  code: string;
  modifiers: ('ctrl' | 'alt' | 'shift' | 'meta')[];
}

export interface ChatMessage {
  type: 'chat';
  text: string;
  sender: string;
  timestamp: number;
}

export interface SystemMessage {
  type: 'system';
  action: string;
  data?: any;
}
