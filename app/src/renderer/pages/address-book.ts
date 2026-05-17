/**
 * Address Book ("Máy của tôi") — pinned remote machines with 1-click connect.
 *
 * Stored locally via electron-store. No data leaves the machine until the user
 * explicitly initiates a connect.
 */

import { showToast } from '../components/toast';
import { navigateTo } from '../main';
import type { AddressBookEntry } from '../../shared/types';

let entries: AddressBookEntry[] = [];
let editingId: string | null = null;
let searchQuery = '';
let activeGroup: string = '__all__';

function uuid(): string {
  return `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatId(id: string): string {
  if (!id || id.length < 9) return id || '--- --- ---';
  return `${id.substring(0, 3)} ${id.substring(3, 6)} ${id.substring(6, 9)}`;
}

function formatIdInput(value: string): string {
  const digits = value.replace(/\D/g, '').substring(0, 9);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.substring(0, 3)} ${digits.substring(3)}`;
  return `${digits.substring(0, 3)} ${digits.substring(3, 6)} ${digits.substring(6)}`;
}

function parseId(formatted: string): string {
  return formatted.replace(/\D/g, '');
}

function escapeHtml(s: string): string {
  return (s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] as string);
}

function timeAgo(ts?: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Vừa xong';
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  return `${days} ngày trước`;
}

async function loadEntries(): Promise<void> {
  try {
    if (window.titanAPI?.addressBook) {
      entries = (await window.titanAPI.addressBook.get()) || [];
    }
  } catch {
    entries = [];
  }
}

function filteredEntries(): AddressBookEntry[] {
  const q = searchQuery.trim().toLowerCase();
  return entries
    .filter((e) => {
      if (activeGroup !== '__all__') {
        if (activeGroup === '__fav__') return !!e.favorite;
        if (activeGroup === '__none__') return !e.group;
        if ((e.group || '') !== activeGroup) return false;
      }
      if (!q) return true;
      const hay = [
        e.alias, e.machineId, e.notes || '', e.group || '',
        ...(e.tags || []),
      ].join(' ').toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => {
      if ((a.favorite ? 1 : 0) !== (b.favorite ? 1 : 0)) {
        return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
      }
      return (b.lastConnectedAt || b.createdAt) - (a.lastConnectedAt || a.createdAt);
    });
}

function uniqueGroups(): string[] {
  const set = new Set<string>();
  entries.forEach((e) => { if (e.group) set.add(e.group); });
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'vi'));
}

/**
 * Public entry — render the Address Book page. Called on-demand from the
 * tab switcher so we always pull fresh data from the store.
 */
export async function renderAddressBookPage(): Promise<void> {
  const page = document.getElementById('page-address-book');
  if (!page) return;

  await loadEntries();
  const groups = uniqueGroups();

  page.innerHTML = `
    <div class="ab-header animate-fadeIn">
      <div class="ab-title">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
        <h2>Máy của tôi</h2>
        <span class="ab-count">${entries.length}</span>
      </div>
      <div class="ab-actions">
        <input id="ab-search" class="input-field ab-search"
               placeholder="Tìm theo tên, ID, nhãn..." spellcheck="false" />
        <button class="btn-primary ab-add" id="btn-ab-add">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Thêm máy
        </button>
      </div>
    </div>

    <div class="ab-body animate-fadeIn" style="animation-delay:0.05s">
      <aside class="ab-sidebar">
        <div class="ab-side-title">Nhóm</div>
        <button class="ab-group-item ${activeGroup === '__all__' ? 'active' : ''}" data-group="__all__">
          <span>Tất cả</span><span class="ab-group-count">${entries.length}</span>
        </button>
        <button class="ab-group-item ${activeGroup === '__fav__' ? 'active' : ''}" data-group="__fav__">
          <span>★ Yêu thích</span>
          <span class="ab-group-count">${entries.filter((e) => e.favorite).length}</span>
        </button>
        <button class="ab-group-item ${activeGroup === '__none__' ? 'active' : ''}" data-group="__none__">
          <span>Chưa phân nhóm</span>
          <span class="ab-group-count">${entries.filter((e) => !e.group).length}</span>
        </button>
        ${groups.map((g) => `
          <button class="ab-group-item ${activeGroup === g ? 'active' : ''}" data-group="${escapeHtml(g)}">
            <span>${escapeHtml(g)}</span>
            <span class="ab-group-count">${entries.filter((e) => e.group === g).length}</span>
          </button>
        `).join('')}
      </aside>

      <section class="ab-list" id="ab-list"></section>
    </div>
  `;

  setupAbEvents();
  renderList();
}

function renderList(): void {
  const list = document.getElementById('ab-list');
  if (!list) return;

  const items = filteredEntries();
  if (items.length === 0) {
    list.innerHTML = `
      <div class="ab-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
          <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
        </svg>
        <p>${entries.length === 0 ? 'Chưa có máy nào được lưu' : 'Không tìm thấy máy phù hợp'}</p>
        ${entries.length === 0 ? '<p class="ab-empty-hint">Bấm "Thêm máy" để lưu máy thường dùng</p>' : ''}
      </div>
    `;
    return;
  }

  list.innerHTML = items.map((e) => `
    <div class="ab-card" data-id="${e.id}">
      <button class="ab-fav ${e.favorite ? 'on' : ''}" data-action="favorite" title="Yêu thích">★</button>
      <div class="ab-card-main">
        <div class="ab-card-row1">
          <span class="ab-alias">${escapeHtml(e.alias || 'Không tên')}</span>
          ${e.group ? `<span class="ab-chip ab-chip-group">${escapeHtml(e.group)}</span>` : ''}
          ${(e.tags || []).map((t) => `<span class="ab-chip">${escapeHtml(t)}</span>`).join('')}
        </div>
        <div class="ab-card-row2">
          <span class="ab-mid">${formatId(e.machineId)}</span>
          ${e.password ? '<span class="ab-pw-badge" title="Đã lưu mật khẩu">🔒</span>' : '<span class="ab-pw-badge dim" title="Chưa lưu mật khẩu">🔓</span>'}
          <span class="ab-time">${timeAgo(e.lastConnectedAt)}</span>
        </div>
        ${e.notes ? `<div class="ab-notes">${escapeHtml(e.notes)}</div>` : ''}
      </div>
      <div class="ab-card-actions">
        <button class="btn-primary ab-connect" data-action="connect" title="Kết nối">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>
          </svg>
          Kết nối
        </button>
        <button class="btn-icon" data-action="edit" title="Sửa">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
        </button>
        <button class="btn-icon ab-del" data-action="delete" title="Xóa">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6"/>
          </svg>
        </button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.ab-card').forEach((card) => {
    const id = (card as HTMLElement).dataset.id || '';
    card.querySelectorAll<HTMLElement>('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'connect') connectEntry(id);
        else if (action === 'edit') openEditor(id);
        else if (action === 'delete') deleteEntry(id);
        else if (action === 'favorite') toggleFavorite(id);
      });
    });
    card.addEventListener('dblclick', () => connectEntry(id));
  });
}

function setupAbEvents(): void {
  document.getElementById('btn-ab-add')?.addEventListener('click', () => openEditor(null));

  const search = document.getElementById('ab-search') as HTMLInputElement | null;
  if (search) {
    search.value = searchQuery;
    search.addEventListener('input', () => {
      searchQuery = search.value;
      renderList();
    });
  }

  document.querySelectorAll<HTMLElement>('.ab-group-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeGroup = btn.dataset.group || '__all__';
      document.querySelectorAll('.ab-group-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderList();
    });
  });
}

async function toggleFavorite(id: string): Promise<void> {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  try {
    entries = await window.titanAPI.addressBook.update(id, { favorite: !entry.favorite });
    renderList();
  } catch {
    showToast('Lỗi cập nhật', 'error');
  }
}

async function deleteEntry(id: string): Promise<void> {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  if (!confirm(`Xóa "${entry.alias || formatId(entry.machineId)}"?`)) return;
  try {
    entries = await window.titanAPI.addressBook.remove(id);
    showToast('Đã xóa', 'success');
    await renderAddressBookPage();
  } catch {
    showToast('Lỗi xóa', 'error');
  }
}

/**
 * Kick off a connection using a saved entry. If the password is missing we
 * still navigate to the connect form so the user can fill it in. We optimistic-
 * stamp lastConnectedAt — the session page handles real success/failure.
 */
async function connectEntry(id: string): Promise<void> {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;

  if (!entry.machineId || entry.machineId.length < 9) {
    showToast('ID không hợp lệ', 'error');
    return;
  }

  if (!entry.password) {
    showToast('Chưa lưu mật khẩu — vui lòng nhập', 'info');
    (window as any).__prefillConnect = {
      partnerId: entry.machineId,
      mode: entry.defaultMode || 'control',
    };
    navigateTo('home');
    return;
  }

  try {
    await window.titanAPI.addressBook.touch(id);
  } catch {
    // best-effort
  }

  const mode = entry.defaultMode || 'control';
  showToast(`Đang kết nối đến ${entry.alias || formatId(entry.machineId)}...`, 'info');
  (window as any).__sessionInfo = {
    partnerId: entry.machineId,
    password: entry.password,
    mode,
  };
  navigateTo('session');
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('start-session', {
      detail: { partnerId: entry.machineId, password: entry.password, mode },
    }));
  }, 200);
}

/**
 * Build (once) and open the entry editor modal. Used for both add and edit.
 * `id === null` means create a new entry.
 */
function openEditor(id: string | null): void {
  editingId = id;
  const entry = id ? entries.find((e) => e.id === id) : null;

  let modal = document.getElementById('ab-editor');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'ab-editor';
    modal.className = 'settings-modal';
    modal.innerHTML = `
      <div class="settings-backdrop" data-close></div>
      <div class="settings-dialog">
        <div class="settings-header">
          <h2 id="ab-editor-title">Thêm máy</h2>
          <button class="btn-icon" data-close>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="settings-body">
          <div class="settings-field">
            <label class="field-label">Tên gợi nhớ</label>
            <input type="text" id="ab-alias" class="input-field"
                   placeholder="VD: Máy sếp Nam, PC văn phòng tầng 3..." maxlength="60" />
          </div>
          <div class="ab-row-2">
            <div class="settings-field">
              <label class="field-label">Partner ID</label>
              <input type="text" id="ab-machine-id" class="input-field input-id"
                     placeholder="123 456 789" maxlength="11" spellcheck="false" />
            </div>
            <div class="settings-field">
              <label class="field-label">Mật khẩu (tùy chọn)</label>
              <input type="text" id="ab-password" class="input-field input-password"
                     placeholder="Để trống để hỏi mỗi lần" maxlength="20" spellcheck="false" />
            </div>
          </div>
          <div class="ab-row-2">
            <div class="settings-field">
              <label class="field-label">Nhóm</label>
              <input type="text" id="ab-group" class="input-field"
                     placeholder="VD: Khách hàng, Văn phòng" maxlength="40" />
            </div>
            <div class="settings-field">
              <label class="field-label">Nhãn (cách nhau bằng dấu phẩy)</label>
              <input type="text" id="ab-tags" class="input-field"
                     placeholder="VIP, hỗ trợ-24h" />
            </div>
          </div>
          <div class="settings-field">
            <label class="field-label">Ghi chú</label>
            <textarea id="ab-notes" class="input-field ab-textarea" rows="2"
                      placeholder="Thông tin thêm: vị trí, người phụ trách..."></textarea>
          </div>
          <div class="settings-field">
            <label class="field-label">Chế độ kết nối mặc định</label>
            <div class="connect-options">
              <label class="radio-option active" data-mode="control">
                <input type="radio" name="ab-mode" value="control" checked />
                <span class="radio-dot"></span>Điều khiển
              </label>
              <label class="radio-option" data-mode="view">
                <input type="radio" name="ab-mode" value="view" />
                <span class="radio-dot"></span>Chỉ xem
              </label>
            </div>
          </div>
          <div class="settings-field">
            <label class="checkbox-option">
              <input type="checkbox" id="ab-favorite" />
              <span>★ Đánh dấu yêu thích</span>
            </label>
          </div>
        </div>
        <div class="settings-footer">
          <button class="btn-text" data-close>Hủy</button>
          <button class="btn-primary" id="btn-ab-save">Lưu</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelectorAll('[data-close]').forEach((el) =>
      el.addEventListener('click', () => modal!.classList.remove('open'))
    );

    const idInput = modal.querySelector('#ab-machine-id') as HTMLInputElement;
    idInput?.addEventListener('input', () => {
      const raw = parseId(idInput.value);
      idInput.value = formatIdInput(raw);
    });

    modal.querySelectorAll<HTMLElement>('.radio-option[data-mode]').forEach((opt) => {
      opt.addEventListener('click', () => {
        modal!.querySelectorAll('.radio-option[data-mode]').forEach((o) => o.classList.remove('active'));
        opt.classList.add('active');
        const radio = opt.querySelector('input[type=radio]') as HTMLInputElement | null;
        if (radio) radio.checked = true;
      });
    });

    modal.querySelector('#btn-ab-save')?.addEventListener('click', saveFromEditor);
  }

  // Hydrate fields
  const $ = <T extends HTMLElement>(sel: string) => modal!.querySelector(sel) as T;
  $<HTMLHeadingElement>('#ab-editor-title').textContent = entry ? 'Sửa máy' : 'Thêm máy';
  $<HTMLInputElement>('#ab-alias').value = entry?.alias || '';
  $<HTMLInputElement>('#ab-machine-id').value = formatIdInput(entry?.machineId || '');
  $<HTMLInputElement>('#ab-password').value = entry?.password || '';
  $<HTMLInputElement>('#ab-group').value = entry?.group || '';
  $<HTMLInputElement>('#ab-tags').value = (entry?.tags || []).join(', ');
  $<HTMLTextAreaElement>('#ab-notes').value = entry?.notes || '';
  $<HTMLInputElement>('#ab-favorite').checked = !!entry?.favorite;

  const mode = entry?.defaultMode || 'control';
  modal.querySelectorAll<HTMLElement>('.radio-option[data-mode]').forEach((opt) => {
    const isActive = opt.dataset.mode === mode;
    opt.classList.toggle('active', isActive);
    const radio = opt.querySelector('input[type=radio]') as HTMLInputElement | null;
    if (radio) radio.checked = isActive;
  });

  modal.classList.add('open');
  setTimeout(() => $<HTMLInputElement>('#ab-alias').focus(), 50);
}

async function saveFromEditor(): Promise<void> {
  const modal = document.getElementById('ab-editor');
  if (!modal) return;
  const $ = <T extends HTMLElement>(sel: string) => modal.querySelector(sel) as T;

  const alias = $<HTMLInputElement>('#ab-alias').value.trim();
  const machineId = parseId($<HTMLInputElement>('#ab-machine-id').value);
  const password = $<HTMLInputElement>('#ab-password').value.trim();
  const group = $<HTMLInputElement>('#ab-group').value.trim();
  const tagsRaw = $<HTMLInputElement>('#ab-tags').value;
  const notes = $<HTMLTextAreaElement>('#ab-notes').value.trim();
  const favorite = $<HTMLInputElement>('#ab-favorite').checked;
  const modeInput = modal.querySelector('input[name="ab-mode"]:checked') as HTMLInputElement | null;
  const defaultMode = (modeInput?.value as 'control' | 'view') || 'control';

  if (machineId.length !== 9) {
    showToast('ID phải đủ 9 chữ số', 'error');
    return;
  }
  if (!alias) {
    showToast('Vui lòng đặt tên gợi nhớ', 'error');
    return;
  }

  const tags = tagsRaw.split(',').map((t) => t.trim()).filter(Boolean);
  const existing = editingId ? entries.find((e) => e.id === editingId) : null;
  const payload: AddressBookEntry = {
    id: existing?.id || uuid(),
    alias,
    machineId,
    password: password || undefined,
    group: group || undefined,
    tags,
    notes: notes || undefined,
    defaultMode,
    favorite,
    createdAt: existing?.createdAt || Date.now(),
    lastConnectedAt: existing?.lastConnectedAt,
  };

  try {
    entries = await window.titanAPI.addressBook.add(payload);
    showToast(existing ? 'Đã cập nhật' : 'Đã thêm máy', 'success');
    modal.classList.remove('open');
    editingId = null;
    await renderAddressBookPage();
  } catch {
    showToast('Lỗi lưu', 'error');
  }
}
