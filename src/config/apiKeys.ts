/**
 * API key helpers: hashing, lookup, scope checking.
 *
 * We never store raw keys — only SHA-256 hashes.
 * The raw key is returned once at creation and never stored.
 *
 * All persistence goes through Hasura GraphQL (no direct DB connection).
 */
import crypto from "crypto";
import { hasuraQuery } from "./hasura";
import type { FolderRecord } from "./folders";

export type { FolderRecord };

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  can_upload: boolean;
  can_download: boolean;
  can_delete: boolean;
  is_active: boolean;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
  folders: FolderRecord[];
}

/** SHA-256 hex digest of the raw bearer token */
export function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/** Generate a new random API key in the format sk_<64 hex chars> */
export function generateRawKey(): string {
  return "sk_" + crypto.randomBytes(32).toString("hex");
}

// ─── GraphQL fragments ───────────────────────────────────────────────────────

const API_KEY_FIELDS = `
  id name prefix can_upload can_download can_delete is_active expires_at created_at last_used_at
  api_key_folders {
    folder { id name created_at }
  }
`;

function mapFolders(raw: { api_key_folders?: { folder: FolderRecord }[] }): FolderRecord[] {
  return raw.api_key_folders?.map(akf => akf.folder) ?? [];
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

/**
 * Look up an API key record by the raw bearer token.
 * Updates last_used_at on successful lookup (fire-and-forget).
 * Returns null if not found, revoked, or expired.
 */
export async function findApiKey(rawKey: string): Promise<ApiKeyRecord | null> {
  const hash = hashKey(rawKey);
  const now = new Date().toISOString();

  const data = await hasuraQuery<{ api_keys: Array<ApiKeyRecord & { api_key_folders: { folder: FolderRecord }[] }> }>(
    `query FindApiKey($key_hash: String!, $now: timestamptz!) {
      api_keys(where: {
        key_hash: { _eq: $key_hash }
        is_active: { _eq: true }
        _or: [
          { expires_at: { _is_null: true } }
          { expires_at: { _gt: $now } }
        ]
      }) { ${API_KEY_FIELDS} }
    }`,
    { key_hash: hash, now }
  );

  if (data.api_keys.length === 0) return null;

  const raw = data.api_keys[0];
  const key: ApiKeyRecord = { ...raw, folders: mapFolders(raw) };

  // Update last_used_at in the background — don't await to avoid latency
  hasuraQuery(
    `mutation UpdateLastUsed($id: uuid!, $now: timestamptz!) {
      update_api_keys_by_pk(pk_columns: { id: $id }, _set: { last_used_at: $now }) { id }
    }`,
    { id: key.id, now }
  ).catch(() => {/* ignore */});

  return key;
}

// ─── Scope checking ──────────────────────────────────────────────────────────

/**
 * Check whether a key has access to an object key given its prefix/folder scope.
 *
 * Rules:
 *   prefix = "*"         → access to every object (global key, no folders)
 *   key has folders      → object key must contain one of the folder names as an exact path segment
 *   legacy prefix        → original prefix-based check
 */
export function isAllowed(key: ApiKeyRecord, objectKey: string): boolean {
  if (key.prefix === "*") return true;

  if (key.folders && key.folders.length > 0) {
    return key.folders.some(f => isAllowedPrefix(f.name + "/", objectKey));
  }

  // Legacy fallback: use prefix field directly
  return isAllowedPrefix(key.prefix, objectKey);
}

/**
 * Check whether a single prefix string covers the given object key.
 * Exported for backwards compatibility.
 */
export function isAllowedPrefix(keyPrefix: string, objectKey: string): boolean {
  if (keyPrefix === "*") return true;

  const folder = keyPrefix.replace(/^\/+|\/+$/g, "").toLowerCase();
  if (!folder) return false;

  return objectKey.toLowerCase().includes(`/${folder}/`);
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/** Get a single key by ID */
export async function getApiKeyById(id: string): Promise<ApiKeyRecord | null> {
  const data = await hasuraQuery<{ api_keys_by_pk: (ApiKeyRecord & { api_key_folders: { folder: FolderRecord }[] }) | null }>(
    `query GetApiKeyById($id: uuid!) {
      api_keys_by_pk(id: $id) { ${API_KEY_FIELDS} }
    }`,
    { id }
  );
  if (!data.api_keys_by_pk) return null;
  const raw = data.api_keys_by_pk;
  return { ...raw, folders: mapFolders(raw) };
}

/** Create a new API key. Returns { record, rawKey } — rawKey is shown only once. */
export async function createApiKey(params: {
  name: string;
  prefix: string;
  can_upload?: boolean;
  can_download?: boolean;
  can_delete?: boolean;
  expires_at?: string | null;
  folder_ids?: string[];
}): Promise<{ record: ApiKeyRecord & { key_hash: string }; rawKey: string }> {
  const rawKey = generateRawKey();
  const keyHash = hashKey(rawKey);

  const data = await hasuraQuery<{
    insert_api_keys_one: ApiKeyRecord & { key_hash: string };
  }>(
    `mutation CreateApiKey($object: api_keys_insert_input!) {
      insert_api_keys_one(object: $object) {
        id name prefix can_upload can_download is_active expires_at created_at last_used_at key_hash
      }
    }`,
    {
      object: {
        key_hash: keyHash,
        name: params.name,
        prefix: params.prefix,
        can_upload: params.can_upload ?? true,
        can_download: params.can_download ?? true,
        can_delete: params.can_delete ?? false,
        expires_at: params.expires_at ?? null,
      },
    }
  );

  const record = data.insert_api_keys_one;

  // Assign folders if provided
  if (params.folder_ids && params.folder_ids.length > 0) {
    const objects = params.folder_ids.map(folder_id => ({
      api_key_id: record.id,
      folder_id,
    }));
    await hasuraQuery(
      `mutation InsertApiKeyFolders($objects: [api_key_folders_insert_input!]!) {
        insert_api_key_folders(objects: $objects) { affected_rows }
      }`,
      { objects }
    );
  }

  return { record: { ...record, folders: [] }, rawKey };
}

/** Revoke (soft-delete) a key by id */
export async function revokeApiKey(id: string): Promise<boolean> {
  const data = await hasuraQuery<{
    update_api_keys_by_pk: { id: string } | null;
  }>(
    `mutation RevokeApiKey($id: uuid!) {
      update_api_keys_by_pk(pk_columns: { id: $id }, _set: { is_active: false }) { id }
    }`,
    { id }
  );
  return data.update_api_keys_by_pk !== null;
}

/** List all keys (never returns key_hash) */
export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  const data = await hasuraQuery<{ api_keys: Array<ApiKeyRecord & { api_key_folders: { folder: FolderRecord }[] }> }>(
    `query ListApiKeys {
      api_keys(order_by: { created_at: desc }) { ${API_KEY_FIELDS} }
    }`
  );
  return data.api_keys.map(raw => ({ ...raw, folders: mapFolders(raw) }));
}
