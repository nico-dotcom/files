import { Router, Request, Response } from "express";
import { minioPublicClient } from "../config/minio";
import { hasuraQuery } from "../config/hasura";
import { env } from "../config/env";
import { validateFileId } from "../middleware/validate";

const router = Router();

// ─── GraphQL query ────────────────────────────────────────────────────────────

const GET_FILE_FOR_DOWNLOAD = `
  query GetFileForDownload($id: uuid!) {
    files_by_pk(id: $id) {
      id
      bucket
      object_key
      original_filename
      mime_type
      status
      owner_user_id
    }
  }
`;

interface GetFileForDownloadResult {
  files_by_pk: {
    id: string;
    bucket: string;
    object_key: string;
    original_filename: string;
    mime_type: string;
    status: string;
    owner_user_id: string;
  } | null;
}

// ─── Route handler ───────────────────────────────────────────────────────────

/**
 * POST /create-download-url
 *
 * Body: { fileId }
 *
 * 1. Fetches file metadata from Hasura (must be "uploaded")
 * 2. Generates a presigned GET URL valid for PRESIGNED_URL_EXPIRY_SECONDS
 * 3. Returns { downloadUrl, expiresInSeconds, originalFilename, mimeType }
 *
 * Note: In production you should also verify that the requesting user owns
 * this file or has permission to access it (pass userId in the body and
 * compare against owner_user_id).
 */
router.post(
  "/create-download-url",
  validateFileId,
  async (req: Request, res: Response): Promise<void> => {
    const { fileId } = req.body as { fileId: string };

    // 1. Fetch record from Hasura
    let fileRecord: GetFileForDownloadResult["files_by_pk"];
    try {
      const result = await hasuraQuery<GetFileForDownloadResult>(
        GET_FILE_FOR_DOWNLOAD,
        { id: fileId }
      );
      fileRecord = result.files_by_pk;
    } catch (err) {
      console.error("[create-download-url] Hasura fetch failed:", err);
      res.status(500).json({ error: "Failed to fetch file record" });
      return;
    }

    if (!fileRecord) {
      res.status(404).json({ error: "File record not found" });
      return;
    }

    if (fileRecord.status !== "uploaded") {
      res.status(422).json({
        error: `File is not yet available for download (status: "${fileRecord.status}")`,
      });
      return;
    }

    // 2. Generate presigned GET URL
    let downloadUrl: string;
    try {
      downloadUrl = await minioPublicClient.presignedGetObject(
        env.S3_BUCKET,
        fileRecord.object_key,
        env.PRESIGNED_URL_EXPIRY_SECONDS
      );
    } catch (err) {
      console.error("[create-download-url] MinIO presign failed:", err);
      res.status(500).json({ error: "Failed to generate download URL" });
      return;
    }

    res.status(200).json({
      downloadUrl,
      expiresInSeconds: env.PRESIGNED_URL_EXPIRY_SECONDS,
      originalFilename: fileRecord.original_filename,
      mimeType: fileRecord.mime_type,
      objectKey: fileRecord.object_key,
    });
  }
);

export default router;
