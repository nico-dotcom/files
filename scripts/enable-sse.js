/**
 * Enable SSE-S3 default encryption at rest on the `files` bucket.
 *
 * MinIO already has a KMS master key loaded (MINIO_KMS_SECRET_KEY_FILE), so this
 * is transparent: every NEW object is encrypted on disk automatically, and
 * presigned PUT/GET keep working unchanged (MinIO encrypts/decrypts server-side).
 *
 * Run once:   node scripts/enable-sse.js
 * Verify:     node scripts/enable-sse.js --check
 *
 * NOTE: existing objects stay unencrypted until rewritten. To encrypt the
 * backlog, copy each object onto itself after enabling (mc: `mc cp --recursive
 * --attr "" local/files local/files`, or a copyObject loop).
 */
const path = require("path");
require(path.join(__dirname, "..", "node_modules", "dotenv")).config({
  path: path.join(__dirname, "..", ".env"),
});
const Minio = require(path.join(__dirname, "..", "node_modules", "minio"));

const client = new Minio.Client({
  endPoint: process.env.S3_ENDPOINT,
  port: parseInt(process.env.S3_PORT || "9000", 10),
  useSSL: process.env.S3_USE_SSL === "true",
  accessKey: process.env.S3_ACCESS_KEY,
  secretKey: process.env.S3_SECRET_KEY,
});
const bucket = process.env.S3_BUCKET;

(async () => {
  if (process.argv.includes("--check")) {
    try {
      const enc = await client.getBucketEncryption(bucket);
      console.log("Encryption ON:", JSON.stringify(enc));
    } catch (e) {
      console.log("Encryption OFF ->", e.code || e.message);
    }
    return;
  }
  // NOTE: call with NO config object — minio-js 7.1.3 mis-serialises a custom
  // { Rule:[{Apply:{SSEAlgorithm:'AES256'}}] } into an empty algorithm (verified:
  // objects were NOT encrypted on disk). The no-arg form applies the library's
  // correct SSE-S3/AES256 default, which encrypts new objects (verified on disk).
  await client.setBucketEncryption(bucket);
  const cfg = await client.getBucketEncryption(bucket);
  console.log(`✓ SSE-S3 default encryption enabled on bucket "${bucket}"`);
  console.log("  config:", JSON.stringify(cfg));
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
