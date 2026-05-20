/**
 * Titan-XT — Renderer Entry Point
 * Bootstraps the app, renders pages, handles events
 */

import { renderHomePage, resetConnectForm } from './pages/home';
import { renderSessionPage } from './pages/session';
import { renderAddressBookPage } from './pages/address-book';
import { showToast } from './components/toast';
import { initUpdateBanner } from './components/update-banner';
import { ConnectionManager } from './lib/connection';

declare global {
  interface Window {
    titanAPI: any;
    connectionManager?: ConnectionManager;
  }
}

// === State ===
type PageId = 'home' | 'address-book' | 'session';
let currentPage: PageId = 'home';
let connectionManager: ConnectionManager | null = null;

// === Navigation ===
export function navigateTo(page: PageId) {
  currentPage = page;
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  const target = document.getElementById(`page-${page}`);
  if (target) target.classList.add('active');

  // Hide top tab strip while in an active session for an immersive view.
  const tabs = document.getElementById('app-tabs');
  if (tabs) tabs.style.display = page === 'session' ? 'none' : '';

  // Sync tab active state for top-level pages.
  document.querySelectorAll<HTMLElement>('.app-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });

  // When returning to home, reset the connect form so a stale "Đang kết nối..."
  // button from a previous attempt doesn't persist.
  if (page === 'home') {
    resetConnectForm();
    applyHomePrefill();
  } else if (page === 'address-book') {
    renderAddressBookPage();
  }
}

/**
 * If the Address Book asked to prefill the connect form (e.g. when an entry
 * has no saved password), apply it after the home page has reset.
 */
function applyHomePrefill(): void {
  const prefill = (window as any).__prefillConnect;
  if (!prefill) return;
  delete (window as any).__prefillConnect;
  setTimeout(() => {
    const idInput = document.getElementById('partner-id') as HTMLInputElement | null;
    const passInput = document.getElementById('partner-password') as HTMLInputElement | null;
    if (idInput && prefill.partnerId) {
      const digits = String(prefill.partnerId).replace(/\D/g, '').substring(0, 9);
      const formatted = digits.length <= 3
        ? digits
        : digits.length <= 6
          ? `${digits.substring(0, 3)} ${digits.substring(3)}`
          : `${digits.substring(0, 3)} ${digits.substring(3, 6)} ${digits.substring(6)}`;
      idInput.value = formatted;
      idInput.dispatchEvent(new Event('input'));
    }
    if (prefill.mode) {
      const opt = document.getElementById(`opt-${prefill.mode}`);
      if (opt) {
        document.querySelectorAll('.radio-option').forEach((o) => o.classList.remove('active'));
        opt.classList.add('active');
        const radio = opt.querySelector('input[type=radio]') as HTMLInputElement | null;
        if (radio) radio.checked = true;
      }
    }
    passInput?.focus();
  }, 60);
}

// === Initialize ===
async function init() {
  console.log('[Titan-XT] Initializing renderer...');

  // Setup titlebar controls
  setupTitlebar();
  setupTabs();

  // Initialize connection manager
  connectionManager = new ConnectionManager();
  window.connectionManager = connectionManager;

  // When the user clicks X (window hides to tray), tear down any live
  // session so the partner doesn't keep "Đang điều khiển" / chat panel
  // up against an app the user thinks they closed.
  window.titanAPI?.on?.('app:before-hide', () => {
    try {
      connectionManager?.disconnect();
    } catch (e) {
      console.warn('[Main] disconnect on hide failed:', e);
    } finally {
      window.titanAPI?.window?.hideAfterDisconnect();
    }
  });

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

  // Wire up auto-update banner — listens for status events from the main
  // process and renders the upgrade prompt at the top of the home page.
  initUpdateBanner();

  console.log('[Titan-XT] Renderer ready.');
}

// === Tabs ===
function setupTabs() {
  document.querySelectorAll<HTMLElement>('.app-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page as PageId | undefined;
      if (page && page !== currentPage) navigateTo(page);
    });
  });
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
