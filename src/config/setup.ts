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
    can_delete   boolean     NOT NULL DEFAULT false,
    is_active    boolean     NOT NULL DEFAULT true,
    expires_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
  );

  ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS can_delete boolean NOT NULL DEFAULT false;

  CREATE INDEX IF NOT EXISTS api_keys_is_active_idx ON public.api_keys (is_active);

  CREATE TABLE IF NOT EXISTS public.file_events (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type   text        NOT NULL,
    file_id      uuid,
    api_key_id   text,
    object_key   text,
    mime_type    text,
    size_bytes   bigint,
    created_at   timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS file_events_created_at_idx ON public.file_events (created_at DESC);
  CREATE INDEX IF NOT EXISTS file_events_api_key_id_idx ON public.file_events (api_key_id);

  CREATE TABLE IF NOT EXISTS public.folders (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text        NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.api_key_folders (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_id uuid NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
    folder_id  uuid NOT NULL REFERENCES public.folders(id) ON DELETE CASCADE,
    UNIQUE (api_key_id, folder_id)
  );

  CREATE TABLE IF NOT EXISTS public.files (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket            text        NOT NULL,
    object_key        text        NOT NULL UNIQUE,
    original_filename text        NOT NULL,
    mime_type         text        NOT NULL,
    size_bytes        bigint      NOT NULL,
    owner_user_id     uuid        NOT NULL,
    status            text        NOT NULL DEFAULT 'pending',
    created_at        timestamptz NOT NULL DEFAULT now(),
    deleted_at        timestamptz
  );

  ALTER TABLE public.files ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

  CREATE INDEX IF NOT EXISTS files_owner_user_id_idx ON public.files (owner_user_id);
  CREATE INDEX IF NOT EXISTS files_status_idx ON public.files (status);
  CREATE INDEX IF NOT EXISTS files_deleted_at_idx ON public.files (deleted_at) WHERE deleted_at IS NULL;
`;

/** Create a many-to-one (object) relationship using a FK column */
async function createObjectRelationship(
  table: string,
  name: string,
  fkColumn: string
): Promise<void> {
  const res = await fetch(`${HASURA_BASE}/v1/metadata`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      type: "pg_create_object_relationship",
      args: {
        source: "default",
        table: { schema: "public", name: table },
        name,
        using: { foreign_key_constraint_on: fkColumn },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.json() as { error?: string };
    const msg = (body.error ?? "").toLowerCase();
    if (!msg.includes("already exists") && !msg.includes("already defined")) {
      throw new Error(`Hasura object relationship "${table}.${name}" failed: ${body.error}`);
    }
  }
}

/** Create a one-to-many (array) relationship pointing at a remote table's FK column */
async function createArrayRelationship(
  table: string,
  name: string,
  remoteTable: string,
  remoteColumn: string
): Promise<void> {
  const res = await fetch(`${HASURA_BASE}/v1/metadata`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      type: "pg_create_array_relationship",
      args: {
        source: "default",
        table: { schema: "public", name: table },
        name,
        using: {
          foreign_key_constraint_on: {
            table: { schema: "public", name: remoteTable },
            column: remoteColumn,
          },
        },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.json() as { error?: string };
    const msg = (body.error ?? "").toLowerCase();
    if (!msg.includes("already exists") && !msg.includes("already defined")) {
      throw new Error(`Hasura array relationship "${table}.${name}" failed: ${body.error}`);
    }
  }
}

// ─── Main entry point ──────────────────────────────────────────────────────────

export async function ensureSchema(): Promise<void> {
  console.log("  Checking database schema via Hasura...");

  await runSql(SCHEMA_SQL);
  console.log("  ✓ Tables are up to date");

  await trackTable("public", "api_keys");
  console.log(`  ✓ Table "public.api_keys" is tracked in Hasura`);

  await trackTable("public", "file_events");
  console.log(`  ✓ Table "public.file_events" is tracked in Hasura`);

  await trackTable("public", "folders");
  await trackTable("public", "api_key_folders");
  console.log(`  ✓ Tables "public.folders" and "public.api_key_folders" are tracked in Hasura`);

  await trackTable("public", "files");
  console.log(`  ✓ Table "public.files" is tracked in Hasura`);

  // Relationships so we can query nested folders from api_keys
  await createObjectRelationship("api_key_folders", "folder", "folder_id");
  await createObjectRelationship("api_key_folders", "api_key", "api_key_id");
  await createArrayRelationship("api_keys", "api_key_folders", "api_key_folders", "api_key_id");
  await createArrayRelationship("folders", "api_key_folders", "api_key_folders", "folder_id");
  console.log(`  ✓ Hasura relationships configured`);
}
