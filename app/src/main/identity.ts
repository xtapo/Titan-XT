import crypto from 'crypto';
import os from 'os';
import { ipcMain } from 'electron';
import { getStore } from './store';

/**
 * Identity — Machine ID (9 digits, persistent) + Password (4 chars, random)
 */

function generateMachineId(): string {
  const hostname = os.hostname();
  const cpus = os.cpus();
  const networkInterfaces = os.networkInterfaces();

  let fingerprint = hostname;
  fingerprint += cpus.length > 0 ? cpus[0].model : '';
  fingerprint += os.totalmem().toString();

  for (const ifaces of Object.values(networkInterfaces)) {
    if (ifaces) {
      for (const iface of ifaces) {
        if (!iface.internal && iface.mac !== '00:00:00:00:00:00') {
          fingerprint += iface.mac;
          break;
        }
      }
    }
  }

  const hash = crypto.createHash('sha256').update(fingerprint).digest('hex');
  const num = parseInt(hash.substring(0, 12), 16) % 999_999_999;
  return (num + 100_000_000).toString().substring(0, 9);
}

function generatePassword(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < 4; i++) {
    password += chars[crypto.randomInt(chars.length)];
  }
  return password;
}

export function formatMachineId(id: string): string {
  return `${id.substring(0, 3)} ${id.substring(3, 6)} ${id.substring(6, 9)}`;
}

export function setupIdentity(): void {
  const store = getStore();

  let machineId = store.get('machineId') as string | undefined;
  if (!machineId) {
    machineId = generateMachineId();
    store.set('machineId', machineId);
    console.log(`[Identity] New Machine ID: ${formatMachineId(machineId)}`);
  } else {
    console.log(`[Identity] Machine ID: ${formatMachineId(machineId)}`);
  }

  let password = store.get('password') as string | undefined;
  if (!password) {
    password = generatePassword();
    store.set('password', password);
  }

  ipcMain.handle('identity:get', () => ({
    machineId: store.get('machineId'),
    password: store.get('password'),
    machineName: os.hostname(),
  }));

  ipcMain.handle('identity:regeneratePassword', () => {
    const newPass = generatePassword();
    store.set('password', newPass);
    return newPass;
  });

  ipcMain.handle('identity:verifyPassword', (_event: any, passwordHash: string, nonce: string) => {
    const currentPassword = store.get('password') as string;
    const expectedHash = crypto.createHash('sha256').update(currentPassword + nonce).digest('hex');
    return passwordHash === expectedHash;
  });
}
