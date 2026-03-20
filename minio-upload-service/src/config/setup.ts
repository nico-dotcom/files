/**
 * Schema setup via Hasura APIs.
 *
 * On every startup:
 *   1. Runs CREATE TABLE IF NOT EXISTS for each required table via /v2/query.
 *   2. Tracks any untracked tables via /v1/metadata so they appear in GraphQL.
 *   3. Configures role permissions so the service only has access to what it needs.
 *
 * Safe to run multiple times — all operations are idempotent.
 */
import { env } from "./env";

// Derive base Hasura URL from the GraphQL endpoint
// e.g. "http://hasura:8080/v1/graphql" → "http://hasura:8080"
const HASURA_BASE = env.HASURA_GRAPHQL_URL.replace(/\/v\d+\/graphql$/, "");

const ADMIN_HEADERS = {
  "Content-Type": "application/json",
  "x-hasura-admin-secret": env.HASURA_ADMIN_SECRET,
};

// ─── Hasura API helpers ────────────────────────────────────────────────────────

/** Execute raw SQL against the Hasura-connected database */
async function runSql(sql: string): Promise<void> {
  const res = await fetch(`${HASURA_BASE}/v2/query`, {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      type: "run_sql",
      args: { sql, cascade: false, read_only: false },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Hasura run_sql failed (${res.status}): ${body}`);
  }
}

/** Call the Hasura metadata API, ignoring errors matching a known safe message */
async function metadataCall(
  type: string,
  args: Record<string, unknown>,
  ignoreIfMessage?: string
): Promise<void> {
  const res = await fetch(`${HASURA_BASE}/v1/metadata`, {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ type, args }),
  });

  if (!res.ok) {
    const body = await res.json() as { error?: string; internal?: { error?: { message?: string } } };
    const msg = (body.error ?? body.internal?.error?.message ?? "").toLowerCase();
    if (ignoreIfMessage && msg.includes(ignoreIfMessage.toLowerCase())) return;
    throw new Error(`Hasura metadata "${type}" failed (${res.status}): ${msg}`);
  }
}

// ─── Schema ────────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;

  CREATE TABLE IF NOT EXISTS public.api_keys (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash     text        NOT NULL UNIQUE,
    name         text        NOT NULL,
    prefix       text        NOT NULL DEFAULT '*',
    can_upload   boolean     NOT NULL DEFAULT true,
    can_download boolean     NOT NULL DEFAULT true,
    is_active    boolean     NOT NULL DEFAULT true,
    expires_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
  );

  CREATE INDEX IF NOT EXISTS api_keys_is_active_idx ON public.api_keys (is_active);
`;

// ─── Role permissions ──────────────────────────────────────────────────────────
//
// The service role (HASURA_SERVICE_ROLE, default "upload_service") only gets
// access to the api_keys table with the minimum permissions it needs:
//
//   SELECT  — all columns except key_hash (never exposed), no row filter
//   INSERT  — only the columns needed to create a key
//   UPDATE  — only is_active and last_used_at (revoke + last-used tracking)
//   DELETE  — none (soft-delete via is_active = false)

async function ensureRolePermissions(role: string): Promise<void> {
  const table = { schema: "public", name: "api_keys" };

  // SELECT — all columns except key_hash
  await metadataCall(
    "pg_create_select_permission",
    {
      source: "default",
      table,
      role,
      permission: {
        columns: [
          "id", "name", "prefix",
          "can_upload", "can_download", "is_active",
          "expires_at", "created_at", "last_used_at",
        ],
        filter: {},
        allow_aggregations: false,
      },
    },
    "already exists"
  );

  // INSERT — include key_hash (needed to store the hash at creation)
  await metadataCall(
    "pg_create_insert_permission",
    {
      source: "default",
      table,
      role,
      permission: {
        columns: [
          "key_hash", "name", "prefix",
          "can_upload", "can_download", "expires_at",
        ],
        check: {},
      },
    },
    "already exists"
  );

  // UPDATE — only the two mutable fields; filter by id via the query itself
  await metadataCall(
    "pg_create_update_permission",
    {
      source: "default",
      table,
      role,
      permission: {
        columns: ["is_active", "last_used_at"],
        filter: {},
        check: {},
      },
    },
    "already exists"
  );
}

// ─── Main entry point ──────────────────────────────────────────────────────────

export async function ensureSchema(): Promise<void> {
  console.log("  Checking database schema via Hasura...");

  await runSql(SCHEMA_SQL);
  console.log("  ✓ Tables are up to date");

  await metadataCall(
    "pg_track_table",
    { source: "default", schema: "public", name: "api_keys" },
    "already tracked"
  );
  console.log(`  ✓ Table "public.api_keys" is tracked in Hasura`);

  const role = env.HASURA_SERVICE_ROLE;
  await ensureRolePermissions(role);
  console.log(`  ✓ Role "${role}" has limited permissions on api_keys (no access to other tables)`);
}
