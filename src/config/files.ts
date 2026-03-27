/**
 * File record helpers — all DB operations via Hasura GraphQL.
 */
import { hasuraQuery } from "./hasura";
import { minioClient } from "./minio";
import { env } from "./env";

export interface FileRecord {
  id: string;
  bucket: string;
  object_key: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  owner_user_id: string;
  status: string;
  created_at: string;
  deleted_at: string | null;
}

const FILE_FIELDS = `
  id bucket object_key original_filename mime_type size_bytes owner_user_id status created_at deleted_at
`;

// ─── List ────────────────────────────────────────────────────────────────────

/** List non-deleted files, optionally filtered by folder prefix. */
export async function listFiles(folderPrefix?: string): Promise<FileRecord[]> {
  const where = folderPrefix
    ? `where: { deleted_at: { _is_null: true }, object_key: { _like: ${JSON.stringify("%" + folderPrefix + "%")} } }`
    : `where: { deleted_at: { _is_null: true } }`;

  const data = await hasuraQuery<{ files: FileRecord[] }>(
    `query ListFiles {
      files(${where}, order_by: { created_at: desc }, limit: 200) { ${FILE_FIELDS} }
    }`
  );
  return data.files;
}

// ─── Get by ID ───────────────────────────────────────────────────────────────

export async function getFileById(id: string): Promise<FileRecord | null> {
  const data = await hasuraQuery<{ files_by_pk: FileRecord | null }>(
    `query GetFileById($id: uuid!) {
      files_by_pk(id: $id) { ${FILE_FIELDS} }
    }`,
    { id }
  );
  return data.files_by_pk;
}

// ─── Soft-delete ─────────────────────────────────────────────────────────────

/**
 * Soft-delete a file record in the DB, then remove the object from MinIO.
 * Returns false if not found or already deleted.
 */
export async function softDeleteFile(id: string): Promise<boolean> {
  const now = new Date().toISOString();

  const data = await hasuraQuery<{
    update_files: { affected_rows: number; returning: { object_key: string }[] };
  }>(
    `mutation SoftDeleteFile($id: uuid!, $now: timestamptz!) {
      update_files(
        where: { id: { _eq: $id }, deleted_at: { _is_null: true } }
        _set: { deleted_at: $now, status: "deleted" }
      ) {
        affected_rows
        returning { object_key }
      }
    }`,
    { id, now }
  );

  if (data.update_files.affected_rows === 0) return false;

  const objectKey = data.update_files.returning[0]?.object_key;
  if (objectKey) {
    console.log(`[files] Deleting from MinIO: bucket="${env.S3_BUCKET}" key="${objectKey}"`);
    try {
      await minioClient.removeObject(env.S3_BUCKET, objectKey);
      console.log(`[files] MinIO removeObject OK: "${objectKey}"`);
    } catch (err) {
      console.error(`[files] MinIO removeObject FAILED for "${objectKey}":`, err);
      // Don't throw — DB record is already marked deleted; log is enough for now
    }
  }

  return true;
}
