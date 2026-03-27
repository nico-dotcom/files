/**
 * Admin endpoints for managing scoped API keys.
 * All routes require the MASTER_API_KEY (Authorization: Bearer <MASTER_API_KEY>).
 */
import { Router, Request, Response } from "express";
import { createApiKey, revokeApiKey, listApiKeys, getApiKeyById } from "../../config/apiKeys";
import { isValidUuid } from "../../middleware/validate";
import { safeEqual } from "../../utils/crypto";

const router = Router();

// ─── Only master key can manage keys ─────────────────────────────────────────

function requireMaster(req: Request, res: Response): boolean {
  const master = process.env.MASTER_API_KEY;
  if (!master) {
    res.status(503).json({ error: "MASTER_API_KEY not configured" });
    return false;
  }
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!safeEqual(token, master)) {
    res.status(403).json({ error: "Master key required" });
    return false;
  }
  return true;
}

// ─── GET /admin/keys ─────────────────────────────────────────────────────────

router.get("/keys", async (req: Request, res: Response): Promise<void> => {
  if (!requireMaster(req, res)) return;
  try {
    const keys = await listApiKeys();
    res.json({ keys });
  } catch (err) {
    console.error("[admin/keys] list error:", err);
    res.status(500).json({ error: "Failed to list keys" });
  }
});

// ─── POST /admin/keys ────────────────────────────────────────────────────────
/**
 * Create a new scoped API key.
 *
 * Body:
 *   name         string   Human label, e.g. "Frontend – infopublica"
 *   prefix       string   Folder scope, e.g. "infopublica/" or "*"
 *   can_upload   boolean  (default true)
 *   can_download boolean  (default true)
 *   expires_at   string?  ISO date, e.g. "2025-12-31T00:00:00Z" (optional)
 *
 * The raw key is returned ONCE and never stored.
 */
router.post("/keys", async (req: Request, res: Response): Promise<void> => {
  if (!requireMaster(req, res)) return;

  const { name, prefix, can_upload, can_download, expires_at } = req.body;

  if (typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  if (typeof prefix !== "string" || prefix.trim().length === 0) {
    res.status(400).json({ error: "prefix is required (use \"*\" for full access)" });
    return;
  }

  // Validate prefix format: must be "*" or end with "/"
  const cleanPrefix = prefix.trim();
  if (cleanPrefix !== "*" && !cleanPrefix.endsWith("/")) {
    res.status(400).json({
      error: 'prefix must be "*" or a folder path ending with "/" (e.g. "infopublica/")',
    });
    return;
  }

  if (typeof can_upload !== "boolean") {
    res.status(400).json({ error: "can_upload must be a boolean" });
    return;
  }

  if (typeof can_download !== "boolean") {
    res.status(400).json({ error: "can_download must be a boolean" });
    return;
  }

  if (expires_at !== undefined && expires_at !== null) {
    const expiryDate = new Date(expires_at);
    if (isNaN(expiryDate.getTime()) || expiryDate <= new Date()) {
      res.status(400).json({ error: "expires_at must be a valid ISO date in the future" });
      return;
    }
  }

  try {
    const { record, rawKey } = await createApiKey({
      name: name.trim(),
      prefix: cleanPrefix,
      can_upload,
      can_download,
      expires_at: expires_at ?? null,
    });

    res.status(201).json({
      message: "API key created. The raw key is shown only once — save it now.",
      key: rawKey,       // raw bearer token — shown ONCE
      id: record.id,
      name: record.name,
      prefix: record.prefix,
      can_upload: record.can_upload,
      can_download: record.can_download,
      expires_at: record.expires_at,
      created_at: record.created_at,
    });
  } catch (err) {
    console.error("[admin/keys] create error:", err);
    res.status(500).json({ error: "Failed to create key" });
  }
});

// ─── DELETE /admin/keys/:id ───────────────────────────────────────────────────

router.delete("/keys/:id", async (req: Request, res: Response): Promise<void> => {
  if (!requireMaster(req, res)) return;

  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ error: "id must be a valid UUID" });
    return;
  }

  try {
    const revoked = await revokeApiKey(id);
    if (!revoked) {
      res.status(404).json({ error: "Key not found" });
      return;
    }
    res.json({ message: "Key revoked", id });
  } catch (err) {
    console.error("[admin/keys] revoke error:", err);
    res.status(500).json({ error: "Failed to revoke key" });
  }
});

// ─── POST /admin/keys/:id/renew ───────────────────────────────────────────────
/**
 * Revokes the existing key and creates a new one with the same configuration.
 * Returns the new raw key (shown once).
 */
router.post("/keys/:id/renew", async (req: Request, res: Response): Promise<void> => {
  if (!requireMaster(req, res)) return;

  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ error: "id must be a valid UUID" });
    return;
  }

  try {
    const existing = await getApiKeyById(id);
    if (!existing) {
      res.status(404).json({ error: "Key not found" });
      return;
    }

    const { record, rawKey } = await createApiKey({
      name: existing.name,
      prefix: existing.prefix,
      can_upload: existing.can_upload,
      can_download: existing.can_download,
      expires_at: existing.expires_at,
    });

    await revokeApiKey(id);

    res.status(201).json({
      message: "Key renewed. The new raw key is shown only once — save it now.",
      key: rawKey,
      id: record.id,
      name: record.name,
      prefix: record.prefix,
      can_upload: record.can_upload,
      can_download: record.can_download,
      expires_at: record.expires_at,
      created_at: record.created_at,
    });
  } catch (err) {
    console.error("[admin/keys] renew error:", err);
    res.status(500).json({ error: "Failed to renew key" });
  }
});

export default router;
