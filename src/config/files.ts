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

// ─── Folder size (via DB, not MinIO listing) ─────────────────────────────────

export async function getFolderSizeStats(folderName: string): Promise<{ file_count: number; size_bytes: number }> {
  const data = await hasuraQuery<{
    files_aggregate: { aggregate: { count: number; sum: { size_bytes: number | null } } };
  }>(
    `query FolderSizeStats($like: String!) {
      files_aggregate(where: { deleted_at: { _is_null: true }, object_key: { _like: $like } }) {
        aggregate { count sum { size_bytes } }
      }
    }`,
    { like: `%/${folderName}/%` }
  );
  const agg = data.files_aggregate.aggregate;
  return { file_count: agg.count, size_bytes: agg.sum?.size_bytes ?? 0 };
}

// ─── Stats overview ───────────────────────────────────────────────────────────

export interface StatsOverview {
  total_files: number;
  total_size_bytes: number;
  deleted_files: number;
  active_keys: number;
  total_folders: number;
  largest_files: Pick<FileRecord, "id" | "original_filename" | "size_bytes" | "created_at" | "object_key" | "mime_type">[];
}

export async function getStatsOverview(): Promise<StatsOverview> {
  const data = await hasuraQuery<{
    active_files:   { aggregate: { count: number; sum: { size_bytes: number | null } } };
    deleted_files:  { aggregate: { count: number } };
    active_keys:    { aggregate: { count: number } };
    total_folders:  { aggregate: { count: number } };
    largest_files:  Pick<FileRecord, "id" | "original_filename" | "size_bytes" | "created_at" | "object_key" | "mime_type">[];
  }>(
    `query StatsOverview {
      active_files: files_aggregate(where: { deleted_at: { _is_null: true } }) {
        aggregate { count sum { size_bytes } }
      }
      deleted_files: files_aggregate(where: { deleted_at: { _is_null: false } }) {
        aggregate { count }
      }
      active_keys: api_keys_aggregate(where: { is_active: { _eq: true } }) {
        aggregate { count }
      }
      total_folders: folders_aggregate { aggregate { count } }
      largest_files: files(
        where: { deleted_at: { _is_null: true } }
        order_by: { size_bytes: desc }
        limit: 10
      ) { id original_filename size_bytes created_at object_key mime_type }
    }`
  );
  return {
    total_files:     data.active_files.aggregate.count,
    total_size_bytes: data.active_files.aggregate.sum?.size_bytes ?? 0,
    deleted_files:   data.deleted_files.aggregate.count,
    active_keys:     data.active_keys.aggregate.count,
    total_folders:   data.total_folders.aggregate.count,
    largest_files:   data.largest_files,
  };
}

export interface EventActivity {
  date: string;
  upload_count: number;
  download_count: number;
  upload_size_bytes: number;
}

export async function getActivityLast30Days(): Promise<EventActivity[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const data = await hasuraQuery<{
    file_events: Array<{ event_type: string; size_bytes: number | null; created_at: string }>;
  }>(
    `query RecentEvents($since: timestamptz!) {
      file_events(where: { created_at: { _gte: $since } }, order_by: { created_at: asc }) {
        event_type size_bytes created_at
      }
    }`,
    { since }
  );

  const byDay = new Map<string, EventActivity>();
  for (const ev of data.file_events) {
    const date = ev.created_at.slice(0, 10);
    if (!byDay.has(date)) byDay.set(date, { date, upload_count: 0, download_count: 0, upload_size_bytes: 0 });
    const d = byDay.get(date)!;
    if (ev.event_type === "upload_confirmed") {
      d.upload_count++;
      d.upload_size_bytes += ev.size_bytes ?? 0;
    } else if (ev.event_type === "download_url_created") {
      d.download_count++;
    }
  }
  return Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));
}

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
    }

    // Verify the file is actually gone
    try {
      await minioClient.statObject(env.S3_BUCKET, objectKey);
      // statObject succeeded → file still exists in MinIO despite removeObject
      console.error(`[files] WARNING: file still exists in MinIO after removeObject! key="${objectKey}" — bucket versioning may be enabled.`);
    } catch (statErr: any) {
      const code = statErr?.code ?? statErr?.message ?? String(statErr);
      if (code === "NotFound" || String(code).includes("Not Found") || String(code).includes("NoSuchKey")) {
        console.log(`[files] Verified: file no longer exists in MinIO.`);
      } else {
        console.error(`[files] Could not verify deletion (statObject error):`, statErr);
      }
    }
  }

  return true;
}
