import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { minioClient, minioPublicClient } from "../config/minio";
import { hasuraQuery } from "../config/hasura";
import { env } from "../config/env";
import { buildObjectKey, sanitizeFolder } from "../utils/filename";
import { validateCreateUpload } from "../middleware/validate";
import { checkScope } from "../middleware/apiKey";
import { logFileEvent } from "../config/fileEvents";

const router = Router();

// ─── GraphQL mutation ────────────────────────────────────────────────────────

const INSERT_FILE = `
  mutation InsertFile(
    $id: uuid!
    $bucket: String!
    $object_key: String!
    $original_filename: String!
    $mime_type: String!
    $size_bytes: bigint!
    $owner_user_id: uuid!
    $status: String!
  ) {
    insert_files_one(object: {
      id: $id
      bucket: $bucket
      object_key: $object_key
      original_filename: $original_filename
      mime_type: $mime_type
      size_bytes: $size_bytes
      owner_user_id: $owner_user_id
      status: $status
    }) {
      id
      object_key
      status
      created_at
    }
  }
`;

interface InsertFileResult {
  insert_files_one: {
    id: string;
    object_key: string;
    status: string;
    created_at: string;
  };
}

// ─── Route handler ───────────────────────────────────────────────────────────

/**
 * POST /create-upload
 *
 * Body: { filename, mimeType, sizeBytes, userId }
 *
 * 1. Generates a UUID for the file record
 * 2. Builds a deterministic, sanitized object key
 * 3. Inserts a "pending" record in Hasura
 * 4. Generates a presigned PUT URL from MinIO
 * 5. Returns { fileId, uploadUrl, objectKey }
 */
router.post(
  "/create-upload",
  validateCreateUpload,
  async (req: Request, res: Response): Promise<void> => {
    const { filename, mimeType, sizeBytes, userId, folder } = req.body as {
      filename: string;
      mimeType: string;
      sizeBytes: number;
      userId: string;
      folder?: string;
    };

    // Determine the effective folder:
    // - Global key (prefix "*", no folders): use folder param or default "general"
    // - Folder-based key (has folders assigned):
    //     1 folder  → use it automatically
    //     N folders → require folder param, must be one of the assigned folders
    // - Legacy prefix key: prefix IS the folder
    const keyPrefix = req.apiKey?.prefix ?? "*";
    const keyFolders = req.apiKey?.folders ?? [];

    let effectiveFolder: string;
    if (keyPrefix === "*" && keyFolders.length === 0) {
      effectiveFolder = sanitizeFolder(folder ?? "general");
    } else if (keyFolders.length > 0) {
      if (keyFolders.length === 1) {
        effectiveFolder = sanitizeFolder(keyFolders[0].name);
      } else if (folder) {
        effectiveFolder = sanitizeFolder(folder);
      } else {
        res.status(400).json({ error: "folder parameter required: this key has access to multiple folders" });
        return;
      }
    } else {
      // Legacy: prefix IS the folder
      effectiveFolder = sanitizeFolder(keyPrefix);
    }

    const fileId = uuidv4();
    const objectKey = buildObjectKey(userId, fileId, filename, effectiveFolder);

    // Check that the API key's prefix scope covers this object key
    if (!checkScope(objectKey, "upload", req, res)) return;

    // 1. Insert pending record in Hasura first.
    //    We do this BEFORE generating the presigned URL so that if Hasura fails
    //    we never issue a URL the user could upload to without a DB record.
    try {
      await hasuraQuery<InsertFileResult>(INSERT_FILE, {
        id: fileId,
        bucket: env.S3_BUCKET,
        object_key: objectKey,
        original_filename: filename,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        owner_user_id: userId,
        status: "pending",
      });
    } catch (err) {
      console.error("[create-upload] Hasura insert failed:", err);
      res.status(500).json({ error: "Failed to register file metadata" });
      return;
    }

    // 2. Generate presigned PUT URL.
    //    The frontend will PUT the file bytes directly to this URL.
    let uploadUrl: string;
    try {
      uploadUrl = await minioPublicClient.presignedPutObject(
        env.S3_BUCKET,
        objectKey,
        env.PRESIGNED_URL_EXPIRY_SECONDS
      );
    } catch (err) {
      console.error("[create-upload] MinIO presign failed:", err);
      res.status(500).json({ error: "Failed to generate upload URL" });
      return;
    }

    logFileEvent({
      event_type: "upload_initiated",
      file_id: fileId,
      api_key_id: req.apiKey?.id,
      object_key: objectKey,
      mime_type: mimeType,
      size_bytes: sizeBytes,
    });

    res.status(201).json({
      fileId,
      uploadUrl,
      objectKey,
      expiresInSeconds: env.PRESIGNED_URL_EXPIRY_SECONDS,
    });
  }
);

export default router;
