import { Router, Request, Response } from "express";
import { getFileById, softDeleteFile } from "../config/files";
import { isAllowed } from "../config/apiKeys";
import { isValidUuid } from "../middleware/validate";
import { logFileEvent } from "../config/fileEvents";

const router = Router();

/**
 * DELETE /files/:fileId
 *
 * Deletes a single file. Restrictions:
 *   - API key must have can_delete = true
 *   - API key scope must cover the file's object_key (same folder rules as upload/download)
 *   - File must not already be deleted
 *   - One file at a time — no bulk delete
 */
router.delete("/files/:fileId", async (req: Request, res: Response): Promise<void> => {
  const key = req.apiKey;
  if (!key) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  if (!key.can_delete) {
    res.status(403).json({ error: "This API key does not have delete permission" });
    return;
  }

  const { fileId } = req.params;
  if (!isValidUuid(fileId)) {
    res.status(400).json({ error: "fileId must be a valid UUID" });
    return;
  }

  let file;
  try {
    file = await getFileById(fileId);
  } catch (err) {
    console.error("[deleteFile] DB lookup error:", err);
    res.status(500).json({ error: "Failed to look up file" });
    return;
  }

  if (!file) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  if (file.deleted_at) {
    res.status(410).json({ error: "File already deleted" });
    return;
  }

  // Scope check — same folder rules as upload/download
  if (!isAllowed(key, file.object_key)) {
    const scope = key.folders?.length
      ? key.folders.map(f => f.name).join(", ")
      : key.prefix;
    res.status(403).json({
      error: `Access denied: this key is scoped to "${scope}"`,
    });
    return;
  }

  try {
    const deleted = await softDeleteFile(fileId);
    if (!deleted) {
      res.status(404).json({ error: "File not found or already deleted" });
      return;
    }
  } catch (err) {
    console.error("[deleteFile] delete error:", err);
    res.status(500).json({ error: "Failed to delete file" });
    return;
  }

  logFileEvent({
    event_type: "file_deleted",
    file_id: fileId,
    api_key_id: key.id,
    object_key: file.object_key,
    mime_type: file.mime_type,
    size_bytes: file.size_bytes,
  });

  res.json({ message: "File deleted", id: fileId });
});

export default router;
