/**
 * Admin endpoints for browsing and deleting files.
 * All routes require the MASTER_API_KEY.
 */
import { Router, Request, Response } from "express";
import { listFiles, softDeleteFile, getStatsOverview, getActivityLast30Days, getFolderSizeStats } from "../../config/files";
import { listFolders } from "../../config/folders";
import { isValidUuid } from "../../middleware/validate";
import { safeEqual } from "../../utils/crypto";

const router = Router();

// ─── Background stats worker ──────────────────────────────────────────────────

let statsCache: { data: unknown; ts: number } | null = null;
const STATS_INTERVAL = 2 * 60 * 1000; // refresca cada 2 min

async function computeStats(): Promise<void> {
  try {
    const [overview, activity, folders] = await Promise.all([
      getStatsOverview(),
      getActivityLast30Days(),
      listFolders(),
    ]);
    const folderStats = await Promise.all(folders.map(async f => {
      const s = await getFolderSizeStats(f.name);
      return { name: f.name, id: f.id, file_count: s.file_count, size_bytes: s.size_bytes };
    }));
    statsCache = { data: { overview, activity_30d: activity, by_folder: folderStats }, ts: Date.now() };
    console.log("[stats worker] cache refreshed");
  } catch (err) {
    console.error("[stats worker] refresh failed:", err);
  }
}

// Corre al arrancar y cada 2 minutos en background
computeStats();
setInterval(computeStats, STATS_INTERVAL);

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

// ─── GET /admin/files ─────────────────────────────────────────────────────────

router.get("/files", async (req: Request, res: Response): Promise<void> => {
  if (!requireMaster(req, res)) return;

  const folder = typeof req.query.folder === "string" ? req.query.folder : undefined;

  try {
    const files = await listFiles(folder);
    res.json({ files });
  } catch (err) {
    console.error("[admin/files] list error:", err);
    res.status(500).json({ error: "Failed to list files" });
  }
});

// ─── DELETE /admin/files/:id ──────────────────────────────────────────────────

router.delete("/files/:id", async (req: Request, res: Response): Promise<void> => {
  if (!requireMaster(req, res)) return;

  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ error: "id must be a valid UUID" });
    return;
  }

  try {
    const deleted = await softDeleteFile(id);
    if (!deleted) {
      res.status(404).json({ error: "File not found or already deleted" });
      return;
    }
    res.json({ message: "File deleted", id });
  } catch (err) {
    console.error("[admin/files] delete error:", err);
    res.status(500).json({ error: "Failed to delete file" });
  }
});

// ─── GET /admin/stats ─────────────────────────────────────────────────────────

router.get("/stats", (req: Request, res: Response): void => {
  if (!requireMaster(req, res)) return;
  if (!statsCache) {
    res.status(503).json({ error: "Stats not ready yet, retry in a few seconds" });
    return;
  }
  res.json(statsCache.data);
});

export default router;
