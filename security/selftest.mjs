// Security self-test / regression suite for minio-upload-service.
//
// Encodes the authorized pentest as non-destructive, self-cleaning assertions.
// Run:   node security/selftest.mjs
// Exits 0 if every protection holds, 1 if any assertion fails, 2 if refused.
//
// SCOPE GUARD: only runs against your own host (localhost / *.nicolasrusso.ar)
// and only if security/PENTEST-AUTHORIZATION.md exists.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const APP = "/home/nicolas/files";
require(path.join(APP, "node_modules/dotenv")).config({ path: path.join(APP, ".env") });
const Minio = require(path.join(APP, "node_modules/minio"));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SELFTEST_TARGET || "http://localhost:3002";
const DATA_DIR = process.env.SELFTEST_DATADIR || "/mnt/m2/minio/data";
const AUTH_DOC = path.join(HERE, "PENTEST-AUTHORIZATION.md");

// ── Scope guard ───────────────────────────────────────────────────────────────
function refuse(msg) { console.error("REFUSED: " + msg); process.exit(2); }
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(BASE) &&
    !/^https?:\/\/[a-z0-9.-]+\.nicolasrusso\.ar(\/|$)/.test(BASE)) {
  refuse(`target ${BASE} is not an owned host (localhost / *.nicolasrusso.ar).`);
}
if (!fs.existsSync(AUTH_DOC)) refuse(`missing authorization doc ${AUTH_DOC}.`);

// ── Config ────────────────────────────────────────────────────────────────────
const MK = process.env.MASTER_API_KEY;
const BUCKET = process.env.S3_BUCKET;
const MAX = parseInt(process.env.MAX_FILE_SIZE_BYTES || "104857600", 10);
const UID = "00000000-0000-4000-a000-0000000000ff";
const minio = new Minio.Client({
  endPoint: process.env.S3_ENDPOINT, port: parseInt(process.env.S3_PORT || "9000", 10),
  useSSL: process.env.S3_USE_SSL === "true",
  accessKey: process.env.S3_ACCESS_KEY, secretKey: process.env.S3_SECRET_KEY,
});

const RUN = Date.now().toString(36);
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`  ${pass ? "\x1b[32m✓ PASS\x1b[0m" : "\x1b[31m✗ FAIL\x1b[0m"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function api(method, p, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* no body */ }
  return { status: r.status, body: j };
}

const created = { folders: [], keys: [], fileIds: [], objectKeys: [] };
async function makeFolder(name) {
  const r = await api("POST", "/admin/folders", { token: MK, body: { name } });
  const id = r.body?.folder?.id; if (id) created.folders.push(id);
  return { id, name: r.body?.folder?.name || name };
}
async function makeScopedKey(folderIds) {
  const r = await api("POST", "/admin/keys", { token: MK, body: { name: "SELFTEST-" + RUN, can_upload: true, can_download: true, folder_ids: folderIds } });
  if (r.body?.id) created.keys.push(r.body.id);
  return r.body.key;
}
async function makeUploadedFile(folderName) {
  const r = await api("POST", "/create-upload", { token: MK, body: { filename: "probe.png", mimeType: "image/png", sizeBytes: 5, userId: UID, folder: folderName } });
  const { fileId, objectKey } = r.body;
  await minio.putObject(BUCKET, objectKey, Buffer.from("PROBE"));
  created.fileIds.push(fileId); created.objectKeys.push(objectKey);
  await api("POST", "/confirm-upload", { token: MK, body: { fileId } });
  return { fileId, objectKey };
}

async function main() {
  console.log(`\n== minio-upload-service · security self-test (run ${RUN}) ==\n`);

  // ── Authentication / authorization ──
  check("admin requires auth (no token → 403)", (await api("GET", "/admin/keys")).status === 403);
  check("admin accepts master key (→ 200)", (await api("GET", "/admin/keys", { token: MK })).status === 200);
  check("api requires a key (create-download-url no token → 401)", (await api("POST", "/create-download-url", { body: { fileId: UID } })).status === 401);

  const fA = await makeFolder("selftest-a-" + RUN);
  const fB = await makeFolder("selftest-b-" + RUN);
  const scoped = await makeScopedKey([fA.id]);

  // ── Input validation (XSS / type / size) ──
  check("filename with <> rejected (→ 400)", (await api("POST", "/create-upload", { token: scoped, body: { filename: "<img onerror=x>.png", mimeType: "image/png", sizeBytes: 5, userId: UID, folder: fA.name } })).status === 400);
  check("svg mime-type rejected (→ 400)", (await api("POST", "/create-upload", { token: scoped, body: { filename: "x.svg", mimeType: "image/svg+xml", sizeBytes: 5, userId: UID, folder: fA.name } })).status === 400);
  check("oversized declared size rejected (→ 400)", (await api("POST", "/create-upload", { token: scoped, body: { filename: "big.png", mimeType: "image/png", sizeBytes: MAX + 1, userId: UID, folder: fA.name } })).status === 400);

  // ── Access control / tenant isolation ──
  const fileA = await makeUploadedFile(fA.name);
  const fileB = await makeUploadedFile(fB.name);
  const own = await api("POST", "/create-download-url", { token: scoped, body: { fileId: fileA.fileId } });
  check("scoped key CAN reach its own folder (→ 200)", own.status === 200);
  check("scoped key CANNOT reach another folder (→ 403)", (await api("POST", "/create-download-url", { token: scoped, body: { fileId: fileB.fileId } })).status === 403);

  // ── Download hardening ──
  check("image download served inline (disposition)", typeof own.body?.downloadUrl === "string" && /disposition=inline/i.test(decodeURIComponent(own.body.downloadUrl)));

  // ── Encryption at rest ──
  const encKey = `selftest/${RUN}/enc.txt`;
  await minio.putObject(BUCKET, encKey, Buffer.from("ENC-" + RUN));
  created.objectKeys.push(encKey);
  let encPass = false, encDetail = "";
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, BUCKET, encKey, "xl.meta"));
    encPass = raw.includes(Buffer.from("Server-Side-Encryption")) || raw.includes(Buffer.from("Sealed-Key"));
  } catch (e) { encDetail = "xl.meta unreadable: " + e.code; }
  check("new object encrypted at rest (xl.meta markers)", encPass, encDetail);

  // ── Storage exposure ──
  let anon = 0; try { anon = (await fetch(`http://localhost:9000/${BUCKET}/`)).status; } catch { /* */ }
  check("bucket not anonymously listable (→ 403)", anon === 403, "got " + anon);

  // ── Dashboard output escaping ──
  let dash = ""; try { dash = await (await fetch(BASE + "/static/dashboard.js")).text(); } catch { /* */ }
  check("dashboard defines esc() helper", /function esc\s*\(/.test(dash));
  check("dashboard escapes original_filename", /esc\(\s*f\.original_filename/.test(dash));

  // ── Secret file permissions ──
  const mode = (fs.statSync(path.join(APP, ".env")).mode & 0o777).toString(8);
  check(".env is chmod 600", mode === "600", "mode " + mode);

  // ── Cleanup ──
  for (const fid of created.fileIds) await api("DELETE", "/admin/files/" + fid, { token: MK }).catch(() => {});
  for (const k of created.objectKeys) await minio.removeObject(BUCKET, k).catch(() => {});
  for (const kid of created.keys) await api("DELETE", `/admin/keys/${kid}?hard=true`, { token: MK }).catch(() => {});
  for (const fid of created.folders) await api("DELETE", "/admin/folders/" + fid, { token: MK }).catch(() => {});

  const failed = results.filter((r) => !r.pass);
  console.log(`\n== ${results.length - failed.length}/${results.length} passed ==`);
  if (failed.length) { console.log("\x1b[31mFAILED:\x1b[0m " + failed.map((f) => f.name).join("; ")); process.exit(1); }
  console.log("\x1b[32mAll security assertions hold.\x1b[0m ✓");
}

main().catch((e) => { console.error("self-test error:", e); process.exit(3); });
