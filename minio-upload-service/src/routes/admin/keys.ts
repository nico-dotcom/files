/**
 * Admin endpoints for managing scoped API keys.
 * All routes require the MASTER_API_KEY (Authorization: Bearer <MASTER_API_KEY>).
 */
import { Router, Request, Response } from "express";
import { createApiKey, revokeApiKey, listApiKeys } from "../../config/apiKeys";
import { isValidUuid } from "../../middleware/validate";

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

  if (!timingSafeEqual(token, master)) {
    res.status(403).json({ error: "Master key required" });
    return false;
  }
  return true;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── GET /admin/keys ─────────────────────────────────────────────────────────

router.get("/admin/keys", async (req: Request, res: Response): Promise<void> => {
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
router.post("/admin/keys", async (req: Request, res: Response): Promise<void> => {
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

  if (expires_at !== undefined && expires_at !== null) {
    if (isNaN(Date.parse(expires_at))) {
      res.status(400).json({ error: "expires_at must be a valid ISO date string" });
      return;
    }
  }

  try {
    const { record, rawKey } = await createApiKey({
      name: name.trim(),
      prefix: cleanPrefix,
      can_upload: can_upload !== false,
      can_download: can_download !== false,
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

router.delete("/admin/keys/:id", async (req: Request, res: Response): Promise<void> => {
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

export default router;
