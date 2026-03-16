import * as Minio from "minio";
import { env } from "./env";

/**
 * Internal client — used for operations that stay server-side:
 *   - bucketExists (startup check)
 *   - statObject   (confirm-upload verification)
 *
 * Connects to MinIO via the Docker internal network (e.g. service name "minio").
 */
export const minioClient = new Minio.Client({
  endPoint: env.S3_ENDPOINT,
  port: env.S3_PORT,
  useSSL: env.S3_USE_SSL,
  accessKey: env.S3_ACCESS_KEY,
  secretKey: env.S3_SECRET_KEY,
});

/**
 * Public client — used ONLY to generate presigned URLs.
 *
 * When S3_PUBLIC_URL is set (e.g. "https://storage.yourdomain.com"), this
 * client generates presigned URLs with that hostname so the browser can
 * reach MinIO directly through Cloudflare Tunnel.
 *
 * If S3_PUBLIC_URL is not set, falls back to the internal client.
 */
export const minioPublicClient: Minio.Client = (() => {
  if (!env.S3_PUBLIC_URL) return minioClient;

  const url = new URL(env.S3_PUBLIC_URL);
  const useSSL = url.protocol === "https:";
  const port = url.port
    ? parseInt(url.port, 10)
    : useSSL
    ? 443
    : 80;

  return new Minio.Client({
    endPoint: url.hostname,
    port,
    useSSL,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
  });
})();

/**
 * Verify the bucket exists and the client can reach MinIO.
 * Called once at startup.
 */
export async function verifyMinioBucket(): Promise<void> {
  const exists = await minioClient.bucketExists(env.S3_BUCKET);
  if (!exists) {
    throw new Error(
      `MinIO bucket "${env.S3_BUCKET}" does not exist. Create it first.`
    );
  }
  console.log(
    `✓ MinIO bucket "${env.S3_BUCKET}" verified`,
    env.S3_PUBLIC_URL
      ? `(presigned URLs will use ${env.S3_PUBLIC_URL})`
      : "(presigned URLs will use internal endpoint)"
  );
}
