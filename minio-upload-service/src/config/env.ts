import dotenv from "dotenv";
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const env = {
  PORT: parseInt(process.env.PORT || "3001", 10),

  // API authentication
  API_KEY: requireEnv("API_KEY"),

  // MinIO
  S3_ENDPOINT: requireEnv("S3_ENDPOINT"),
  S3_PORT: parseInt(process.env.S3_PORT || "9000", 10),
  S3_USE_SSL: process.env.S3_USE_SSL === "true",
  S3_ACCESS_KEY: requireEnv("S3_ACCESS_KEY"),
  S3_SECRET_KEY: requireEnv("S3_SECRET_KEY"),
  S3_BUCKET: requireEnv("S3_BUCKET"),

  // Public-facing MinIO URL for presigned URL generation (used with Cloudflare Tunnel).
  // e.g. "https://storage.yourdomain.com"
  // If not set, presigned URLs will use the internal S3_ENDPOINT (localhost only).
  S3_PUBLIC_URL: process.env.S3_PUBLIC_URL || "",

  // Presigned URL expiration in seconds (default: 15 minutes)
  PRESIGNED_URL_EXPIRY_SECONDS: parseInt(
    process.env.PRESIGNED_URL_EXPIRY_SECONDS || "900",
    10
  ),

  // Hasura
  HASURA_GRAPHQL_URL: requireEnv("HASURA_GRAPHQL_URL"),
  HASURA_ADMIN_SECRET: requireEnv("HASURA_ADMIN_SECRET"),

  // Max file size in bytes (default: 100MB)
  MAX_FILE_SIZE_BYTES: parseInt(
    process.env.MAX_FILE_SIZE_BYTES || String(100 * 1024 * 1024),
    10
  ),
};
