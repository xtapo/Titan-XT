/**
 * Renderer-side bridge to the signal-server socket that lives in the main
 * process. Mimics the slice of the socket.io-client API that ConnectionManager
 * uses (`.connected`, `.emit`, `.on`, `.once`, `.off`, `.disconnect`) so the
 * rest of the manager stays untouched.
 *
 * The actual socket.io connection sits in main/signal-client.ts. Moving it
 * out of the renderer means the connection survives the window being
 * destroyed when the user closes to tray — unattended hosts keep accepting
 * incoming sessions without keeping a renderer process alive.
 */

type Listener = (...args: any[]) => void;

class SignalBridge {
  private listeners: Map<string, Set<Listener>> = new Map();
  private onceListeners: Map<string, Set<Listener>> = new Map();
  private unsubscribe: (() => void) | null = null;
  /**
   * Mirror of main's view of the socket. Updated on every `connect` /
   * `disconnect` event so callers can synchronously check status the same
   * way they used to with socket.io's `.connected` getter.
   */
  private _connected: boolean = false;

  constructor() {
    this.attach();
  }

  /**
   * Subscribe to events forwarded from main and register this renderer as
   * the live event sink. Called from the constructor; also runs on
   * reconnect after a destroy/re-create (new ConnectionManager instance).
   */
  private attach(): void {
    const api = (window as any).titanAPI?.signal;
    if (!api) return;
    this.unsubscribe = api.onEvent((event: string, ...args: any[]) => {
      if (event === 'connect') this._connected = true;
      else if (event === 'disconnect') this._connected = false;
      this.dispatch(event, args);
    });
    api.ready().then((res: { ok: boolean; connected: boolean }) => {
      this._connected = !!res?.connected;
      // If main was already connected before this renderer attached, fire a
      // synthetic 'connect' so callers can run their post-connect setup.
      if (this._connected) this.dispatch('connect', []);
    }).catch((err: unknown) => {
      console.warn('[SignalBridge] ready() failed:', err);
    });
  }

  private dispatch(event: string, args: any[]): void {
    const set = this.listeners.get(event);
    if (set) {
      // Snapshot so handlers calling .off mid-iteration don't disturb us.
      for (const l of [...set]) {
        try { l(...args); } catch (err) { console.error(`[SignalBridge:${event}]`, err); }
      }
    }
    const onceSet = this.onceListeners.get(event);
    if (onceSet && onceSet.size) {
      const snap = [...onceSet];
      onceSet.clear();
      for (const l of snap) {
        try { l(...args); } catch (err) { console.error(`[SignalBridge:once:${event}]`, err); }
      }
    }
  }

  get connected(): boolean {
    return this._connected;
  }

  emit(event: string, ...args: any[]): void {
    const api = (window as any).titanAPI?.signal;
    if (!api) return;
    api.emit(event, ...args).catch((err: unknown) => {
      console.warn('[SignalBridge] emit failed:', event, err);
    });
  }

  on(event: string, listener: Listener): void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(listener);
  }

  once(event: string, listener: Listener): void {
    let set = this.onceListeners.get(event);
    if (!set) { set = new Set(); this.onceListeners.set(event, set); }
    set.add(listener);
  }

  off(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
    this.onceListeners.get(event)?.delete(listener);
  }

  /**
   * Detach this renderer from main. The underlying socket stays connected —
   * we just stop receiving forwarded events. Called from ConnectionManager
   * on disconnectAll() to mirror the old socket.io disconnect semantics.
   */
  disconnect(): void {
    if (this.unsubscribe) {
      try { this.unsubscribe(); } catch { /* ignore */ }
      this.unsubscribe = null;
    }
    const api = (window as any).titanAPI?.signal;
    api?.detach?.().catch(() => { /* ignore */ });
    this.listeners.clear();
    this.onceListeners.clear();
    this._connected = false;
  }
}

export type SignalSocket = SignalBridge;

export function createSignalBridge(): SignalSocket {
  return new SignalBridge();
}
