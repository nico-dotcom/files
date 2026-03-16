-- API keys table for scoped bucket access
-- Run after init.sql (or add to it)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS public.api_keys (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The actual secret sent in Authorization: Bearer <key_hash>
    -- We store only the SHA-256 hash, never the raw key.
    key_hash    text        NOT NULL UNIQUE,
    -- Human label for the dashboard
    name        text        NOT NULL,
    -- Folder prefix this key can access, e.g. "infopublica/" or "*" for all
    prefix      text        NOT NULL DEFAULT '*',
    -- What operations are allowed
    can_upload  boolean     NOT NULL DEFAULT true,
    can_download boolean    NOT NULL DEFAULT true,
    -- Soft delete / revoke
    is_active   boolean     NOT NULL DEFAULT true,
    -- Optional: expiry date
    expires_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash  ON public.api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_is_active ON public.api_keys (is_active);

-- Comments
COMMENT ON COLUMN public.api_keys.prefix IS
  'Path prefix the key can access. Use "*" for full access. '
  'Example: "infopublica/" restricts to objects under uploads/<userId>/infopublica/';
COMMENT ON COLUMN public.api_keys.key_hash IS
  'SHA-256 hex digest of the raw bearer token. The raw token is shown only once at creation.';
