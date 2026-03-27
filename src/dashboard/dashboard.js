// Dashboard logic — served as a static file to avoid unsafe-inline CSP
// Master key is kept in memory only (never localStorage/cookies).

let MASTER_KEY = '';
let CACHED_FOLDERS = [];
let EDIT_KEY_ID = null;

const API_BASE = window.location.origin;
document.getElementById('api-url-label').textContent = API_BASE;

// ── Auth ────────────────────────────────────────────────────────────────────
async function login() {
  const val = document.getElementById('master-input').value.trim();
  if (!val) return;
  const res = await apiFetch('/admin/keys', 'GET', null, val);
  if (res.ok) {
    MASTER_KEY = val;
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    renderKeys(res.data.keys);
    loadFolders();
  } else {
    toast('Master key inválida', 'err');
  }
}

// ── Fetch helper ─────────────────────────────────────────────────────────────
async function apiFetch(path, method, body, key) {
  const k = key || MASTER_KEY;
  try {
    const r = await fetch(API_BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: e.message } };
  }
}

// ── Folders ──────────────────────────────────────────────────────────────────
async function loadFolders() {
  const res = await apiFetch('/admin/folders', 'GET');
  if (res.ok) {
    CACHED_FOLDERS = res.data.folders || [];
    renderFolders(CACHED_FOLDERS);
    renderFolderCheckboxes('folder-checkboxes', CACHED_FOLDERS, []);
  } else {
    document.getElementById('folders-body').innerHTML =
      '<tr><td colspan="3" class="empty">Error al cargar carpetas: ' + (res.data?.error || res.status) + '</td></tr>';
  }
}

function renderFolders(folders) {
  const tbody = document.getElementById('folders-body');
  if (!folders || folders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">No hay carpetas todavía.</td></tr>';
    return;
  }
  const frag = document.createDocumentFragment();
  folders.forEach(f => {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    const code = document.createElement('code'); code.textContent = f.name; tdName.appendChild(code);
    const tdDate = document.createElement('td'); tdDate.style.color = 'var(--muted)'; tdDate.textContent = fmtDate(f.created_at);
    const tdAct = document.createElement('td');
    const btn = document.createElement('button'); btn.className = 'btn-danger'; btn.textContent = 'Eliminar';
    btn.dataset.folderId = f.id;
    btn.addEventListener('click', () => deleteFolder(f.id, f.name));
    tdAct.appendChild(btn);
    tr.append(tdName, tdDate, tdAct);
    frag.appendChild(tr);
  });
  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

/**
 * Render folder checkboxes into a container, pre-checking the given folder IDs.
 * Works for both the create form and the edit modal.
 */
function renderFolderCheckboxes(containerId, folders, checkedIds) {
  const container = document.getElementById(containerId);
  if (!folders || folders.length === 0) {
    container.innerHTML = '<span style="color:var(--muted);font-size:13px;">No hay carpetas creadas todavía.</span>';
    return;
  }
  const frag = document.createDocumentFragment();
  folders.forEach(f => {
    const label = document.createElement('label'); label.className = 'folder-checkbox-item';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.dataset.folderId = f.id;
    cb.checked = checkedIds.includes(f.id);
    const span = document.createElement('span'); span.textContent = f.name;
    label.append(cb, span); frag.appendChild(label);
  });
  container.innerHTML = '';
  container.appendChild(frag);
}

async function createFolderAction() {
  const nameInput = document.getElementById('f-folder-name');
  const name = nameInput.value.trim();
  if (!name) { toast('Ingresá un nombre de carpeta', 'err'); return; }
  const res = await apiFetch('/admin/folders', 'POST', { name });
  if (res.ok) {
    nameInput.value = '';
    toast('Carpeta creada', 'ok');
    loadFolders();
  } else {
    toast('Error: ' + (res.data.error || ''), 'err');
  }
}

async function deleteFolder(id, name) {
  if (!confirm('¿Eliminar la carpeta "' + name + '"? Las keys que la tenían asignada perderán acceso. Los archivos en MinIO no se borran.')) return;
  const res = await apiFetch('/admin/folders/' + encodeURIComponent(id), 'DELETE');
  if (res.ok) { toast('Carpeta eliminada', 'ok'); loadFolders(); loadKeys(); }
  else toast('Error: ' + (res.data.error || ''), 'err');
}

// ── Load / render keys ───────────────────────────────────────────────────────
async function loadKeys() {
  const res = await apiFetch('/admin/keys', 'GET');
  if (res.ok) renderKeys(res.data.keys);
  else toast('Error al cargar keys: ' + (res.data.error || ''), 'err');
}

function renderKeys(keys) {
  const tbody = document.getElementById('keys-body');
  if (!keys || keys.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">No hay keys todavía.</td></tr>';
    return;
  }
  const frag = document.createDocumentFragment();
  keys.forEach(k => {
    const tr = document.createElement('tr');
    if (!k.is_active) tr.style.opacity = '.55';

    // Name
    const tdName = document.createElement('td');
    const strong = document.createElement('strong'); strong.textContent = k.name;
    const small = document.createElement('span');
    small.style.cssText = 'color:var(--muted);font-size:11px';
    small.textContent = k.id.slice(0, 8) + '…';
    tdName.append(strong, document.createElement('br'), small);

    // Folders
    const tdFolders = document.createElement('td');
    const folders = k.folders || [];
    if (k.prefix === '*' && folders.length === 0) {
      const b = document.createElement('span'); b.className = 'badge badge-purple'; b.textContent = 'global'; tdFolders.appendChild(b);
    } else if (folders.length > 0) {
      folders.forEach(f => {
        const b = document.createElement('span'); b.className = 'badge badge-blue';
        b.textContent = f.name; b.style.marginRight = '4px'; tdFolders.appendChild(b);
      });
    } else {
      const code = document.createElement('code'); code.textContent = k.prefix; tdFolders.appendChild(code);
    }

    // Operations (+ can_delete indicator)
    const tdOps = document.createElement('td');
    const ops = k.can_upload && k.can_download ? 'Subir + Bajar' : k.can_upload ? 'Solo subir' : k.can_download ? 'Solo bajar' : '—';
    const b1 = document.createElement('span'); b1.className = 'badge badge-purple'; b1.textContent = ops; tdOps.appendChild(b1);
    if (k.can_delete) {
      const b2 = document.createElement('span'); b2.className = 'badge badge-red'; b2.textContent = 'Eliminar'; b2.style.marginLeft = '4px'; tdOps.appendChild(b2);
    }

    // Last used
    const tdLast = document.createElement('td');
    tdLast.textContent = k.last_used_at ? relTime(k.last_used_at) : 'Nunca';
    if (!k.last_used_at) tdLast.style.color = 'var(--muted)';

    // Expires
    const tdExp = document.createElement('td');
    if (k.expires_at) {
      tdExp.textContent = fmtDate(k.expires_at);
      tdExp.style.color = new Date(k.expires_at) < new Date() ? 'var(--danger)' : 'var(--muted)';
    } else {
      tdExp.textContent = '—'; tdExp.style.color = 'var(--muted)';
    }

    // Status
    const tdStatus = document.createElement('td');
    const sb = document.createElement('span'); sb.className = 'badge ' + (k.is_active ? 'badge-green' : 'badge-red');
    sb.textContent = k.is_active ? 'Activa' : 'Revocada'; tdStatus.appendChild(sb);

    // Actions
    const tdAct = document.createElement('td');
    if (k.is_active) {
      const btnEdit = document.createElement('button'); btnEdit.className = 'btn-edit'; btnEdit.textContent = 'Editar';
      btnEdit.addEventListener('click', () => openEditModal(k));
      const btnRenew = document.createElement('button'); btnRenew.className = 'btn-renew'; btnRenew.textContent = 'Renovar';
      btnRenew.addEventListener('click', () => renewKey(k.id));
      const btnRevoke = document.createElement('button'); btnRevoke.className = 'btn-danger'; btnRevoke.textContent = 'Revocar';
      btnRevoke.addEventListener('click', () => revokeKey(k.id));
      tdAct.append(btnEdit, btnRenew, btnRevoke);
    } else {
      const btnDel = document.createElement('button'); btnDel.className = 'btn-hard-del'; btnDel.textContent = 'Eliminar';
      btnDel.addEventListener('click', () => hardDeleteKey(k.id, k.name));
      tdAct.appendChild(btnDel);
    }

    tr.append(tdName, tdFolders, tdOps, tdLast, tdExp, tdStatus, tdAct);
    frag.appendChild(tr);
  });
  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

// ── Create key ───────────────────────────────────────────────────────────────
async function createKey() {
  const name      = document.getElementById('f-name').value.trim();
  const expires   = document.getElementById('f-expires').value;
  const ops       = document.getElementById('f-ops').value;
  const isGlobal  = document.getElementById('f-global').checked;
  const canDelete = document.getElementById('f-can-delete').checked;

  if (!name) { toast('Ingresá un nombre', 'err'); return; }

  let folder_ids = [];
  if (!isGlobal) {
    folder_ids = Array.from(document.querySelectorAll('#folder-checkboxes input[type=checkbox]:checked')).map(cb => cb.dataset.folderId);
    if (folder_ids.length === 0) { toast('Seleccioná al menos una carpeta, o marcá "Global"', 'err'); return; }
  }

  const res = await apiFetch('/admin/keys', 'POST', {
    name,
    prefix:       isGlobal ? '*' : 'folder-based',
    can_upload:   ops !== 'download',
    can_download: ops !== 'upload',
    can_delete:   canDelete,
    expires_at:   expires ? new Date(expires).toISOString() : null,
    folder_ids,
  });

  if (res.ok) {
    openKeyModal(res.data.key, '✓ Key creada exitosamente', 'Esta es la única vez que se muestra la key. Copiala ahora y guardala en un lugar seguro.');
    document.getElementById('f-name').value = '';
    document.getElementById('f-expires').value = '';
    document.getElementById('f-global').checked = true;
    document.getElementById('f-can-delete').checked = false;
    document.querySelectorAll('#folder-checkboxes input[type=checkbox]').forEach(cb => { cb.checked = false; });
    loadKeys();
  } else {
    toast('Error: ' + (res.data.error || 'desconocido'), 'err');
  }
}

// ── Revoke key ───────────────────────────────────────────────────────────────
async function revokeKey(id) {
  if (!confirm('¿Revocar esta key? Los clientes que la usen perderán acceso inmediatamente.')) return;
  const res = await apiFetch('/admin/keys/' + encodeURIComponent(id), 'DELETE');
  if (res.ok) { toast('Key revocada', 'ok'); loadKeys(); }
  else toast('Error: ' + (res.data.error || ''), 'err');
}

// ── Hard-delete revoked key ───────────────────────────────────────────────────
async function hardDeleteKey(id, name) {
  if (!confirm('¿Eliminar permanentemente la key "' + name + '"? No se puede deshacer.')) return;
  const res = await apiFetch('/admin/keys/' + encodeURIComponent(id) + '?hard=true', 'DELETE');
  if (res.ok) { toast('Key eliminada', 'ok'); loadKeys(); }
  else toast('Error: ' + (res.data.error || ''), 'err');
}

// ── Renew key ─────────────────────────────────────────────────────────────────
async function renewKey(id) {
  if (!confirm('¿Renovar esta key? Se generará una nueva con la misma configuración y la actual quedará revocada.')) return;
  const res = await apiFetch('/admin/keys/' + encodeURIComponent(id) + '/renew', 'POST', {});
  if (res.ok) {
    openKeyModal(res.data.key, '✓ Key renovada exitosamente', 'Nueva key generada. La anterior quedó revocada. Copiala ahora.');
    loadKeys();
  } else {
    toast('Error: ' + (res.data.error || ''), 'err');
  }
}

// ── Edit key modal ────────────────────────────────────────────────────────────
function openEditModal(k) {
  EDIT_KEY_ID = k.id;
  document.getElementById('edit-modal-name').textContent = k.name;

  const ops = k.can_upload && k.can_download ? 'both' : k.can_upload ? 'upload' : 'download';
  document.getElementById('edit-ops').value = ops;
  document.getElementById('edit-can-delete').checked = k.can_delete;

  if (k.expires_at) {
    // datetime-local expects "YYYY-MM-DDTHH:MM"
    document.getElementById('edit-expires').value = k.expires_at.slice(0, 16);
  } else {
    document.getElementById('edit-expires').value = '';
  }

  const folders = k.folders || [];
  const isGlobal = k.prefix === '*' && folders.length === 0;
  document.getElementById('edit-global').checked   = isGlobal;
  document.getElementById('edit-specific').checked = !isGlobal;
  renderFolderCheckboxes('edit-folder-checkboxes', CACHED_FOLDERS, folders.map(f => f.id));

  document.getElementById('edit-modal').classList.add('open');
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.remove('open');
  EDIT_KEY_ID = null;
}

async function saveEdit() {
  if (!EDIT_KEY_ID) return;
  const ops       = document.getElementById('edit-ops').value;
  const canDelete = document.getElementById('edit-can-delete').checked;
  const expires   = document.getElementById('edit-expires').value;
  const isGlobal  = document.getElementById('edit-global').checked;

  let folder_ids = [];
  if (!isGlobal) {
    folder_ids = Array.from(document.querySelectorAll('#edit-folder-checkboxes input:checked')).map(cb => cb.dataset.folderId);
    if (folder_ids.length === 0) { toast('Seleccioná al menos una carpeta, o marcá "Global"', 'err'); return; }
  }

  const res = await apiFetch('/admin/keys/' + encodeURIComponent(EDIT_KEY_ID), 'PUT', {
    can_upload:   ops !== 'download',
    can_download: ops !== 'upload',
    can_delete:   canDelete,
    expires_at:   expires ? new Date(expires).toISOString() : null,
    folder_ids,
  });

  if (res.ok) { toast('Key actualizada', 'ok'); closeEditModal(); loadKeys(); }
  else toast('Error: ' + (res.data.error || ''), 'err');
}

// ── Key display modal ─────────────────────────────────────────────────────────
function openKeyModal(key, title, desc) {
  document.getElementById('modal-title').textContent = title || '✓ Key creada exitosamente';
  document.getElementById('modal-desc').textContent  = desc  || '';
  document.getElementById('modal-key').textContent   = key;
  document.getElementById('modal').classList.add('open');
}
function closeModal() {
  document.getElementById('modal').classList.remove('open');
}
function copyKey() {
  const key = document.getElementById('modal-key').textContent;
  navigator.clipboard.writeText(key).then(() => toast('Copiado al portapapeles', 'ok'));
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function relTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'Hace un momento';
  if (m < 60) return 'Hace ' + m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return 'Hace ' + h + 'h';
  return 'Hace ' + Math.floor(h / 24) + 'd';
}
