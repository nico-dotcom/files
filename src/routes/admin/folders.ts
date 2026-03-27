import { Router, Request, Response } from "express";
import { createFolder, listFolders, deleteFolder } from "../../config/folders";
import { isValidUuid } from "../../middleware/validate";
import { safeEqual } from "../../utils/crypto";

const router = Router();

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

// ─── GET /admin/folders ───────────────────────────────────────────────────────

router.get("/folders", async (req: Request, res: Response): Promise<void> => {
  if (!requireMaster(req, res)) return;
  try {
    const folders = await listFolders();
    res.json({ folders });
  } catch (err) {
    console.error("[admin/folders] list error:", err);
    res.status(500).json({ error: "Failed to list folders" });
  }
});

// ─── POST /admin/folders ──────────────────────────────────────────────────────

router.post("/folders", async (req: Request, res: Response): Promise<void> => {
  if (!requireMaster(req, res)) return;

  const { name } = req.body;

  if (typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9/_-]/g, "-").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");

  if (!cleanName) {
    res.status(400).json({ error: "Invalid folder name" });
    return;
  }

  try {
    const folder = await createFolder(cleanName);
    res.status(201).json({ folder });
  } catch (err: unknown) {
    const msg = String(err);
    if (msg.includes("unique") || msg.includes("duplicate")) {
      res.status(409).json({ error: "A folder with that name already exists" });
      return;
    }
    console.error("[admin/folders] create error:", err);
    res.status(500).json({ error: "Failed to create folder" });
  }
});

// ─── DELETE /admin/folders/:id ────────────────────────────────────────────────

router.delete("/folders/:id", async (req: Request, res: Response): Promise<void> => {
  if (!requireMaster(req, res)) return;

  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ error: "id must be a valid UUID" });
    return;
  }

  try {
    const deleted = await deleteFolder(id);
    if (!deleted) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }
    res.json({ message: "Folder deleted", id });
  } catch (err) {
    console.error("[admin/folders] delete error:", err);
    res.status(500).json({ error: "Failed to delete folder" });
  }
});

export default router;
