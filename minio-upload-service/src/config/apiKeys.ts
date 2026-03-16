/**
 * API key helpers: hashing, lookup, scope checking.
 *
 * We never store raw keys — only SHA-256 hashes.
 * The raw key is returned once at creation and never stored.
 */
import crypto from "crypto";
import { db } from "./db";

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
 * Updates last_used_at on successful lookup.
 * Returns null if not found, revoked, or expired.
 */
export async function findApiKey(rawKey: string): Promise<ApiKeyRecord | null> {
  const hash = hashKey(rawKey);

  const result = await db.query<ApiKeyRecord>(
    `SELECT id, name, prefix, can_upload, can_download, is_active, expires_at, created_at, last_used_at
     FROM public.api_keys
     WHERE key_hash = $1
       AND is_active = true
       AND (expires_at IS NULL OR expires_at > now())`,
    [hash]
  );

  if (result.rows.length === 0) return null;

  const key = result.rows[0];

  // Update last_used_at in the background — don't await to avoid latency
  db.query(
    "UPDATE public.api_keys SET last_used_at = now() WHERE id = $1",
    [key.id]
  ).catch(() => {/* ignore */});

  return key;
}

/**
 * Check whether a key has access to an object key given its prefix scope.
 *
 * Rules:
 *   prefix = "*"          → access to everything
 *   prefix = "infopublica/" → objectKey must start with "uploads/.../infopublica/"
 *                             OR start with "infopublica/" exactly
 */
export function isAllowedPrefix(
  keyPrefix: string,
  objectKey: string
): boolean {
  if (keyPrefix === "*") return true;

  // Normalize: remove leading slash
  const normalizedKey = objectKey.replace(/^\//, "");
  const normalizedPrefix = keyPrefix.replace(/^\//, "");

  // Direct match (objectKey starts with the prefix)
  if (normalizedKey.startsWith(normalizedPrefix)) return true;

  // Also match inside the uploads/<userId>/<date>/ nesting pattern:
  // uploads/any-user-id/2024-01-15/fileId-infopublica/something.pdf
  // We extract the "folder segment" after the date portion and check it
  const uploadPattern = /^uploads\/[^/]+\/[^/]+\/[^/]+-(.+)$/;
  const match = normalizedKey.match(uploadPattern);
  if (match) {
    // match[1] is the sanitized filename portion after the uuid-
    // Check if the prefix is in the path segments
    return normalizedKey.includes(`/${normalizedPrefix}`) ||
           normalizedKey.includes(`-${normalizedPrefix}`);
  }

  return false;
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

  const result = await db.query<ApiKeyRecord & { key_hash: string }>(
    `INSERT INTO public.api_keys (key_hash, name, prefix, can_upload, can_download, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, prefix, can_upload, can_download, is_active, expires_at, created_at, last_used_at, key_hash`,
    [
      keyHash,
      params.name,
      params.prefix,
      params.can_upload ?? true,
      params.can_download ?? true,
      params.expires_at ?? null,
    ]
  );

  return { record: result.rows[0], rawKey };
}

/** Revoke (soft-delete) a key by id */
export async function revokeApiKey(id: string): Promise<boolean> {
  const result = await db.query(
    "UPDATE public.api_keys SET is_active = false WHERE id = $1",
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

/** List all keys (never returns key_hash raw, hides it) */
export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  const result = await db.query<ApiKeyRecord>(
    `SELECT id, name, prefix, can_upload, can_download, is_active, expires_at, created_at, last_used_at
     FROM public.api_keys
     ORDER BY created_at DESC`
  );
  return result.rows;
}
