// API Test page — API key kept in memory only, never written to localStorage/cookies.

const API_BASE = window.location.origin;
let API_KEY = '';
let USER_ID = '';

// Generate a random UUID for the session user ID
function uuidv4() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}
document.getElementById('user-id-input').value = uuidv4();

// ── Log ────────────────────────────────────────────────────────────────────────
function log(msg, type = 'info') {
  const container = document.getElementById('log');
  // Remove the placeholder on first real entry
  const placeholder = container.querySelector('.line-muted');
  if (placeholder && placeholder.textContent === 'Esperando…') placeholder.remove();
  const span = document.createElement('span');
  span.className = 'line-' + type;
  span.textContent = new Date().toLocaleTimeString('es-AR') + '  ' + msg;
  container.appendChild(span);
  container.scrollTop = container.scrollHeight;
}

// ── Toast ──────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3000);
}

// ── Fetch helper ───────────────────────────────────────────────────────────────
async function apiFetch(path, method, body) {
  const r = await fetch(API_BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// ── Connect ────────────────────────────────────────────────────────────────────
document.getElementById('api-key-input').addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
document.getElementById('btn-connect').addEventListener('click', connect);

async function connect() {
  const key = document.getElementById('api-key-input').value.trim();
  const uid = document.getElementById('user-id-input').value.trim();
  if (!key) { toast('Ingresá una API key', 'err'); return; }
  if (!uid) { toast('Ingresá un User ID', 'err'); return; }

  const statusEl = document.getElementById('connect-status');
  statusEl.textContent = 'Verificando…';

  // Probe with a dummy health-like call — we'll try /create-download-url with a fake ID
  // to see if the key authenticates at all (expecting 400/404/422, not 401/403)
  const res = await apiFetch('/create-download-url', 'POST', { fileId: '00000000-0000-0000-0000-000000000000' });
  const authOk = res.status !== 401 && res.status !== 403;

  if (!authOk) {
    statusEl.textContent = '✗ Key inválida o revocada';
    statusEl.style.color = 'var(--danger)';
    log('Autenticación fallida: ' + (res.data.error || res.status), 'err');
    return;
  }

  API_KEY = key;
  USER_ID = uid;
  statusEl.textContent = '✓ Conectado';
  statusEl.style.color = 'var(--success)';

  document.getElementById('upload-card').style.opacity = '1';
  document.getElementById('upload-card').style.pointerEvents = 'auto';
  document.getElementById('api-key-input').value = '';  // clear from DOM immediately

  log('Conectado. Key válida (permisos comprobados por el servidor en cada operación).', 'ok');
}

// ── Upload ─────────────────────────────────────────────────────────────────────
document.getElementById('btn-upload').addEventListener('click', upload);

async function upload() {
  if (!API_KEY) { toast('Conectá primero', 'err'); return; }
  const fileInput = document.getElementById('file-input');
  const file = fileInput.files[0];
  if (!file) { toast('Seleccioná un archivo', 'err'); return; }
  const folder = document.getElementById('folder-input').value.trim() || undefined;

  const btn = document.getElementById('btn-upload');
  btn.disabled = true;
  setProgress(0, 'Iniciando…');

  log('Iniciando subida: ' + file.name + ' (' + fmtBytes(file.size) + ')', 'info');

  // Step 1 — get presigned URL
  const init = await apiFetch('/create-upload', 'POST', {
    filename:  file.name,
    mimeType:  file.type || 'application/octet-stream',
    sizeBytes: file.size,
    userId:    USER_ID,
    folder,
  });

  if (!init.ok) {
    log('✗ create-upload: ' + (init.data.error || init.status), 'err');
    toast('Error al iniciar subida: ' + (init.data.error || ''), 'err');
    btn.disabled = false;
    hideProgress();
    return;
  }

  const { fileId, uploadUrl } = init.data;
  log('✓ Presigned URL obtenida. fileId: ' + fileId, 'ok');
  setProgress(20, 'URL generada, subiendo…');

  // Step 2 — PUT the file to MinIO directly
  let putOk = false;
  try {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) {
          const pct = 20 + Math.floor((e.loaded / e.total) * 60);
          setProgress(pct, 'Subiendo… ' + Math.floor(e.loaded / e.total * 100) + '%');
        }
      });
      xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) resolve(); else reject(new Error('PUT ' + xhr.status)); };
      xhr.onerror = () => reject(new Error('Error de red'));
      xhr.send(file);
    });
    putOk = true;
  } catch (err) {
    log('✗ PUT a MinIO falló: ' + err.message, 'err');
    toast('Error al subir a MinIO: ' + err.message, 'err');
  }

  if (!putOk) { btn.disabled = false; hideProgress(); return; }

  log('✓ Archivo en MinIO.', 'ok');
  setProgress(85, 'Confirmando…');

  // Step 3 — confirm
  const confirm = await apiFetch('/confirm-upload', 'POST', { fileId });
  if (!confirm.ok) {
    log('✗ confirm-upload: ' + (confirm.data.error || confirm.status), 'err');
    toast('Subida a MinIO exitosa pero confirmación falló: ' + (confirm.data.error || ''), 'err');
    btn.disabled = false;
    hideProgress();
    return;
  }

  setProgress(100, '¡Listo!');
  log('✓ Subida confirmada. status=' + confirm.data.status, 'ok');
  toast('Archivo subido exitosamente', 'ok');

  addFileToList({ fileId, name: file.name, size: file.size, mime: file.type });
  fileInput.value = '';
  btn.disabled = false;
  setTimeout(hideProgress, 800);
}

// ── File list ──────────────────────────────────────────────────────────────────
const SESSION_FILES = [];

function addFileToList(info) {
  SESSION_FILES.push(info);
  const card = document.getElementById('files-card');
  card.style.display = 'block';
  const list = document.getElementById('file-list');

  const item = document.createElement('div');
  item.className = 'file-item';
  item.id = 'file-' + info.fileId;

  const icon = document.createElement('div');
  icon.className = 'file-icon';
  icon.textContent = mimeIcon(info.mime);

  const infoDiv = document.createElement('div');
  infoDiv.className = 'file-info';
  const name = document.createElement('div'); name.className = 'name'; name.textContent = info.name;
  const meta = document.createElement('div'); meta.className = 'meta';
  meta.textContent = fmtBytes(info.size) + ' · ' + (info.mime || '?') + ' · ID: ' + info.fileId;
  infoDiv.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'file-actions';

  const btnView = document.createElement('button');
  btnView.className = 'btn-success'; btnView.textContent = 'Ver';
  btnView.addEventListener('click', () => viewFile(info.fileId));

  const btnDel = document.createElement('button');
  btnDel.className = 'btn-danger'; btnDel.textContent = 'Eliminar';
  btnDel.addEventListener('click', () => deleteFile(info.fileId, info.name, btnDel));

  actions.append(btnView, btnDel);
  item.append(icon, infoDiv, actions);
  list.appendChild(item);
}

async function viewFile(fileId) {
  log('Obteniendo URL de descarga para ' + fileId + '…', 'info');
  const res = await apiFetch('/create-download-url', 'POST', { fileId });
  if (!res.ok) {
    log('✗ create-download-url: ' + (res.data.error || res.status), 'err');
    toast('Error: ' + (res.data.error || ''), 'err');
    return;
  }
  log('✓ URL generada. Abriendo…', 'ok');
  window.open(res.data.downloadUrl, '_blank');
}

async function deleteFile(fileId, name, btn) {
  if (!confirm('¿Eliminar "' + name + '"? Esta acción no se puede deshacer.')) return;
  log('Eliminando ' + fileId + '…', 'info');
  const res = await apiFetch('/files/' + encodeURIComponent(fileId), 'DELETE');
  if (!res.ok) {
    log('✗ delete: ' + (res.data.error || res.status), 'err');
    toast('Error al eliminar: ' + (res.data.error || ''), 'err');
    return;
  }
  log('✓ Archivo eliminado.', 'ok');
  toast('Archivo eliminado', 'ok');
  const item = document.getElementById('file-' + fileId);
  if (item) { item.classList.add('deleted'); item.querySelectorAll('button').forEach(b => b.disabled = true); }
}

// ── Progress ───────────────────────────────────────────────────────────────────
function setProgress(pct, label) {
  document.getElementById('progress-wrap').classList.add('show');
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-label').textContent = label;
}
function hideProgress() {
  document.getElementById('progress-wrap').classList.remove('show');
  document.getElementById('progress-fill').style.width = '0%';
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}

function mimeIcon(mime) {
  if (!mime) return '📄';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('video/')) return '🎥';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.includes('pdf')) return '📕';
  if (mime.includes('zip') || mime.includes('archive')) return '🗜️';
  if (mime.includes('json') || mime.includes('text')) return '📝';
  return '📄';
}
