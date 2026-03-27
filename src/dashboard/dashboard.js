// Dashboard logic — served as a static file to avoid unsafe-inline CSP
// All communication to /admin/* uses the master key stored in memory only (never localStorage/cookies).

let MASTER_KEY = '';
let CACHED_FOLDERS = [];
const API_BASE = window.location.origin;

document.getElementById('api-url-label').textContent = API_BASE;
document.getElementById('master-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') login();
});

// ── Auth ────────────────────────────────────────────────────────────────────
async function login() {
  const val = document.getElementById('master-input').value.trim();
  if (!val) return;
  const res = await apiFetch('/admin/keys', 'GET', null, val);
  if (res.ok) {
    MASTER_KEY = val;
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    console.log('[login] calling renderKeys...');
    renderKeys(res.data.keys);
    console.log('[login] renderKeys done, calling loadFolders...');
    loadFolders();
    // Wire scope radio buttons after app is shown
    document.querySelectorAll('input[name="scope"]').forEach(radio => {
      radio.addEventListener('change', function() {
        document.getElementById('folder-select-wrapper').style.display =
          this.value === 'specific' ? 'block' : 'none';
      });
    });
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
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + k,
      },
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
  console.log('[folders] loadFolders() called');
  const res = await apiFetch('/admin/folders', 'GET');
  console.log('[folders] response:', res.ok, res.status, JSON.stringify(res.data));
  if (res.ok) {
    CACHED_FOLDERS = res.data.folders || [];
    renderFolders(CACHED_FOLDERS);
    renderFolderCheckboxes(CACHED_FOLDERS);
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
  const fragment = document.createDocumentFragment();
  folders.forEach(f => {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = f.name;
    tdName.appendChild(code);
    tr.appendChild(tdName);

    const tdDate = document.createElement('td');
    tdDate.style.color = 'var(--muted)';
    tdDate.textContent = fmtDate(f.created_at);
    tr.appendChild(tdDate);

    const tdAction = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'btn-danger';
    btn.textContent = 'Eliminar';
    btn.dataset.folderId = f.id;
    btn.addEventListener('click', () => deleteFolder(btn.dataset.folderId, f.name));
    tdAction.appendChild(btn);
    tr.appendChild(tdAction);

    fragment.appendChild(tr);
  });
  tbody.innerHTML = '';
  tbody.appendChild(fragment);
}

function renderFolderCheckboxes(folders) {
  const container = document.getElementById('folder-checkboxes');
  if (!folders || folders.length === 0) {
    container.innerHTML = '<span style="color:var(--muted);font-size:13px;">No hay carpetas creadas todavía.</span>';
    return;
  }
  const fragment = document.createDocumentFragment();
  folders.forEach(f => {
    const label = document.createElement('label');
    label.className = 'folder-checkbox-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.folderId = f.id;
    const span = document.createElement('span');
    span.textContent = f.name;
    label.appendChild(cb);
    label.appendChild(span);
    fragment.appendChild(label);
  });
  container.innerHTML = '';
  container.appendChild(fragment);
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

  const fragment = document.createDocumentFragment();
  keys.forEach(k => {
    const tr = document.createElement('tr');

    // Name cell
    const tdName = document.createElement('td');
    const strong = document.createElement('strong');
    strong.textContent = k.name;
    const small = document.createElement('span');
    small.style.cssText = 'color:var(--muted);font-size:11px';
    small.textContent = k.id.slice(0, 8) + '…';
    tdName.appendChild(strong);
    tdName.appendChild(document.createElement('br'));
    tdName.appendChild(small);
    tr.appendChild(tdName);

    // Folders cell
    const tdFolders = document.createElement('td');
    const folders = k.folders || [];
    if (k.prefix === '*' && folders.length === 0) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-purple';
      badge.textContent = 'global';
      tdFolders.appendChild(badge);
    } else if (folders.length > 0) {
      folders.forEach(f => {
        const badge = document.createElement('span');
        badge.className = 'badge badge-blue';
        badge.textContent = f.name;
        badge.style.marginRight = '4px';
        tdFolders.appendChild(badge);
      });
    } else {
      // Legacy prefix
      const code = document.createElement('code');
      code.textContent = k.prefix;
      tdFolders.appendChild(code);
    }
    tr.appendChild(tdFolders);

    // Operations cell
    const ops = k.can_upload && k.can_download ? 'Subir + Bajar'
              : k.can_upload   ? 'Solo subir'
              : k.can_download ? 'Solo bajar' : '—';
    const tdOps = document.createElement('td');
    const opsBadge = document.createElement('span');
    opsBadge.className = 'badge ' + (k.can_upload && k.can_download ? 'badge-purple' : 'badge-blue');
    opsBadge.textContent = ops;
    tdOps.appendChild(opsBadge);
    tr.appendChild(tdOps);

    // Last used
    const tdLast = document.createElement('td');
    tdLast.textContent = k.last_used_at ? relTime(k.last_used_at) : 'Nunca';
    if (!k.last_used_at) tdLast.style.color = 'var(--muted)';
    tr.appendChild(tdLast);

    // Expires
    const tdExp = document.createElement('td');
    if (k.expires_at) {
      tdExp.textContent = fmtDate(k.expires_at);
      tdExp.style.color = new Date(k.expires_at) < new Date() ? 'var(--danger)' : 'var(--muted)';
    } else {
      tdExp.textContent = '—';
      tdExp.style.color = 'var(--muted)';
    }
    tr.appendChild(tdExp);

    // Status
    const tdStatus = document.createElement('td');
    const statusBadge = document.createElement('span');
    statusBadge.className = 'badge ' + (k.is_active ? 'badge-green' : 'badge-red');
    statusBadge.textContent = k.is_active ? 'Activa' : 'Revocada';
    tdStatus.appendChild(statusBadge);
    tr.appendChild(tdStatus);

    // Action buttons
    const tdAction = document.createElement('td');
    if (k.is_active) {
      const btnRenew = document.createElement('button');
      btnRenew.className = 'btn-renew';
      btnRenew.textContent = 'Renovar';
      btnRenew.dataset.keyId = k.id;
      btnRenew.addEventListener('click', () => renewKey(btnRenew.dataset.keyId));
      tdAction.appendChild(btnRenew);

      const btnRevoke = document.createElement('button');
      btnRevoke.className = 'btn-danger';
      btnRevoke.textContent = 'Revocar';
      btnRevoke.dataset.keyId = k.id;
      btnRevoke.addEventListener('click', () => revokeKey(btnRevoke.dataset.keyId));
      tdAction.appendChild(btnRevoke);
    }
    tr.appendChild(tdAction);

    fragment.appendChild(tr);
  });

  tbody.innerHTML = '';
  tbody.appendChild(fragment);
}

// ── Create key ───────────────────────────────────────────────────────────────
async function createKey() {
  const name    = document.getElementById('f-name').value.trim();
  const expires = document.getElementById('f-expires').value;
  const ops     = document.getElementById('f-ops').value;
  const isGlobal = document.getElementById('f-global').checked; // radio "global"

  if (!name) { toast('Ingresá un nombre', 'err'); return; }

  let folder_ids = [];
  if (!isGlobal) {
    folder_ids = Array.from(
      document.querySelectorAll('#folder-checkboxes input[type=checkbox]:checked')
    ).map(cb => cb.dataset.folderId);

    if (folder_ids.length === 0) {
      toast('Seleccioná al menos una carpeta, o marcá "Acceso global"', 'err');
      return;
    }
  }

  const body = {
    name,
    prefix: isGlobal ? '*' : 'folder-based',
    can_upload:   ops !== 'download',
    can_download: ops !== 'upload',
    expires_at:   expires ? new Date(expires).toISOString() : null,
    folder_ids,
  };

  const res = await apiFetch('/admin/keys', 'POST', body);
  if (res.ok) {
    openModal(res.data.key);
    document.getElementById('f-name').value    = '';
    document.getElementById('f-expires').value = '';
    document.getElementById('f-global').checked = true;
    document.getElementById('folder-select-wrapper').style.display = 'none';
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

// ── Renew key ─────────────────────────────────────────────────────────────────
async function renewKey(id) {
  if (!confirm('¿Renovar esta key? Se generará una nueva key con la misma configuración y la actual quedará revocada.')) return;
  const res = await apiFetch('/admin/keys/' + encodeURIComponent(id) + '/renew', 'POST', {});
  if (res.ok) {
    openModal(res.data.key, '✓ Key renovada exitosamente', 'Nueva key generada. La anterior quedó revocada. Copiala ahora.');
    loadKeys();
  } else {
    toast('Error: ' + (res.data.error || ''), 'err');
  }
}

// ── Modal ────────────────────────────────────────────────────────────────────
function openModal(key, title, desc) {
  document.getElementById('modal-title').textContent = title || '✓ Key creada exitosamente';
  document.getElementById('modal-desc').textContent  = desc  || 'Esta es la única vez que se muestra la key. Copiala ahora y guardala en un lugar seguro.';
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
  if (m < 60) return `Hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Hace ${h}h`;
  return `Hace ${Math.floor(h / 24)}d`;
}
