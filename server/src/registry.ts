import { MachineInfo } from './types';

/**
 * Registry — Maps Machine IDs to Socket connections
 * Manages online/offline status of all connected Titan-XT clients
 */
export class Registry {
  // machineId → MachineInfo
  private machines: Map<string, MachineInfo> = new Map();
  // socketId → machineId (reverse lookup)
  private socketToMachine: Map<string, string> = new Map();

  /**
   * Register a machine when it connects
   */
  register(machineId: string, socketId: string, machineName: string): void {
    // If this machine was already registered with a different socket, clean up
    const existing = this.machines.get(machineId);
    if (existing) {
      this.socketToMachine.delete(existing.socketId);
    }

    const info: MachineInfo = {
      machineId,
      socketId,
      machineName,
      registeredAt: Date.now(),
      lastPing: Date.now(),
    };

    this.machines.set(machineId, info);
    this.socketToMachine.set(socketId, machineId);

    console.log(`[Registry] Registered: ${machineId} (${machineName}) → socket ${socketId.substring(0, 8)}...`);
  }

  /**
   * Unregister a machine when it disconnects
   */
  unregister(socketId: string): string | null {
    const machineId = this.socketToMachine.get(socketId);
    if (!machineId) return null;

    this.machines.delete(machineId);
    this.socketToMachine.delete(socketId);

    console.log(`[Registry] Unregistered: ${machineId} (socket ${socketId.substring(0, 8)}...)`);
    return machineId;
  }

  /**
   * Check if a machine is online
   */
  isOnline(machineId: string): boolean {
    return this.machines.has(machineId);
  }

  /**
   * Get socket ID for a machine
   */
  getSocketId(machineId: string): string | null {
    const info = this.machines.get(machineId);
    return info ? info.socketId : null;
  }

  /**
   * Get machine ID from socket ID
   */
  getMachineId(socketId: string): string | null {
    return this.socketToMachine.get(socketId) || null;
  }

  /**
   * Get machine info
   */
  getMachineInfo(machineId: string): MachineInfo | null {
    return this.machines.get(machineId) || null;
  }

  /**
   * Update last ping time
   */
  updatePing(machineId: string): void {
    const info = this.machines.get(machineId);
    if (info) {
      info.lastPing = Date.now();
    }
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      totalOnline: this.machines.size,
      machines: Array.from(this.machines.values()).map(m => ({
        machineId: m.machineId,
        machineName: m.machineName,
        onlineSince: m.registeredAt,
      })),
    };
  }

  /**
   * Cleanup stale connections (no ping in 60 seconds)
   */
  cleanup(): number {
    const now = Date.now();
    const staleTimeout = 60_000; // 60 seconds
    let cleaned = 0;

    for (const [machineId, info] of this.machines) {
      if (now - info.lastPing > staleTimeout) {
        this.machines.delete(machineId);
        this.socketToMachine.delete(info.socketId);
        cleaned++;
        console.log(`[Registry] Cleaned stale: ${machineId}`);
      }
    }

    return cleaned;
  }
}
