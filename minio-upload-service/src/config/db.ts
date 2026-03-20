/**
 * Minimal PostgreSQL client using the `pg` package.
 * Used only for api_keys management — Hasura handles the files table.
 */
import { Pool } from "pg";

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export const db = new Pool({
  host: process.env.POSTGRES_HOST || "localhost",
  port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
  database: requireEnv("POSTGRES_DB"),
  user: requireEnv("POSTGRES_USER"),
  password: requireEnv("POSTGRES_PASSWORD"),
  // Set POSTGRES_SSL=true to enforce encrypted connections (recommended in production).
  ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30_000,
});

db.on("error", (err) => {
  console.error("[pg] Unexpected pool error:", err);
});
