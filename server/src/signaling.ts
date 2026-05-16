import { Server, Socket } from 'socket.io';
import { Registry } from './registry';
import { ConnectRequest, SignalMessage, SessionInfo } from './types';
import crypto from 'crypto';

/**
 * Signaling — Handles WebRTC signaling relay and connection requests
 */
export class Signaling {
  private io: Server;
  private registry: Registry;
  // Active sessions: sessionId → SessionInfo
  private sessions: Map<string, SessionInfo> = new Map();

  constructor(io: Server, registry: Registry) {
    this.io = io;
    this.registry = registry;
  }

  /**
   * Setup Socket.io event handlers
   */
  setup(): void {
    this.io.on('connection', (socket: Socket) => {
      console.log(`[Signal] Client connected: ${socket.id.substring(0, 8)}...`);

      // === REGISTRATION ===
      socket.on('register', (data: { machineId: string; machineName: string }) => {
        this.registry.register(data.machineId, socket.id, data.machineName);
        socket.emit('registered', { success: true });
      });

      // === HEARTBEAT ===
      socket.on('ping', () => {
        const machineId = this.registry.getMachineId(socket.id);
        if (machineId) {
          this.registry.updatePing(machineId);
        }
        socket.emit('pong');
      });

      // === CONNECTION REQUEST (Viewer → Host) ===
      socket.on('connect-request', (data: ConnectRequest) => {
        this.handleConnectRequest(socket, data);
      });

      // === CONNECTION RESPONSE (Host → Viewer) ===
      socket.on('connect-response', (data: { toId: string; accepted: boolean; nonce: string }) => {
        this.handleConnectResponse(socket, data);
      });

      // === PASSWORD VERIFICATION ===
      socket.on('password-verify', (data: { toId: string; passwordHash: string; nonce: string }) => {
        this.handlePasswordVerify(socket, data);
      });

      // === WEBRTC SIGNALING ===
      socket.on('signal', (message: SignalMessage) => {
        this.relaySignal(socket, message);
      });

      // === DISCONNECT ===
      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });

      // === END SESSION ===
      socket.on('end-session', (data: { sessionId: string }) => {
        this.endSession(data.sessionId, socket);
      });
    });

    // Cleanup stale connections every 30 seconds
    setInterval(() => {
      this.registry.cleanup();
    }, 30_000);
  }

  /**
   * Handle connection request from viewer to host
   */
  private handleConnectRequest(socket: Socket, data: ConnectRequest): void {
    const fromId = this.registry.getMachineId(socket.id);
    if (!fromId) {
      socket.emit('connect-error', { error: 'Not registered' });
      return;
    }

    // Check if target is online
    if (!this.registry.isOnline(data.toId)) {
      socket.emit('connect-error', { error: 'Partner is offline', code: 'OFFLINE' });
      return;
    }

    const targetSocketId = this.registry.getSocketId(data.toId);
    if (!targetSocketId) {
      socket.emit('connect-error', { error: 'Partner not found', code: 'NOT_FOUND' });
      return;
    }

    // Generate nonce for password challenge
    const nonce = crypto.randomBytes(32).toString('hex');

    // Send connection request to host with nonce
    this.io.to(targetSocketId).emit('connect-request', {
      fromId: fromId,
      fromName: data.fromName,
      mode: data.mode,
      nonce: nonce,
    });

    // Send nonce back to viewer for password hashing
    socket.emit('connect-challenge', {
      nonce: nonce,
      toId: data.toId,
    });

    console.log(`[Signal] Connect request: ${fromId} → ${data.toId}`);
  }

  /**
   * Handle password verification
   */
  private handlePasswordVerify(socket: Socket, data: { toId: string; passwordHash: string; nonce: string }): void {
    const fromId = this.registry.getMachineId(socket.id);
    if (!fromId) return;

    const targetSocketId = this.registry.getSocketId(data.toId);
    if (!targetSocketId) {
      socket.emit('connect-error', { error: 'Partner went offline', code: 'OFFLINE' });
      return;
    }

    // Relay password hash to host for verification
    this.io.to(targetSocketId).emit('password-verify', {
      fromId: fromId,
      passwordHash: data.passwordHash,
      nonce: data.nonce,
    });
  }

  /**
   * Handle connection response from host
   */
  private handleConnectResponse(socket: Socket, data: { toId: string; accepted: boolean; nonce: string }): void {
    const hostId = this.registry.getMachineId(socket.id);
    if (!hostId) return;

    const viewerSocketId = this.registry.getSocketId(data.toId);
    if (!viewerSocketId) return;

    if (data.accepted) {
      // Create session
      const sessionId = crypto.randomUUID();
      const session: SessionInfo = {
        id: sessionId,
        hostId: hostId,
        viewerId: data.toId,
        mode: 'control',
        startedAt: Date.now(),
        status: 'connecting',
      };
      this.sessions.set(sessionId, session);

      // Notify both parties
      this.io.to(viewerSocketId).emit('connect-accepted', { sessionId });
      socket.emit('session-started', { sessionId, viewerId: data.toId });

      console.log(`[Signal] Session created: ${sessionId} (${hostId} ← ${data.toId})`);
    } else {
      this.io.to(viewerSocketId).emit('connect-rejected', { reason: 'Password incorrect' });
      console.log(`[Signal] Connection rejected: ${data.toId} → ${hostId}`);
    }
  }

  /**
   * Relay WebRTC signaling messages
   */
  private relaySignal(socket: Socket, message: SignalMessage): void {
    const targetSocketId = this.registry.getSocketId(message.to);
    if (!targetSocketId) {
      socket.emit('signal-error', { error: 'Target offline' });
      return;
    }

    const fromId = this.registry.getMachineId(socket.id);
    this.io.to(targetSocketId).emit('signal', {
      type: message.type,
      from: fromId,
      to: message.to,
      data: message.data,
    });
  }

  /**
   * End a session
   */
  private endSession(sessionId: string, socket: Socket): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = 'ended';
    this.sessions.delete(sessionId);

    const fromId = this.registry.getMachineId(socket.id);

    // Notify the other party
    const otherId = fromId === session.hostId ? session.viewerId : session.hostId;
    const otherSocketId = this.registry.getSocketId(otherId);
    if (otherSocketId) {
      this.io.to(otherSocketId).emit('session-ended', { sessionId, by: fromId });
    }

    console.log(`[Signal] Session ended: ${sessionId}`);
  }

  /**
   * Handle disconnection
   */
  private handleDisconnect(socket: Socket): void {
    const machineId = this.registry.unregister(socket.id);
    if (!machineId) return;

    // End any active sessions involving this machine
    for (const [sessionId, session] of this.sessions) {
      if (session.hostId === machineId || session.viewerId === machineId) {
        const otherId = machineId === session.hostId ? session.viewerId : session.hostId;
        const otherSocketId = this.registry.getSocketId(otherId);
        if (otherSocketId) {
          this.io.to(otherSocketId).emit('session-ended', {
            sessionId,
            by: machineId,
            reason: 'disconnect',
          });
        }
        this.sessions.delete(sessionId);
      }
    }

    console.log(`[Signal] Client disconnected: ${socket.id.substring(0, 8)}...`);
  }

  /**
   * Get active session stats
   */
  getStats() {
    return {
      activeSessions: this.sessions.size,
      sessions: Array.from(this.sessions.values()).map(s => ({
        id: s.id,
        host: s.hostId,
        viewer: s.viewerId,
        duration: Date.now() - s.startedAt,
        status: s.status,
      })),
    };
  }
}
