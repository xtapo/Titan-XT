// === Signal Server Types ===

export interface MachineInfo {
  machineId: string;
  socketId: string;
  machineName: string;
  registeredAt: number;
  lastPing: number;
}

export interface ConnectRequest {
  fromId: string;
  toId: string;
  fromName: string;
  passwordHash: string;
  nonce?: string;
  mode: 'control' | 'view' | 'file';
}

export interface ConnectResponse {
  accepted: boolean;
  reason?: string;
  nonce?: string;
}

export interface SignalMessage {
  type: 'offer' | 'answer' | 'ice-candidate';
  from: string;
  to: string;
  data: any;
}

export interface SessionInfo {
  id: string;
  hostId: string;
  viewerId: string;
  mode: 'control' | 'view' | 'file';
  startedAt: number;
  status: 'connecting' | 'active' | 'ended';
}
