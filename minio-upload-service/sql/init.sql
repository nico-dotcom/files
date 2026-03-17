-- Run once at database initialization.
-- If the table already exists in your database, skip this file.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS public.files (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket           text        NOT NULL,
    object_key       text        NOT NULL,
    original_filename text,
    mime_type        text,
    size_bytes       bigint,
    owner_user_id    uuid,
    status           text        NOT NULL DEFAULT 'pending',
    created_at       timestamptz NOT NULL DEFAULT now(),
    uploaded_at      timestamptz,

    CONSTRAINT files_status_check
        CHECK (status IN ('pending', 'uploaded', 'failed', 'deleted'))
);

CREATE INDEX IF NOT EXISTS idx_files_owner_user_id ON public.files (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_files_status         ON public.files (status);
CREATE INDEX IF NOT EXISTS idx_files_created_at     ON public.files (created_at DESC);
