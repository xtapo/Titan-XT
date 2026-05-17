/**
 * Connection Manager — Handles Socket.io signaling and WebRTC lifecycle
 */

import { io, Socket } from 'socket.io-client';
import { PeerConnection } from './webrtc';
import { InputHandler } from './input-handler';
import { addChatMessage, enterHostMode, exitHostMode, addFileEntry, updateFileProgress } from '../pages/session';
import { showToast } from '../components/toast';
import {
  CHANNEL_INPUT,
  CHANNEL_CHAT,
  CHANNEL_FILE,
  CHANNEL_SYSTEM,
  DEFAULT_SIGNAL_SERVER,
  HEARTBEAT_INTERVAL,
  DEFAULT_QUALITY,
  QualityPreset,
} from '../../shared/constants';
import {
  FileMessage,
  FileOfferMessage,
  FileChunkMessage,
} from '../../shared/protocol';

export class ConnectionManager {
  private socket: Socket | null = null;
  private peer: PeerConnection | null = null;
  private inputHandler: InputHandler | null = null;
  private heartbeatTimer: number | null = null;
  private serverUrl: string;
  private machineId: string = '';
  private machineName: string = '';
  private currentQuality: QualityPreset = DEFAULT_QUALITY;
  private role: 'host' | 'viewer' | null = null;
  private partnerId: string = '';
  // File transfer: incoming chunks are buffered until 'complete' arrives.
  private incomingFiles: Map<string, { name: string; size: number; chunks: string[]; received: number }> = new Map();

  constructor(serverUrl?: string) {
    this.serverUrl = serverUrl || DEFAULT_SIGNAL_SERVER;
  }

  // === Signal Server Connection ===

  async connectToServer(machineId: string, machineName: string): Promise<boolean> {
    this.machineId = machineId;
    this.machineName = machineName;

    return new Promise((resolve) => {
      this.socket = io(this.serverUrl, {
        transports: ['websocket', 'polling'],
        timeout: 10000,
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 3000,
      });

      this.socket.on('connect', () => {
        console.log('[Conn] Connected to signal server');
        this.socket!.emit('register', { machineId, machineName });
        this.startHeartbeat();
        resolve(true);
      });

      this.socket.on('registered', () => {
        console.log('[Conn] Registered with server');
      });

      this.socket.on('connect_error', (err) => {
        console.error('[Conn] Server connection error:', err.message);
        resolve(false);
      });

      // Handle incoming connection request (we are the HOST)
      this.socket.on('connect-request', (data: any) => {
        console.log(`[Conn] Incoming connection from ${data.fromId}`);
        // In auto-accept mode, respond to password challenge
      });

      // Handle password verification request
      this.socket.on('password-verify', async (data: any) => {
        console.log('[Conn] Password verification request');
        const isValid = await this.verifyPassword(data.passwordHash, data.nonce);
        this.socket!.emit('connect-response', {
          toId: data.fromId,
          accepted: isValid,
          nonce: data.nonce,
        });

        if (isValid) {
          // We are the HOST — prepare to share screen
          this.setupAsHost(data.fromId);
        }
      });

      // Handle WebRTC signaling
      this.socket.on('signal', (msg: any) => {
        this.handleSignal(msg);
      });

      // Handle session ended by other party
      this.socket.on('session-ended', (_data: any) => {
        this.disconnect();
        showToast('Phiên kết nối đã kết thúc', 'info');
        // Surface the home screen so the user isn't stuck on a dead session UI.
        import('../main').then(({ navigateTo }) => navigateTo('home'));
      });

      this.socket.on('disconnect', () => {
        console.log('[Conn] Disconnected from server');
        this.stopHeartbeat();
      });
    });
  }

  // === Connect to Partner (we are VIEWER) ===

  async connectToPartner(partnerId: string, password: string, mode: string): Promise<void> {
    if (!this.socket?.connected) {
      showToast('Chưa kết nối server', 'error');
      return;
    }

    // Setup peer + ICE forwarding BEFORE sending connect-request so that
    // host's offer/ICE candidates (which arrive immediately after the host
    // accepts) have a peer to land on. Without this, Chromium drops them
    // and the viewer ends up with a black screen.
    this.setupAsViewer(partnerId, mode);

    // Send connection request
    this.socket.emit('connect-request', {
      fromId: this.machineId,
      toId: partnerId,
      fromName: this.machineName,
      mode,
    });

    // Wait for challenge nonce
    this.socket.once('connect-challenge', async (data: any) => {
      // Hash password with nonce using SHA-256 (must match host's identity.ts)
      const hash = await this.hashPassword(password, data.nonce);
      this.socket!.emit('password-verify', {
        toId: partnerId,
        passwordHash: hash,
        nonce: data.nonce,
      });
    });

    // Wait for acceptance
    this.socket.once('connect-accepted', (data: any) => {
      console.log('[Conn] Connection accepted! Session:', data.sessionId);
      // Peer is already configured; nothing more to do here.
    });

    this.socket.once('connect-rejected', () => {
      showToast('Mật khẩu không đúng', 'error');
      this.handleViewerConnectFailure();
    });

    this.socket.once('connect-error', (data: any) => {
      showToast(data.error || 'Lỗi kết nối', 'error');
      this.handleViewerConnectFailure();
    });
  }

  /**
   * Tear down a half-built viewer peer when the host rejects the password
   * or the server reports an error. Without this, a stale PeerConnection
   * + InputHandler stays alive across attempts and pollutes the next one.
   */
  private handleViewerConnectFailure(): void {
    this.inputHandler?.disable();
    this.peer?.close();
    this.peer = null;
    this.inputHandler = null;
    this.role = null;
    this.partnerId = '';
    // Re-import lazily to avoid a circular dep at module-load time.
    import('../pages/home').then(({ resetConnectForm }) => resetConnectForm());
    import('../main').then(({ navigateTo }) => navigateTo('home'));
  }

  // === Setup as HOST (being controlled) ===

  private async setupAsHost(viewerId: string): Promise<void> {
    console.log('[Conn] Setting up as HOST');
    this.role = 'host';
    this.partnerId = viewerId;

    // Navigate to session page in host mode (shows chat + status panel)
    enterHostMode(viewerId);

    this.peer = new PeerConnection({
      onDataMessage: (channel, data) => {
        if (channel === CHANNEL_INPUT) {
          // Forward input to main process for simulation
          window.titanAPI?.input?.simulate(data);
        } else if (channel === CHANNEL_CHAT) {
          addChatMessage(data.text, 'received');
        } else if (channel === CHANNEL_FILE) {
          this.handleFileMessage(data);
        } else if (channel === CHANNEL_SYSTEM) {
          this.handleSystemMessage(data);
        }
      },
      onStateChange: (state) => {
        console.log('[Conn] Host peer state:', state);
      },
    });

    this.peer.onIceCandidate = (candidate) => {
      this.socket?.emit('signal', {
        type: 'ice-candidate',
        to: viewerId,
        data: candidate.toJSON(),
      });
    };

    // Capture screen and add to peer
    try {
      // In Electron, navigator.mediaDevices.getDisplayMedia is enabled via
      // session.setDisplayMediaRequestHandler in the main process (screen-capture.ts).
      // The handler picks the source; renderer constraints below only shape the stream.
      const sources = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: {
          width: { max: 1920 },
          height: { max: 1080 },
          frameRate: { max: 30 },
        },
      });

      this.peer.addStream(sources);
      console.log('[Conn] Screen capture successful');
    } catch (err) {
      console.error('[Conn] Screen capture failed:', err);
      showToast('Không thể chia sẻ màn hình', 'error');
    }

    // Create and send offer
    const offer = await this.peer.createOffer();
    this.socket?.emit('signal', {
      type: 'offer',
      to: viewerId,
      data: offer,
    });
  }

  // === Setup as VIEWER (controlling) ===

  private setupAsViewer(hostId: string, mode: string): void {
    console.log('[Conn] Setting up as VIEWER');
    this.role = 'viewer';
    this.partnerId = hostId;

    const videoEl = document.getElementById('remote-video') as HTMLVideoElement;

    this.peer = new PeerConnection({
      onRemoteStream: (stream) => {
        console.log('[Conn] Received remote stream');
        if (videoEl) {
          videoEl.srcObject = stream;
          // Hide overlay
          document.getElementById('video-overlay')?.classList.add('hidden');
        }
      },
      onDataMessage: (channel, data) => {
        if (channel === CHANNEL_CHAT) {
          addChatMessage(data.text, 'received');
        } else if (channel === CHANNEL_FILE) {
          this.handleFileMessage(data);
        } else if (channel === CHANNEL_SYSTEM) {
          this.handleSystemMessage(data);
        }
      },
      onStateChange: (state) => {
        console.log('[Conn] Viewer peer state:', state);
        if (state === 'connected') {
          showToast('Kết nối thành công!', 'success');
        }
      },
      onStatsUpdate: (stats) => {
        const latencyEl = document.getElementById('stat-latency');
        const fpsEl = document.getElementById('stat-fps');
        const bitrateEl = document.getElementById('stat-bitrate');
        if (latencyEl) latencyEl.textContent = `${stats.latency}ms`;
        if (fpsEl) fpsEl.textContent = `${stats.fps}fps`;
        if (bitrateEl) {
          const mbps = stats.bitrate / 1_000_000;
          bitrateEl.textContent = mbps >= 1
            ? `${mbps.toFixed(1)}Mbps`
            : `${Math.round(stats.bitrate / 1000)}kbps`;
        }
      },
    });

    this.peer.onIceCandidate = (candidate) => {
      this.socket?.emit('signal', {
        type: 'ice-candidate',
        to: hostId,
        data: candidate.toJSON(),
      });
    };

    // Enable input handler if control mode
    if (mode === 'control' && videoEl) {
      this.inputHandler = new InputHandler(videoEl, this.peer);
      // Enable after stream is received
      videoEl.addEventListener('loadedmetadata', () => {
        this.inputHandler?.enable();
      }, { once: true });
    }
  }

  // === Handle WebRTC signals ===

  private async handleSignal(msg: any): Promise<void> {
    if (!this.peer) return;

    switch (msg.type) {
      case 'offer':
        const answer = await this.peer.handleOffer(msg.data);
        this.socket?.emit('signal', {
          type: 'answer',
          to: msg.from,
          data: answer,
        });
        break;

      case 'answer':
        await this.peer.handleAnswer(msg.data);
        break;

      case 'ice-candidate':
        await this.peer.addIceCandidate(msg.data);
        break;
    }
  }

  // === Password Helpers ===

  private async hashPassword(password: string, nonce: string): Promise<string> {
    const data = new TextEncoder().encode(password + nonce);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private async verifyPassword(hash: string, nonce: string): Promise<boolean> {
    try {
      if (window.titanAPI?.identity) {
        return await (window as any).titanAPI.identity.verifyPassword?.(hash, nonce) ?? false;
      }
    } catch {
      return false;
    }
    return false;
  }

  // === Chat ===

  sendChat(text: string): boolean {
    if (!this.peer) return false;
    return this.peer.send(CHANNEL_CHAT, {
      type: 'chat',
      text,
      sender: this.machineName,
      timestamp: Date.now(),
    });
  }

  // === File Transfer ===

  /**
   * Send a file from local disk to the partner over the file data channel.
   * Reads the file in chunks via main process IPC and streams them as
   * base64-encoded chunk messages. Backpressure is honored by waiting
   * when the data channel buffer grows too large.
   */
  async sendFile(filePath: string, fileName: string, fileSize: number): Promise<void> {
    if (!this.peer) {
      showToast('Chưa kết nối — không thể gửi file', 'error');
      return;
    }
    if (!window.titanAPI?.file?.readChunk) {
      showToast('Không có API đọc file', 'error');
      return;
    }

    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const CHUNK_SIZE = 64 * 1024; // 64 KB raw → ~88 KB base64, well under typical 256 KB SCTP limit
    const totalChunks = Math.max(1, Math.ceil(fileSize / CHUNK_SIZE));

    // Surface in UI immediately so the sender sees feedback even on tiny files.
    addFileEntry(fileId, fileName, fileSize, 'sending');

    const offer: FileOfferMessage = {
      type: 'file', action: 'offer',
      fileId, fileName, fileSize,
      fileType: fileName.split('.').pop() || '',
    };
    if (!this.peer.send(CHANNEL_FILE, offer)) {
      updateFileProgress(fileId, 0, 'error');
      return;
    }

    let offset = 0;
    let chunkIndex = 0;
    while (offset < fileSize) {
      const remaining = fileSize - offset;
      const size = Math.min(CHUNK_SIZE, remaining);
      const base64 = await window.titanAPI.file.readChunk(filePath, offset, size);
      if (base64 == null) {
        updateFileProgress(fileId, 0, 'error');
        showToast(`Lỗi đọc file ${fileName}`, 'error');
        return;
      }

      const chunk: FileChunkMessage = {
        type: 'file', action: 'chunk',
        fileId, chunkIndex, totalChunks,
        data: base64,
      };

      // Backpressure: pause when the SCTP send buffer is congested.
      // Without this, large files crash the data channel.
      const channel = (this.peer as any)?.dataChannels?.get?.(CHANNEL_FILE) as RTCDataChannel | undefined;
      if (channel) {
        while (channel.bufferedAmount > 1_000_000) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      if (!this.peer.send(CHANNEL_FILE, chunk)) {
        updateFileProgress(fileId, 0, 'error');
        showToast(`Mất kết nối khi gửi ${fileName}`, 'error');
        return;
      }

      offset += size;
      chunkIndex += 1;
      const percent = Math.round((offset / fileSize) * 100);
      updateFileProgress(fileId, percent, 'sending');
    }

    this.peer.send(CHANNEL_FILE, {
      type: 'file', action: 'complete', fileId,
    });
    updateFileProgress(fileId, 100, 'complete');
  }

  /**
   * Process incoming file messages on the receiver side.
   * offer  → register a buffer
   * chunk  → append + update progress
   * complete → write to disk via main process and mark done
   */
  private async handleFileMessage(msg: FileMessage): Promise<void> {
    if (!msg || msg.type !== 'file') return;

    if (msg.action === 'offer') {
      this.incomingFiles.set(msg.fileId, {
        name: msg.fileName,
        size: msg.fileSize,
        chunks: new Array(0),
        received: 0,
      });
      addFileEntry(msg.fileId, msg.fileName, msg.fileSize, 'receiving');
      return;
    }

    if (msg.action === 'chunk') {
      const entry = this.incomingFiles.get(msg.fileId);
      if (!entry) return;
      // Store chunk by index so out-of-order arrivals (shouldn't happen on
      // ordered channels, but be defensive) still reassemble correctly.
      entry.chunks[msg.chunkIndex] = msg.data;
      entry.received += 1;
      const percent = Math.round((entry.received / msg.totalChunks) * 100);
      updateFileProgress(msg.fileId, percent, 'receiving');
      return;
    }

    if (msg.action === 'complete') {
      const entry = this.incomingFiles.get(msg.fileId);
      if (!entry) return;
      try {
        // Concatenate base64 chunks then hand off to main for disk write.
        const fullBase64 = entry.chunks.join('');
        const result = await window.titanAPI?.file?.saveFile(entry.name, fullBase64);
        if (result?.success) {
          updateFileProgress(msg.fileId, 100, 'complete');
          showToast(`Đã nhận: ${entry.name}`, 'success');
        } else {
          updateFileProgress(msg.fileId, 0, 'error');
          showToast(`Lỗi lưu ${entry.name}`, 'error');
        }
      } catch (err) {
        console.error('[Conn] saveFile failed:', err);
        updateFileProgress(msg.fileId, 0, 'error');
      } finally {
        this.incomingFiles.delete(msg.fileId);
      }
      return;
    }

    if (msg.action === 'error') {
      updateFileProgress(msg.fileId, 0, 'error');
      this.incomingFiles.delete(msg.fileId);
    }
  }

  // === Quality Control ===

  /**
   * Viewer-side: request a different quality preset from the host.
   * The host re-applies sender params + capture constraints.
   */
  requestQuality(preset: QualityPreset): boolean {
    if (this.role !== 'viewer') return false;
    this.currentQuality = preset;
    return this.peer?.send(CHANNEL_SYSTEM, {
      type: 'system',
      action: 'quality',
      data: { preset },
    }) ?? false;
  }

  get quality(): QualityPreset {
    return this.currentQuality;
  }

  /**
   * Handle a SystemMessage received on the data channel.
   * Handles quality changes (host-side) and clipboard sync (both sides).
   */
  private handleSystemMessage(msg: any): void {
    if (!msg || msg.type !== 'system') return;

    switch (msg.action) {
      case 'quality':
        if (this.role === 'host') {
          const preset: QualityPreset = msg.data?.preset;
          if (!preset) return;
          this.currentQuality = preset;
          this.peer?.applyQualityProfile(preset);
        }
        break;

      case 'clipboard':
        this.handleClipboardMessage(msg.data);
        break;
    }
  }

  // === Clipboard Sync ===

  /**
   * Handle clipboard system messages.
   *
   * HOST receives:
   *   'viewer-to-host'    — viewer sent clipboard text to paste on host
   *   'request-from-host' — viewer wants to read host clipboard (after Ctrl+C)
   *
   * VIEWER receives:
   *   'host-to-viewer'    — host sent its clipboard text back
   */
  private async handleClipboardMessage(data: any): Promise<void> {
    if (!data?.direction) return;

    if (this.role === 'host') {
      if (data.direction === 'viewer-to-host' && typeof data.text === 'string') {
        // Viewer wants to paste → write text to host clipboard, then simulate Ctrl+V
        try {
          await window.titanAPI?.clipboard?.write(data.text);
          console.log('[Conn] Clipboard received from viewer, simulating paste');
          // Simulate Ctrl+V on the host
          await window.titanAPI?.input?.simulate({ type: 'key', action: 'down', key: 'Control', code: 'ControlLeft', modifiers: ['ctrl'] });
          await window.titanAPI?.input?.simulate({ type: 'key', action: 'down', key: 'v', code: 'KeyV', modifiers: ['ctrl'] });
          await window.titanAPI?.input?.simulate({ type: 'key', action: 'up', key: 'v', code: 'KeyV', modifiers: ['ctrl'] });
          await window.titanAPI?.input?.simulate({ type: 'key', action: 'up', key: 'Control', code: 'ControlLeft', modifiers: [] });
        } catch (err) {
          console.error('[Conn] Clipboard paste on host failed:', err);
        }
      } else if (data.direction === 'request-from-host') {
        // Viewer wants host clipboard → read it and send back
        try {
          // Small delay to let the copy operation complete on the OS
          await new Promise((r) => setTimeout(r, 100));
          const text = await window.titanAPI?.clipboard?.read();
          if (text != null) {
            this.peer?.send(CHANNEL_SYSTEM, {
              type: 'system',
              action: 'clipboard',
              data: { direction: 'host-to-viewer', text },
            });
            console.log('[Conn] Clipboard sent to viewer:', text.length, 'chars');
          }
        } catch (err) {
          console.error('[Conn] Failed to read host clipboard:', err);
        }
      }
    } else if (this.role === 'viewer') {
      if (data.direction === 'host-to-viewer' && typeof data.text === 'string') {
        // Host sent clipboard content → write to viewer's local clipboard
        try {
          await window.titanAPI?.clipboard?.write(data.text);
          console.log('[Conn] Clipboard received from host:', data.text.length, 'chars');
        } catch (err) {
          console.error('[Conn] Failed to write to local clipboard:', err);
        }
      }
    }
  }

  // === Heartbeat ===

  private startHeartbeat(): void {
    this.heartbeatTimer = window.setInterval(() => {
      this.socket?.emit('ping');
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // === Disconnect ===

  disconnect(): void {
    this.inputHandler?.disable();
    this.peer?.close();
    this.peer = null;
    this.inputHandler = null;
    if (this.role === 'host') {
      exitHostMode();
    }
    this.role = null;
    this.partnerId = '';
  }

  disconnectAll(): void {
    this.disconnect();
    this.stopHeartbeat();
    this.socket?.disconnect();
    this.socket = null;
  }

  get isConnectedToServer(): boolean {
    return this.socket?.connected ?? false;
  }
}
