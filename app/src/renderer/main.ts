/**
 * Titan-XT — Renderer Entry Point
 * Bootstraps the app, renders pages, handles events
 */

import { renderHomePage } from './pages/home';
import { renderSessionPage } from './pages/session';
import { showToast } from './components/toast';
import { ConnectionManager } from './lib/connection';

declare global {
  interface Window {
    titanAPI: any;
    connectionManager?: ConnectionManager;
  }
}

// === State ===
let currentPage: 'home' | 'session' = 'home';
let connectionManager: ConnectionManager | null = null;

// === Navigation ===
export function navigateTo(page: 'home' | 'session') {
  currentPage = page;
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  const target = document.getElementById(`page-${page}`);
  if (target) target.classList.add('active');
}

// === Initialize ===
async function init() {
  console.log('[Titan-XT] Initializing renderer...');

  // Setup titlebar controls
  setupTitlebar();

  // Initialize connection manager
  connectionManager = new ConnectionManager();
  window.connectionManager = connectionManager;

  // Connect to signal server
  try {
    const identity = await window.titanAPI?.identity?.get();
    if (identity) {
      const connected = await connectionManager.connectToServer(
        identity.machineId,
        identity.machineName || 'Unknown'
      );
      if (!connected) {
        showToast('Không thể kết nối server', 'error');
      }
    }
  } catch (e) {
    console.error('[Main] Failed to connect to server:', e);
  }

  // Render home page
  await renderHomePage();

  // Pre-render session page structure
  renderSessionPage();

  console.log('[Titan-XT] Renderer ready.');
}

// === Titlebar ===
function setupTitlebar() {
  document.getElementById('btn-minimize')?.addEventListener('click', () => {
    window.titanAPI?.window?.minimize();
  });

  document.getElementById('btn-maximize')?.addEventListener('click', () => {
    window.titanAPI?.window?.maximize();
  });

  document.getElementById('btn-close')?.addEventListener('click', () => {
    window.titanAPI?.window?.close();
  });
}

// === Boot ===
document.addEventListener('DOMContentLoaded', init);
