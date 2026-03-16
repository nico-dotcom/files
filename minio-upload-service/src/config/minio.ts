import * as Minio from "minio";
import { env } from "./env";

export const minioClient = new Minio.Client({
  endPoint: env.S3_ENDPOINT,
  port: env.S3_PORT,
  useSSL: env.S3_USE_SSL,
  accessKey: env.S3_ACCESS_KEY,
  secretKey: env.S3_SECRET_KEY,
});

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
  console.log(`✓ MinIO bucket "${env.S3_BUCKET}" verified`);
}
