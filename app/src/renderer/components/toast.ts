/**
 * Toast notification component
 */

let container: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

export function showToast(message: string, type: 'success' | 'error' | 'info' = 'info', duration = 3000) {
  const c = ensureContainer();
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons: Record<string, string> = {
    success: '✓',
    error: '✕',
    info: 'ℹ',
  };

  toast.innerHTML = `<span>${icons[type]}</span><span>${message}</span>`;
  c.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}
