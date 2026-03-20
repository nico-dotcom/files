/**
 * Database migration runner.
 *
 * On every startup this module:
 *   1. Ensures a `schema_migrations` table exists (creates it if not).
 *   2. Reads every *.sql file inside the `migrations/` directory (sorted).
 *   3. Skips files that are already recorded in `schema_migrations`.
 *   4. Applies each pending file inside a transaction and records it.
 *
 * To add a schema change just drop a new file in migrations/, e.g.:
 *   migrations/002_add_tags_to_files.sql
 */

import fs from "fs";
import path from "path";
import { db as pool } from "./db";

// Path to the migrations directory (relative to the compiled output the path
// resolves correctly because the SQL files are copied alongside the JS bundle,
// but during development we point directly at the source tree).
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      id         serial      PRIMARY KEY,
      filename   text        NOT NULL UNIQUE,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrations(): Promise<Set<string>> {
  const result = await pool.query<{ filename: string }>(
    "SELECT filename FROM public.schema_migrations ORDER BY id"
  );
  return new Set(result.rows.map((r) => r.filename));
}

function readMigrationFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // lexicographic order — 001_, 002_, ... guarantees correct sequence
}

export async function runMigrations(): Promise<void> {
  await ensureMigrationsTable();

  const applied = await appliedMigrations();
  const files = readMigrationFiles();
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log("✓ Database schema is up to date");
    return;
  }

  console.log(`  Running ${pending.length} pending migration(s)…`);

  for (const filename of pending) {
    const filepath = path.join(MIGRATIONS_DIR, filename);
    const sql = fs.readFileSync(filepath, "utf8");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO public.schema_migrations (filename) VALUES ($1)",
        [filename]
      );
      await client.query("COMMIT");
      console.log(`  ✓ Applied migration: ${filename}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration "${filename}" failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  console.log("✓ All migrations applied");
}
