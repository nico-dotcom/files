import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { promisify } from "util";
import { minioClient, minioPublicClient, minioTailnetClient } from "../../config/minio";
import { env } from "../../config/env";
import { safeEqual } from "../../utils/crypto";

const router = Router();

const VALID_EXPIRY_SECONDS = [3600, 21600, 86400, 259200, 604800]; // 1h 6h 24h 3d 7d

// Tamaño de parte para subidas multipart. Bajo los ~100MB que Cloudflare corta en
// el body de un request, con headroom. Cada parte es un PUT presignado independiente,
// así un archivo grande entra por el path público en trozos <100MB.
const MP_PART_SIZE = 90 * 1024 * 1024;

// completeMultipartUpload es callback-based en minio-js 7.x → lo promisificamos.
const mc = minioClient as unknown as {
  initiateNewMultipartUpload: (b: string, o: string, h: Record<string, string>) => Promise<string>;
  listParts: (b: string, o: string, id: string) => Promise<Array<{ part: number; etag: string }>>;
  abortMultipartUpload: (b: string, o: string, id: string) => Promise<void>;
  completeMultipartUpload: (b: string, o: string, id: string, etags: Array<{ part: number; etag: string }>, cb: (err: unknown, r: unknown) => void) => void;
};
const completeMultipart = promisify(mc.completeMultipartUpload).bind(mc) as
  (b: string, o: string, id: string, etags: Array<{ part: number; etag: string }>) => Promise<unknown>;

function requireMaster(req: Request, res: Response): boolean {
  const master = process.env.MASTER_API_KEY;
  if (!master) { res.status(503).json({ error: "MASTER_API_KEY not configured" }); return false; }
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!safeEqual(token, master)) { res.status(403).json({ error: "Master key required" }); return false; }
  return true;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._()-]/g, "_").slice(0, 200);
}

/**
 * GET /admin/upload-config
 * Returns upload routing info so the frontend can pick the fast path and enforce
 * the right size cap without hardcoding anything.
 */
router.get("/admin/upload-config", (req: Request, res: Response): void => {
  if (!requireMaster(req, res)) return;
  res.json({
    tailnetUrl: env.S3_TAILNET_URL || null,
    publicMaxBytes: env.PUBLIC_MAX_FILE_SIZE_BYTES,
    maxBytes: env.MAX_FILE_SIZE_BYTES,
  });
});

/**
 * POST /admin/start-share
 * Body: { filename, mimeType, sizeBytes }
 * Returns: { objectKey, uploadUrl, uploadUrlDirect, publicMaxBytes, maxBytes }
 */
router.post("/admin/start-share", async (req: Request, res: Response): Promise<void> => {
  if (!requireMaster(req, res)) return;

  const { filename, mimeType, sizeBytes } = req.body as {
    filename?: string;
    mimeType?: string;
    sizeBytes?: number;
  };

  if (!filename || typeof filename !== "string" || filename.trim() === "") {
    res.status(400).json({ error: "filename is required" });
    return;
  }
  if (!mimeType || typeof mimeType !== "string") {
    res.status(400).json({ error: "mimeType is required" });
    return;
  }
  if (typeof sizeBytes !== "number" || sizeBytes <= 0) {
    res.status(400).json({ error: "sizeBytes must be a positive number" });
    return;
  }
  if (sizeBytes > env.MAX_FILE_SIZE_BYTES) {
    res.status(413).json({ error: `File exceeds the maximum size (${Math.round(env.MAX_FILE_SIZE_BYTES / 1024 / 1024)} MB)` });
    return;
  }

  const objectKey = `shares/${uuidv4()}-${sanitizeFilename(filename)}`;

  // Presigned PUT valid for 1h — enough for large files over slower links.
  const PUT_EXPIRY = 3600;
  let uploadUrl: string;
  let uploadUrlDirect: string | null = null;
  try {
    uploadUrl = await minioPublicClient.presignedPutObject(env.S3_BUCKET, objectKey, PUT_EXPIRY);
    if (minioTailnetClient) {
      // Direct tailnet fast-path — the frontend uses this when the browser is
      // on the tailnet, and falls back to uploadUrl (Cloudflare) otherwise.
      uploadUrlDirect = await minioTailnetClient.presignedPutObject(env.S3_BUCKET, objectKey, PUT_EXPIRY);
    }
  } catch (err) {
    console.error("[start-share] MinIO presign failed:", err);
    res.status(500).json({ error: "Failed to generate upload URL" });
    return;
  }

  res.status(201).json({
    objectKey,
    uploadUrl,
    uploadUrlDirect,
    // Cloudflare's free tier caps request bodies at ~100MB; the tailnet path has
    // no such cap. The frontend enforces the right limit per chosen path.
    publicMaxBytes: env.PUBLIC_MAX_FILE_SIZE_BYTES,
    maxBytes: env.MAX_FILE_SIZE_BYTES,
  });
});

/**
 * POST /admin/confirm-share
 * Body: { objectKey, expirySeconds }
 * Returns: { downloadUrl, expiresAt }
 */
router.post("/admin/confirm-share", async (req: Request, res: Response): Promise<void> => {
  if (!requireMaster(req, res)) return;

  const { objectKey, expirySeconds } = req.body as {
    objectKey?: string;
    expirySeconds?: number;
  };

  if (!objectKey || typeof objectKey !== "string" || !objectKey.startsWith("shares/")) {
    res.status(400).json({ error: "Invalid objectKey" });
    return;
  }
  if (!VALID_EXPIRY_SECONDS.includes(expirySeconds as number)) {
    res.status(400).json({ error: `expirySeconds must be one of: ${VALID_EXPIRY_SECONDS.join(", ")}` });
    return;
  }

  // Verify the object was actually uploaded to MinIO
  try {
    await minioClient.statObject(env.S3_BUCKET, objectKey);
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === "NotFound") {
      res.status(422).json({ error: "File not found in storage — upload may have failed" });
    } else {
      console.error("[confirm-share] MinIO stat failed:", err);
      res.status(500).json({ error: "Failed to verify upload in storage" });
    }
    return;
  }

  let downloadUrl: string;
  try {
    // Images/PDF stay inline (so a shared photo/PDF still previews); anything
    // else is forced to download so active content (HTML/SVG) can never render
    // in the files.* origin.
    const disposition = /\.(jpe?g|png|gif|webp|pdf)$/i.test(objectKey) ? "inline" : "attachment";
    const respHeaders = { "response-content-disposition": disposition };
    downloadUrl = await minioPublicClient.presignedGetObject(env.S3_BUCKET, objectKey, expirySeconds as number, respHeaders);
  } catch (err) {
    console.error("[confirm-share] MinIO presign GET failed:", err);
    res.status(500).json({ error: "Failed to generate download URL" });
    return;
  }

  const expiresAt = new Date(Date.now() + (expirySeconds as number) * 1000).toISOString();

  res.status(200).json({ downloadUrl, expiresAt });
});

// ── Subida multipart (archivos grandes por el path público/Cloudflare) ──────────
// El PUT único choca con el cap de ~100MB de Cloudflare. Con multipart, el browser
// sube el archivo en trozos <100MB (cada uno un PUT presignado por Cloudflare) y el
// servidor los reensambla. El browser NO necesita leer los ETag (MinIO no los expone
// por CORS): al completar, el servidor lista las partes localmente.

/**
 * POST /admin/start-multipart
 * Body: { filename, mimeType, sizeBytes }
 * Returns: { objectKey, uploadId, partSize, parts: [{ partNumber, url }] }
 */
router.post("/admin/start-multipart", async (req: Request, res: Response): Promise<void> => {
  if (!requireMaster(req, res)) return;

  const { filename, mimeType, sizeBytes } = req.body as {
    filename?: string; mimeType?: string; sizeBytes?: number;
  };
  if (!filename || typeof filename !== "string" || filename.trim() === "") {
    res.status(400).json({ error: "filename is required" }); return;
  }
  if (typeof sizeBytes !== "number" || sizeBytes <= 0) {
    res.status(400).json({ error: "sizeBytes must be a positive number" }); return;
  }
  if (sizeBytes > env.MAX_FILE_SIZE_BYTES) {
    res.status(413).json({ error: `File exceeds the maximum size (${Math.round(env.MAX_FILE_SIZE_BYTES / 1024 / 1024)} MB)` }); return;
  }

  const objectKey = `shares/${uuidv4()}-${sanitizeFilename(filename)}`;
  const numParts = Math.max(1, Math.ceil(sizeBytes / MP_PART_SIZE));

  try {
    const uploadId = String(await mc.initiateNewMultipartUpload(
      env.S3_BUCKET, objectKey, mimeType ? { "Content-Type": mimeType } : {}
    ));
    const parts: Array<{ partNumber: number; url: string }> = [];
    for (let n = 1; n <= numParts; n++) {
      // Presignado por el endpoint público (Cloudflare): cada parte es <100MB.
      const url = await (minioPublicClient as unknown as {
        presignedUrl: (m: string, b: string, o: string, e: number, q: Record<string, string>) => Promise<string>;
      }).presignedUrl("PUT", env.S3_BUCKET, objectKey, 3600, { partNumber: String(n), uploadId });
      parts.push({ partNumber: n, url });
    }
    res.status(201).json({ objectKey, uploadId, partSize: MP_PART_SIZE, parts });
  } catch (err) {
    console.error("[start-multipart] failed:", err);
    res.status(500).json({ error: "Failed to start multipart upload" });
  }
});

/**
 * POST /admin/complete-multipart
 * Body: { objectKey, uploadId, expirySeconds }
 * Returns: { downloadUrl, expiresAt }
 */
router.post("/admin/complete-multipart", async (req: Request, res: Response): Promise<void> => {
  if (!requireMaster(req, res)) return;

  const { objectKey, uploadId, expirySeconds } = req.body as {
    objectKey?: string; uploadId?: string; expirySeconds?: number;
  };
  if (!objectKey || typeof objectKey !== "string" || !objectKey.startsWith("shares/")) {
    res.status(400).json({ error: "Invalid objectKey" }); return;
  }
  if (!uploadId || typeof uploadId !== "string") {
    res.status(400).json({ error: "uploadId is required" }); return;
  }
  if (!VALID_EXPIRY_SECONDS.includes(expirySeconds as number)) {
    res.status(400).json({ error: `expirySeconds must be one of: ${VALID_EXPIRY_SECONDS.join(", ")}` }); return;
  }

  try {
    const raw = await mc.listParts(env.S3_BUCKET, objectKey, uploadId);
    if (!raw || !raw.length) {
      res.status(422).json({ error: "No parts uploaded — upload may have failed" }); return;
    }
    const etags = raw.sort((a, b) => a.part - b.part).map(p => ({ part: p.part, etag: p.etag }));
    await completeMultipart(env.S3_BUCKET, objectKey, uploadId, etags);
  } catch (err) {
    console.error("[complete-multipart] failed:", err);
    res.status(500).json({ error: "Failed to complete upload" });
    return;
  }

  let downloadUrl: string;
  try {
    const disposition = /\.(jpe?g|png|gif|webp|pdf)$/i.test(objectKey) ? "inline" : "attachment";
    downloadUrl = await minioPublicClient.presignedGetObject(env.S3_BUCKET, objectKey, expirySeconds as number, { "response-content-disposition": disposition });
  } catch (err) {
    console.error("[complete-multipart] presign GET failed:", err);
    res.status(500).json({ error: "Failed to generate download URL" });
    return;
  }

  const expiresAt = new Date(Date.now() + (expirySeconds as number) * 1000).toISOString();
  res.status(200).json({ downloadUrl, expiresAt });
});

/**
 * POST /admin/abort-multipart — limpieza si el browser aborta a mitad de camino.
 * Body: { objectKey, uploadId }
 */
router.post("/admin/abort-multipart", async (req: Request, res: Response): Promise<void> => {
  if (!requireMaster(req, res)) return;
  const { objectKey, uploadId } = req.body as { objectKey?: string; uploadId?: string };
  if (!objectKey || !objectKey.startsWith("shares/") || !uploadId) {
    res.status(400).json({ error: "Invalid objectKey or uploadId" }); return;
  }
  try {
    await mc.abortMultipartUpload(env.S3_BUCKET, objectKey, uploadId);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[abort-multipart] failed:", err);
    res.status(500).json({ error: "Failed to abort upload" });
  }
});

export default router;
