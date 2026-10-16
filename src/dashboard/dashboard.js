// Dashboard logic — served as a static file to avoid unsafe-inline CSP
// Master key is kept in memory only (never localStorage/cookies).

let MASTER_KEY = '';
let CACHED_FOLDERS = [];
let EDIT_KEY_ID = null;

// Escape untrusted text before interpolating into innerHTML templates.
// Filenames (original_filename) are attacker-controlled, so any value that
// reaches an innerHTML sink MUST pass through here to prevent stored XSS.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

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
    loadStats();
  } else {
    toast('Master key inválida', 'err');
  }
}

// ── Fetch helper ─────────────────────────────────────────────────────────────
async function apiFetch(path, method, body, key, timeoutMs = 20000) {
  const k = key || MASTER_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(API_BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    clearTimeout(timer);
    const msg = e.name === 'AbortError' ? 'Timeout (>20s)' : e.message;
    return { ok: false, status: 0, data: { error: msg } };
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

function fmtBytes(bytes) {
  if (bytes === undefined || bytes === null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function renderFolders(folders) {
  const tbody = document.getElementById('folders-body');
  if (!folders || folders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No hay carpetas todavía.</td></tr>';
    return;
  }
  const frag = document.createDocumentFragment();
  folders.forEach(f => {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    const code = document.createElement('code'); code.textContent = f.name; tdName.appendChild(code);

    const tdFiles = document.createElement('td');
    tdFiles.style.color = 'var(--muted)';
    tdFiles.textContent = f.file_count !== undefined ? f.file_count.toLocaleString('es-AR') : '—';

    const tdSize = document.createElement('td');
    tdSize.style.color = 'var(--muted)';
    tdSize.textContent = fmtBytes(f.size_bytes);

    const tdKeys = document.createElement('td');
    if (f.key_count > 0) {
      const b = document.createElement('span');
      b.className = 'badge badge-purple';
      b.textContent = f.key_count + (f.key_count === 1 ? ' clave' : ' claves');
      tdKeys.appendChild(b);
    } else {
      tdKeys.textContent = '—';
      tdKeys.style.color = 'var(--muted)';
    }

    const tdDate = document.createElement('td'); tdDate.style.color = 'var(--muted)'; tdDate.textContent = fmtDate(f.created_at);

    const tdAct = document.createElement('td');
    const btnView = document.createElement('button'); btnView.className = 'btn-files'; btnView.textContent = 'Ver archivos';
    btnView.addEventListener('click', () => openFilesModal(f));
    const btnDel = document.createElement('button'); btnDel.className = 'btn-danger'; btnDel.textContent = 'Eliminar';
    btnDel.dataset.folderId = f.id;
    btnDel.addEventListener('click', () => deleteFolder(f.id, f.name));
    tdAct.append(btnView, btnDel);

    tr.append(tdName, tdFiles, tdSize, tdKeys, tdDate, tdAct);
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

  const body = {
    name,
    can_upload:   ops !== 'download',
    can_download: ops !== 'upload',
    can_delete:   canDelete,
    expires_at:   expires ? new Date(expires).toISOString() : null,
    folder_ids,
  };
  if (isGlobal) body.prefix = '*';

  const res = await apiFetch('/admin/keys', 'POST', body);

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

// ── Stats section ─────────────────────────────────────────────────────────────
async function loadStats() {
  let res;
  try {
    res = await apiFetch('/admin/stats', 'GET');
  } catch (e) {
    document.getElementById('stats-spinner').textContent = 'Error al cargar estadísticas.';
    return;
  }
  if (res.status === 503) {
    // worker todavía calculando — reintenta en 3s
    setTimeout(loadStats, 3000);
    return;
  }
  if (!res.ok) {
    document.getElementById('stats-spinner').textContent = 'Error: ' + (res.data?.error || res.status);
    return;
  }
  try {
  const { overview, activity_30d, by_folder } = res.data;

  // Cards
  const cards = document.getElementById('stat-cards');
  cards.innerHTML = '';
  const cardData = [
    { label: 'Archivos activos', value: overview.total_files.toLocaleString('es-AR'), sub: fmtBytes(overview.total_size_bytes) + ' total', accent: true },
    { label: 'Eliminados', value: overview.deleted_files.toLocaleString('es-AR'), sub: 'registros' },
    { label: 'Carpetas', value: overview.total_folders.toLocaleString('es-AR'), sub: 'configuradas' },
    { label: 'Keys activas', value: overview.active_keys.toLocaleString('es-AR'), sub: 'con acceso' },
  ];
  cardData.forEach(c => {
    const div = document.createElement('div');
    div.className = 'stat-card' + (c.accent ? ' accent' : '');
    div.innerHTML = `<div class="label">${c.label}</div><div class="value">${c.value}</div><div class="sub">${c.sub}</div>`;
    cards.appendChild(div);
  });

  // Activity chart
  renderActivityChart(activity_30d);

  // Folder bars
  renderFolderBars(by_folder, overview.total_size_bytes);

  // Largest files
  renderLargestFiles(overview.largest_files);

  document.getElementById('stats-spinner').style.display = 'none';
  document.getElementById('stats-content').style.display = 'block';
  } catch (e) {
    document.getElementById('stats-spinner').textContent = 'Error al renderizar: ' + e.message;
    console.error('[stats] render error:', e);
  }
}

function renderActivityChart(activity) {
  const chart = document.getElementById('activity-chart');
  chart.innerHTML = '';
  if (!activity || activity.length === 0) {
    document.getElementById('activity-empty').style.display = 'block';
    return;
  }

  // Fill missing days for last 30 days
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const found = activity.find(a => a.date === d) || { date: d, upload_count: 0, download_count: 0 };
    days.push(found);
  }

  const maxVal = Math.max(1, ...days.map(d => Math.max(d.upload_count, d.download_count)));

  days.forEach(d => {
    const col = document.createElement('div');
    col.className = 'bar-day';
    col.title = `${d.date}\nSubidas: ${d.upload_count}\nDescargas: ${d.download_count}`;

    const upH = Math.round((d.upload_count / maxVal) * 64);
    const dlH = Math.round((d.download_count / maxVal) * 64);

    const up = document.createElement('div'); up.className = 'bar uploads'; up.style.height = upH + 'px';
    const dl = document.createElement('div'); dl.className = 'bar downloads'; dl.style.height = dlH + 'px';

    const showTick = d.date.slice(8) === '01' || d.date === days[0].date || d.date === days[days.length - 1].date;
    const tick = document.createElement('div'); tick.className = 'tick';
    tick.textContent = showTick ? d.date.slice(5) : '';

    col.append(up, dl, tick);
    chart.appendChild(col);
  });
}

function renderFolderBars(folders, totalBytes) {
  const container = document.getElementById('folder-bars');
  container.innerHTML = '';
  if (!folders || folders.length === 0) {
    container.textContent = 'Sin carpetas configuradas.';
    return;
  }
  const maxBytes = Math.max(1, ...folders.map(f => f.size_bytes));
  folders.forEach(f => {
    const pct = totalBytes > 0 ? ((f.size_bytes / totalBytes) * 100).toFixed(1) : '0';
    const barW = Math.round((f.size_bytes / maxBytes) * 100);
    const row = document.createElement('div'); row.className = 'folder-bar-row';
    row.innerHTML = `
      <span class="folder-bar-name" title="${esc(f.name)}">${esc(f.name)}</span>
      <div class="folder-bar-fill"><div style="width:${barW}%"></div></div>
      <span class="folder-bar-meta">${f.file_count} archivos · ${fmtBytes(f.size_bytes)} (${pct}%)</span>
    `;
    container.appendChild(row);
  });
}

function renderLargestFiles(files) {
  const tbody = document.getElementById('largest-files-body');
  tbody.innerHTML = '';
  if (!files || files.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">Sin archivos.</td></tr>';
    return;
  }
  const maxSize = files[0]?.size_bytes || 1;
  files.forEach(f => {
    const barW = Math.round((f.size_bytes / maxSize) * 100);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="padding:10px 12px;border-bottom:1px solid var(--border);">
        <span class="file-name">${esc(f.original_filename)}</span>
        <div style="margin-top:4px;height:3px;background:var(--bg);border-radius:2px;overflow:hidden;">
          <div style="height:100%;width:${barW}%;background:var(--primary);border-radius:2px;"></div>
        </div>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid var(--border);color:var(--muted);white-space:nowrap;">${fmtBytes(f.size_bytes)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid var(--border);">
        <span class="badge badge-blue">${esc(f.mime_type || '—')}</span>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid var(--border);color:var(--muted);">${fmtDate(f.created_at)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ── Files modal ───────────────────────────────────────────────────────────────
let CURRENT_FOLDER = null;

async function openFilesModal(folder) {
  CURRENT_FOLDER = folder;
  document.getElementById('files-modal-title').textContent = folder.name;
  document.getElementById('files-modal-subtitle').textContent = 'Cargando archivos…';
  document.getElementById('files-modal-tbody').innerHTML =
    '<tr><td colspan="5" class="empty"><span class="spinner"></span> Cargando...</td></tr>';
  document.getElementById('files-modal').classList.add('open');
  await loadFolderFiles(folder.name);
}

function closeFilesModal() {
  document.getElementById('files-modal').classList.remove('open');
  CURRENT_FOLDER = null;
}

async function loadFolderFiles(folderName) {
  const res = await apiFetch('/admin/files?folder=' + encodeURIComponent(folderName), 'GET');
  if (!res.ok) {
    document.getElementById('files-modal-tbody').innerHTML =
      '<tr><td colspan="5" class="empty">Error al cargar archivos</td></tr>';
    return;
  }
  const files = res.data.files || [];
  const subtitle = files.length === 0
    ? 'Sin archivos'
    : files.length + (files.length === 1 ? ' archivo' : ' archivos') +
      ' · ' + fmtBytes(files.reduce((s, f) => s + (f.size_bytes || 0), 0));
  document.getElementById('files-modal-subtitle').textContent = subtitle;
  renderFolderFiles(files);
}

function renderFolderFiles(files) {
  const tbody = document.getElementById('files-modal-tbody');
  if (!files || files.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Esta carpeta está vacía.</td></tr>';
    return;
  }
  const frag = document.createDocumentFragment();
  files.forEach(f => {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    const nameSpan = document.createElement('span'); nameSpan.className = 'file-name'; nameSpan.textContent = f.original_filename; nameSpan.title = f.original_filename;
    const keySpan  = document.createElement('span'); keySpan.className  = 'file-key';  keySpan.textContent  = f.object_key;        keySpan.title = f.object_key;
    tdName.append(nameSpan, keySpan);

    const tdSize = document.createElement('td'); tdSize.style.color = 'var(--muted)'; tdSize.textContent = fmtBytes(f.size_bytes);
    const tdMime = document.createElement('td');
    const mb = document.createElement('span'); mb.className = 'badge badge-blue'; mb.textContent = f.mime_type || '—'; tdMime.appendChild(mb);
    const tdDate = document.createElement('td'); tdDate.style.color = 'var(--muted)'; tdDate.textContent = fmtDate(f.created_at);

    const tdAct = document.createElement('td');
    const btnDel = document.createElement('button'); btnDel.className = 'btn-danger'; btnDel.textContent = 'Eliminar';
    btnDel.addEventListener('click', () => deleteFileFromModal(f.id));
    tdAct.appendChild(btnDel);

    tr.append(tdName, tdSize, tdMime, tdDate, tdAct);
    frag.appendChild(tr);
  });
  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

async function deleteFileFromModal(id) {
  if (!confirm('¿Eliminar este archivo? Se borra de la base de datos y de MinIO.')) return;
  const res = await apiFetch('/admin/files/' + encodeURIComponent(id), 'DELETE');
  if (res.ok) {
    toast('Archivo eliminado', 'ok');
    if (CURRENT_FOLDER) {
      await loadFolderFiles(CURRENT_FOLDER.name);
      loadFolders(); // refresca stats de la tabla
    }
  } else {
    toast('Error: ' + (res.data?.error || ''), 'err');
  }
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
