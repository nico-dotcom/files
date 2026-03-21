/**
 * Schema setup via Hasura APIs.
 *
 * On every startup:
 *   1. Runs CREATE TABLE IF NOT EXISTS for each required table via /v2/query.
 *   2. Tracks any untracked tables via /v1/metadata so they appear in GraphQL.
 *
 * Safe to run multiple times — all operations are idempotent.
 */
import { env } from "./env";

// Derive base Hasura URL from the GraphQL endpoint
// e.g. "http://hasura:8080/v1/graphql" → "http://hasura:8080"
const HASURA_BASE = env.HASURA_GRAPHQL_URL.replace(/\/v\d+\/graphql$/, "");

const HEADERS = {
  "Content-Type": "application/json",
  "x-hasura-admin-secret": env.HASURA_ADMIN_SECRET,
};

/** Execute raw SQL against the Hasura-connected database */
async function runSql(sql: string): Promise<void> {
  const res = await fetch(`${HASURA_BASE}/v2/query`, {
    method: "POST",
    headers: HEADERS,
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

/** Track a table in Hasura metadata so it's accessible via GraphQL */
async function trackTable(schema: string, table: string): Promise<void> {
  const res = await fetch(`${HASURA_BASE}/v1/metadata`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      type: "pg_track_table",
      args: { source: "default", schema, name: table },
    }),
  });

  if (!res.ok) {
    const body = await res.json() as { error?: string; internal?: { error?: { message?: string } } };
    const msg = body.error ?? body.internal?.error?.message ?? "";
    // "already tracked" is fine — skip silently
    if (!msg.toLowerCase().includes("already tracked")) {
      throw new Error(`Hasura track_table "${schema}.${table}" failed (${res.status}): ${msg}`);
    }
  }
}

// ─── Schema definitions ────────────────────────────────────────────────────────

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

// ─── Main entry point ──────────────────────────────────────────────────────────

export async function ensureSchema(): Promise<void> {
  console.log("  Checking database schema via Hasura...");

  await runSql(SCHEMA_SQL);
  console.log("  ✓ Tables are up to date");

  await trackTable("public", "api_keys");
  console.log(`  ✓ Table "public.api_keys" is tracked in Hasura`);
}
