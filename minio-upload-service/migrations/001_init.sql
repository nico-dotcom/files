-- Migration 001: initial schema
-- Creates the files and api_keys tables.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── files ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.files (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket            text        NOT NULL,
    object_key        text        NOT NULL,
    original_filename text,
    mime_type         text,
    size_bytes        bigint,
    owner_user_id     uuid,
    status            text        NOT NULL DEFAULT 'pending',
    created_at        timestamptz NOT NULL DEFAULT now(),
    uploaded_at       timestamptz,

    CONSTRAINT files_status_check
        CHECK (status IN ('pending', 'uploaded', 'failed', 'deleted'))
);

CREATE INDEX IF NOT EXISTS idx_files_owner_user_id ON public.files (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_files_status         ON public.files (status);
CREATE INDEX IF NOT EXISTS idx_files_created_at     ON public.files (created_at DESC);

-- ─── api_keys ─────────────────────────────────────────────────────────────────

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

CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash  ON public.api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_is_active ON public.api_keys (is_active);

COMMENT ON COLUMN public.api_keys.prefix IS
  'Path prefix the key can access. Use "*" for full access. '
  'Example: "infopublica/" restricts to objects under uploads/<userId>/infopublica/';
COMMENT ON COLUMN public.api_keys.key_hash IS
  'SHA-256 hex digest of the raw bearer token. The raw token is shown only once at creation.';
