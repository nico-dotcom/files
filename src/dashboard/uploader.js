/* ── State ─────────────────────────────────────────────────────────────────── */
// Master key kept in memory only — never persisted (sessionStorage/localStorage
// on a public origin is readable by any injected script, i.e. one XSS = key theft).
let masterKey = "";
let selectedFile = null;

/* ── DOM refs ───────────────────────────────────────────────────────────────── */
const authScreen   = document.getElementById("auth-screen");
const uploadScreen = document.getElementById("upload-screen");
const masterInput  = document.getElementById("master-input");
const dropZone     = document.getElementById("drop-zone");
const fileInput    = document.getElementById("file-input");
const fileInfo     = document.getElementById("file-info");
const expiryRadios = document.querySelectorAll('input[name="expiry"]');
const btnUpload    = document.getElementById("btn-upload");
const progressWrap = document.getElementById("progress-wrap");
const progressBar  = document.getElementById("progress-bar");
const progressLabel= document.getElementById("progress-label");
const resultWrap   = document.getElementById("result-wrap");
const resultUrl    = document.getElementById("result-url");
const resultExpiry = document.getElementById("result-expiry");
const btnCopy      = document.getElementById("btn-copy");
const btnNew       = document.getElementById("btn-new");
const toast        = document.getElementById("toast");

/* ── Toast ──────────────────────────────────────────────────────────────────── */
function showToast(msg, isErr = false) {
  toast.textContent = msg;
  toast.className = "show " + (isErr ? "err" : "ok");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.className = ""; }, 3000);
}

/* ── Auth ───────────────────────────────────────────────────────────────────── */
function login() {
  const val = masterInput.value.trim();
  if (!val) { showToast("Ingresá la master key", true); return; }
  masterKey = val;
  authScreen.style.display = "none";
  uploadScreen.style.display = "block";
}

if (masterKey) {
  authScreen.style.display = "none";
  uploadScreen.style.display = "block";
}

document.getElementById("btn-login").addEventListener("click", login);
masterInput.addEventListener("keydown", e => { if (e.key === "Enter") login(); });

/* ── File selection ─────────────────────────────────────────────────────────── */
function setFile(file) {
  if (!file) return;
  selectedFile = file;
  fileInfo.textContent = `${file.name}  ·  ${formatBytes(file.size)}`;
  fileInfo.style.display = "block";
  dropZone.classList.add("has-file");
  btnUpload.disabled = false;
}

dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => setFile(fileInput.files[0]));

dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  setFile(e.dataTransfer.files[0]);
});

/* ── Upload flow ────────────────────────────────────────────────────────────── */
btnUpload.addEventListener("click", doUpload);

async function doUpload() {
  if (!selectedFile) return;
  btnUpload.disabled = true;
  progressWrap.style.display = "block";
  resultWrap.style.display = "none";
  setProgress(0, "Preparando subida…");

  const checkedRadio = document.querySelector('input[name="expiry"]:checked');
  const expirySeconds = checkedRadio ? parseInt(checkedRadio.value, 10) : 86400;

  // 1. Get presigned PUT URL from server
  let startData;
  try {
    const r = await fetch("/admin/start-share", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + masterKey },
      body: JSON.stringify({ filename: selectedFile.name, mimeType: selectedFile.type || "application/octet-stream", sizeBytes: selectedFile.size }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText }));
      if (r.status === 403) { masterKey = ""; authScreen.style.display = "block"; uploadScreen.style.display = "none"; }
      throw new Error(err.error || "Error iniciando la subida");
    }
    startData = await r.json();
  } catch (e) {
    showToast(e.message, true);
    resetForm();
    return;
  }

  setProgress(10, "Subiendo archivo…");

  // 2. PUT file directly to MinIO via presigned URL
  try {
    await uploadWithProgress(startData.uploadUrl, selectedFile, (pct) => {
      setProgress(10 + Math.floor(pct * 0.8), `Subiendo… ${pct}%`);
    });
  } catch (e) {
    showToast("Error al subir el archivo: " + e.message, true);
    resetForm();
    return;
  }

  setProgress(92, "Confirmando…");

  // 3. Confirm upload and get download link
  let confirmData;
  try {
    const r = await fetch("/admin/confirm-share", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + masterKey },
      body: JSON.stringify({ objectKey: startData.objectKey, expirySeconds }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText }));
      throw new Error(err.error || "Error confirmando la subida");
    }
    confirmData = await r.json();
  } catch (e) {
    showToast(e.message, true);
    resetForm();
    return;
  }

  setProgress(100, "¡Listo!");

  // 4. Show result
  progressWrap.style.display = "none";
  resultUrl.value = confirmData.downloadUrl;
  const exp = new Date(confirmData.expiresAt);
  resultExpiry.textContent = `Caduca el ${exp.toLocaleString("es-AR", { dateStyle: "long", timeStyle: "short" })}`;
  resultWrap.style.display = "block";
  resultUrl.select();
}

function uploadWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.addEventListener("progress", e => {
      if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100));
    });
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Error de red"));
    xhr.send(file);
  });
}

/* ── Copy ───────────────────────────────────────────────────────────────────── */
btnCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(resultUrl.value);
    showToast("Link copiado al portapapeles");
  } catch {
    resultUrl.select();
    document.execCommand("copy");
    showToast("Link copiado");
  }
});

/* ── New upload ─────────────────────────────────────────────────────────────── */
btnNew.addEventListener("click", () => {
  resultWrap.style.display = "none";
  progressWrap.style.display = "none";
  resetForm();
});

function resetForm() {
  selectedFile = null;
  fileInput.value = "";
  fileInfo.style.display = "none";
  fileInfo.textContent = "";
  dropZone.classList.remove("has-file", "drag-over");
  btnUpload.disabled = true;
  progressWrap.style.display = "none";
}

function setProgress(pct, label) {
  progressBar.style.width = pct + "%";
  progressLabel.textContent = label;
}

/* ── Helpers ────────────────────────────────────────────────────────────────── */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
}
