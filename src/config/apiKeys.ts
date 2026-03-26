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

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  can_upload: boolean;
  can_download: boolean;
  is_active: boolean;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** SHA-256 hex digest of the raw bearer token */
export function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/** Generate a new random API key in the format sk_<64 hex chars> */
export function generateRawKey(): string {
  return "sk_" + crypto.randomBytes(32).toString("hex");
}

/**
 * Look up an API key record by the raw bearer token.
 * Updates last_used_at on successful lookup (fire-and-forget).
 * Returns null if not found, revoked, or expired.
 */
export async function findApiKey(rawKey: string): Promise<ApiKeyRecord | null> {
  const hash = hashKey(rawKey);
  const now = new Date().toISOString();

  const data = await hasuraQuery<{ api_keys: ApiKeyRecord[] }>(
    `query FindApiKey($key_hash: String!, $now: timestamptz!) {
      api_keys(where: {
        key_hash: { _eq: $key_hash }
        is_active: { _eq: true }
        _or: [
          { expires_at: { _is_null: true } }
          { expires_at: { _gt: $now } }
        ]
      }) {
        id name prefix can_upload can_download is_active expires_at created_at last_used_at
      }
    }`,
    { key_hash: hash, now }
  );

  if (data.api_keys.length === 0) return null;

  const key = data.api_keys[0];

  // Update last_used_at in the background — don't await to avoid latency
  hasuraQuery(
    `mutation UpdateLastUsed($id: uuid!, $now: timestamptz!) {
      update_api_keys_by_pk(pk_columns: { id: $id }, _set: { last_used_at: $now }) { id }
    }`,
    { id: key.id, now }
  ).catch(() => {/* ignore */});

  return key;
}

/**
 * Check whether a key has access to an object key given its prefix scope.
 *
 * Object keys always follow the pattern:
 *   uploads/<userId>/<folder>/<date>/<uuid>-<filename>
 *
 * Rules:
 *   keyPrefix = "*"            → access to every object
 *   keyPrefix = "infopublica/" → object key must contain "/infopublica/" as an
 *                                exact path segment (not as a substring)
 *
 * Examples:
 *   isAllowedPrefix("infopublica/", "uploads/u1/infopublica/2024-01-01/f-doc.pdf")
 *     → true  ✓
 *   isAllowedPrefix("infopublica/", "uploads/u1/notinfopublica/2024-01-01/f-doc.pdf")
 *     → false ✓  (avoids substring false positive)
 *   isAllowedPrefix("pub/", "uploads/u1/infopublica/2024-01-01/f-doc.pdf")
 *     → false ✓  (must be exact folder segment)
 */
export function isAllowedPrefix(
  keyPrefix: string,
  objectKey: string
): boolean {
  if (keyPrefix === "*") return true;

  // Normalize: strip leading/trailing slashes, lowercase
  const folder = keyPrefix.replace(/^\/+|\/+$/g, "").toLowerCase();
  if (!folder) return false;

  // The object key must contain the exact folder segment: /<folder>/
  const normalizedKey = objectKey.toLowerCase();
  return normalizedKey.includes(`/${folder}/`);
}

/** Create a new API key. Returns { record, rawKey } — rawKey is shown only once. */
export async function createApiKey(params: {
  name: string;
  prefix: string;
  can_upload?: boolean;
  can_download?: boolean;
  expires_at?: string | null;
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
        expires_at: params.expires_at ?? null,
      },
    }
  );

  return { record: data.insert_api_keys_one, rawKey };
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
  const data = await hasuraQuery<{ api_keys: ApiKeyRecord[] }>(
    `query ListApiKeys {
      api_keys(order_by: { created_at: desc }) {
        id name prefix can_upload can_download is_active expires_at created_at last_used_at
      }
    }`
  );
  return data.api_keys;
}
