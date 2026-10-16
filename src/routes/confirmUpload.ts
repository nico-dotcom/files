import { Router, Request, Response } from "express";
import { minioClient } from "../config/minio";
import { hasuraQuery } from "../config/hasura";
import { env } from "../config/env";
import { validateFileId } from "../middleware/validate";
import { checkScope } from "../middleware/apiKey";
import { logFileEvent } from "../config/fileEvents";

const router = Router();

// ─── GraphQL queries ─────────────────────────────────────────────────────────

const GET_FILE = `
  query GetFile($id: uuid!) {
    files_by_pk(id: $id) {
      id
      bucket
      object_key
      status
    }
  }
`;

const CONFIRM_UPLOAD = `
  mutation ConfirmUpload($id: uuid!, $uploaded_at: timestamptz!, $size_bytes: bigint!) {
    update_files_by_pk(
      pk_columns: { id: $id }
      _set: { status: "uploaded", uploaded_at: $uploaded_at, size_bytes: $size_bytes }
    ) {
      id
      status
      uploaded_at
      object_key
      original_filename
    }
  }
`;

interface GetFileResult {
  files_by_pk: {
    id: string;
    bucket: string;
    object_key: string;
    status: string;
  } | null;
}

interface ConfirmUploadResult {
  update_files_by_pk: {
    id: string;
    status: string;
    uploaded_at: string;
    object_key: string;
    original_filename: string;
  };
}

// ─── Route handler ───────────────────────────────────────────────────────────

/**
 * POST /confirm-upload
 *
 * Body: { fileId }
 *
 * 1. Fetches the file record from Hasura — must exist and be in "pending" state
 * 2. Verifies the object actually exists in MinIO (prevents fake confirmations)
 * 3. Updates status → "uploaded" and sets uploaded_at = now()
 */
router.post(
  "/confirm-upload",
  validateFileId,
  async (req: Request, res: Response): Promise<void> => {
    const { fileId } = req.body as { fileId: string };

    // 1. Fetch existing record
    let fileRecord: GetFileResult["files_by_pk"];
    try {
      const result = await hasuraQuery<GetFileResult>(GET_FILE, { id: fileId });
      fileRecord = result.files_by_pk;
    } catch (err) {
      console.error("[confirm-upload] Hasura fetch failed:", err);
      res.status(500).json({ error: "Failed to fetch file record" });
      return;
    }

    if (!fileRecord) {
      res.status(404).json({ error: "File record not found" });
      return;
    }

    if (fileRecord.status !== "pending") {
      res.status(409).json({
        error: "File cannot be confirmed in its current state",
      });
      return;
    }

    // Verify the API key's prefix scope covers this object key
    if (!checkScope(fileRecord.object_key, "upload", req, res)) return;

    // 2. Verify the object really exists in MinIO and read its REAL size.
    //    This prevents a client from confirming an upload that never happened,
    //    AND enforces the size limit — a presigned PUT does not cap Content-Length,
    //    so the declared sizeBytes at /create-upload is only advisory.
    let actualSize: number;
    try {
      const stat = await minioClient.statObject(env.S3_BUCKET, fileRecord.object_key);
      actualSize = stat.size;
    } catch (err: unknown) {
      const minioErr = err as { code?: string };
      if (minioErr.code === "NotFound") {
        res.status(422).json({
          error: "Upload not found in storage",
        });
      } else {
        console.error("[confirm-upload] MinIO stat failed:", err);
        res.status(500).json({ error: "Failed to verify object in storage" });
      }
      return;
    }

    // Reject (and remove) objects that exceed the max size, regardless of what
    // the client declared when the upload was created.
    if (actualSize > env.MAX_FILE_SIZE_BYTES) {
      try {
        await minioClient.removeObject(env.S3_BUCKET, fileRecord.object_key);
      } catch (err) {
        console.error("[confirm-upload] failed to remove oversized object:", err);
      }
      res.status(413).json({
        error: `Uploaded file (${actualSize} bytes) exceeds the maximum allowed size of ${env.MAX_FILE_SIZE_BYTES} bytes`,
      });
      return;
    }

    // 3. Mark as uploaded, recording the REAL size (not the client-declared one).
    try {
      const updated = await hasuraQuery<ConfirmUploadResult>(CONFIRM_UPLOAD, {
        id: fileId,
        uploaded_at: new Date().toISOString(),
        size_bytes: actualSize,
      });

      logFileEvent({
        event_type: "upload_confirmed",
        file_id: updated.update_files_by_pk.id,
        api_key_id: req.apiKey?.id,
        object_key: updated.update_files_by_pk.object_key,
      });

      res.status(200).json({
        fileId: updated.update_files_by_pk.id,
        status: updated.update_files_by_pk.status,
        uploadedAt: updated.update_files_by_pk.uploaded_at,
        objectKey: updated.update_files_by_pk.object_key,
        originalFilename: updated.update_files_by_pk.original_filename,
      });
    } catch (err) {
      console.error("[confirm-upload] Hasura update failed:", err);
      res.status(500).json({ error: "Failed to confirm upload" });
    }
  }
);

export default router;
