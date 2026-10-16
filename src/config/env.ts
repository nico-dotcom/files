import dotenv from "dotenv";
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Require a secret env var and enforce a minimum length.
 * Prevents accidental use of placeholder values like "changeme".
 */
function requireSecret(key: string, minLength = 32): string {
  const value = requireEnv(key);
  if (value.length < minLength) {
    throw new Error(
      `Environment variable ${key} is too short (${value.length} chars). ` +
      `Minimum length is ${minLength} characters. ` +
      `Generate one with: openssl rand -hex 32`
    );
  }
  return value;
}

export const env = {
  PORT: parseInt(process.env.PORT || "3001", 10),

  // Master key for the admin dashboard — minimum 32 chars enforced
  MASTER_API_KEY: requireSecret("MASTER_API_KEY", 32),

  // MinIO
  S3_ENDPOINT: requireEnv("S3_ENDPOINT"),
  S3_PORT: parseInt(process.env.S3_PORT || "9000", 10),
  S3_USE_SSL: process.env.S3_USE_SSL === "true",
  S3_ACCESS_KEY: requireEnv("S3_ACCESS_KEY"),
  S3_SECRET_KEY: requireSecret("S3_SECRET_KEY", 16),
  S3_BUCKET: requireEnv("S3_BUCKET"),

  // Public-facing MinIO URL for presigned URL generation (used with Cloudflare Tunnel).
  // e.g. "https://storage.yourdomain.com"
  // If not set, presigned URLs will use the internal S3_ENDPOINT (localhost only).
  S3_PUBLIC_URL: process.env.S3_PUBLIC_URL || "",

  // Tailnet-facing MinIO URL (HTTPS, served by `tailscale serve`) for the DIRECT
  // fast-path upload. When the browser is on the tailnet it PUTs straight to MinIO
  // here — ~20× faster than the Cloudflare tunnel and with no 100MB body cap.
  // e.g. "https://raspberry-principal.tailaf751b.ts.net". Empty = no fast-path.
  S3_TAILNET_URL: process.env.S3_TAILNET_URL || "",

  // Presigned URL expiration in seconds (default: 15 minutes)
  PRESIGNED_URL_EXPIRY_SECONDS: parseInt(
    process.env.PRESIGNED_URL_EXPIRY_SECONDS || "900",
    10
  ),

  // Hasura
  HASURA_GRAPHQL_URL: requireEnv("HASURA_GRAPHQL_URL"),
  HASURA_ADMIN_SECRET: requireSecret("HASURA_ADMIN_SECRET", 16),

  // Max file size in bytes — overall hard cap, applies to the DIRECT tailnet path
  // (default: 2GB). The Cloudflare public path is capped separately below because
  // Cloudflare's free tier rejects request bodies over ~100MB.
  MAX_FILE_SIZE_BYTES: parseInt(
    process.env.MAX_FILE_SIZE_BYTES || String(2 * 1024 * 1024 * 1024),
    10
  ),

  // Max file size for the PUBLIC (Cloudflare) path. Cloudflare's free tier hard-caps
  // request bodies at ~100MB, so a bigger file can only go through the tailnet path.
  // The frontend uses this to block/redirect oversized uploads when off-tailnet.
  PUBLIC_MAX_FILE_SIZE_BYTES: parseInt(
    process.env.PUBLIC_MAX_FILE_SIZE_BYTES || String(100 * 1024 * 1024),
    10
  ),
};

// Remove the old API_KEY reference — keys are now managed in the DB.
// Delete this comment when refactoring is confirmed complete.
