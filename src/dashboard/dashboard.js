// Dashboard logic — served as a static file to avoid unsafe-inline CSP
// All communication to /admin/* uses the master key stored in memory only (never localStorage/cookies).

let MASTER_KEY = '';
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
    renderKeys(res.data.keys);
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

  // Build rows using DOM methods — no innerHTML with unsanitized data
  const fragment = document.createDocumentFragment();
  keys.forEach(k => {
    const tr = document.createElement('tr');

    // Name cell
    const tdName = document.createElement('td');
    const strong = document.createElement('strong');
    strong.textContent = k.name;                   // textContent = safe from XSS
    const small = document.createElement('span');
    small.style.cssText = 'color:var(--muted);font-size:11px';
    small.textContent = k.id.slice(0, 8) + '…';
    tdName.appendChild(strong);
    tdName.appendChild(document.createElement('br'));
    tdName.appendChild(small);
    tr.appendChild(tdName);

    // Prefix cell
    const tdPrefix = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = k.prefix;                   // textContent = safe
    tdPrefix.appendChild(code);
    if (k.prefix === '*') {
      const badge = document.createElement('span');
      badge.className = 'badge badge-purple';
      badge.textContent = ' global';
      tdPrefix.appendChild(badge);
    }
    tr.appendChild(tdPrefix);

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
    tdLast.textContent = k.last_used_at ? relTime(k.last_used_at) : '';
    if (!k.last_used_at) {
      tdLast.style.color = 'var(--muted)';
      tdLast.textContent = 'Nunca';
    }
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
  const prefix  = document.getElementById('f-prefix').value.trim();
  const expires = document.getElementById('f-expires').value;
  const ops     = document.getElementById('f-ops').value;

  if (!name)   { toast('Ingresá un nombre', 'err'); return; }
  if (!prefix) { toast('Ingresá un prefijo ("*" para todo)', 'err'); return; }
  if (prefix !== '*' && !prefix.endsWith('/')) {
    toast('El prefijo debe terminar en "/" (ej: "infopublica/")', 'err'); return;
  }

  const body = {
    name,
    prefix,
    can_upload:   ops !== 'download',
    can_download: ops !== 'upload',
    expires_at:   expires ? new Date(expires).toISOString() : null,
  };

  const res = await apiFetch('/admin/keys', 'POST', body);
  if (res.ok) {
    openModal(res.data.key);
    document.getElementById('f-name').value    = '';
    document.getElementById('f-prefix').value  = '*';
    document.getElementById('f-expires').value = '';
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
