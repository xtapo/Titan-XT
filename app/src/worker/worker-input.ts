/**
 * worker-input — synchronous input dispatcher used inside the SYSTEM Worker.
 *
 * The Agent's input-executor.ts uses nut.js, which dispatches its calls
 * onto libuv worker threads. Those threads inherit the desktop the worker
 * process started on (`winsta0\\default`) and never re-attach when the
 * input desktop changes — so input dies the instant the user locks the
 * workstation. We bypass nut.js inside the Worker by calling SendInput
 * synchronously on the same thread that already attached to the active
 * input desktop via desktop-attach.ts.
 *
 * Mouse-move semantics match the on-the-wire protocol: x/y are 0..1
 * ratios over the virtual desktop (matches the renderer's
 * `event.clientX / video.clientWidth` calculation upstream).
 */

import type { MouseMessage, KeyMessage } from '../shared/protocol';
import {
  bindNativeInput,
  moveTo,
  mouseButton,
  mouseClick,
  mouseDblClick,
  mouseScroll,
  keySend,
} from './native-input';

let lastRatio = { x: -1, y: -1 };

export function executeInputSync(msg: MouseMessage | KeyMessage): void {
  bindNativeInput();
  if (msg.type === 'mouse') {
    handleMouse(msg);
  } else if (msg.type === 'key') {
    handleKey(msg);
  }
}

function handleMouse(msg: MouseMessage): void {
  const x = clamp01(msg.x);
  const y = clamp01(msg.y);
  const needsMove = x !== lastRatio.x || y !== lastRatio.y;

  switch (msg.action) {
    case 'move':
      if (needsMove) {
        moveTo({ ratioX: x, ratioY: y });
        lastRatio = { x, y };
      }
      break;
    case 'down':
      if (needsMove) { moveTo({ ratioX: x, ratioY: y }); lastRatio = { x, y }; }
      mouseButton(msg.button || 'left', 'down');
      break;
    case 'up':
      if (needsMove) { moveTo({ ratioX: x, ratioY: y }); lastRatio = { x, y }; }
      mouseButton(msg.button || 'left', 'up');
      break;
    case 'click':
      if (needsMove) { moveTo({ ratioX: x, ratioY: y }); lastRatio = { x, y }; }
      mouseClick(msg.button || 'left');
      break;
    case 'dblclick':
      if (needsMove) { moveTo({ ratioX: x, ratioY: y }); lastRatio = { x, y }; }
      mouseDblClick();
      break;
    case 'contextmenu':
      if (needsMove) { moveTo({ ratioX: x, ratioY: y }); lastRatio = { x, y }; }
      mouseClick('right');
      break;
    case 'scroll':
      mouseScroll(msg.deltaX || 0, msg.deltaY || 0);
      break;
  }
}

function handleKey(msg: KeyMessage): void {
  // The viewer sends modifier-as-keys explicitly (a Ctrl press arrives as a
  // separate KeyMessage), so we don't have to compose flags here. Just send
  // the key directly.
  keySend(msg.key, msg.code, msg.action);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
