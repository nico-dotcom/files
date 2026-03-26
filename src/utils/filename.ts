import path from "path";

/**
 * Sanitize a filename so it is safe to use as part of an object key.
 * - Strips directory traversal attempts
 * - Replaces spaces and special chars with dashes
 * - Lowercases everything
 * - Limits length to 200 chars
 */
export function sanitizeFilename(raw: string): string {
  const base = path.basename(raw);

  const clean = base
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9.\-_]/g, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, 200);

  return clean || "file";
}

/**
 * Sanitize a folder name for use in an object key.
 * Must be alphanumeric + dashes/underscores only, no slashes.
 */
export function sanitizeFolder(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "")
    .slice(0, 64) || "uploads";
}

/**
 * Build an S3/MinIO object key in the form:
 *   uploads/<userId>/<folder>/<date>/<uuid>-<sanitizedFilename>
 *
 * The <folder> segment makes scope-based access control possible:
 * a key scoped to "infopublica/" can only access keys under that folder.
 *
 * If no folder is provided, defaults to "general".
 */
export function buildObjectKey(
  userId: string,
  fileId: string,
  originalFilename: string,
  folder = "general"
): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const safeFile = sanitizeFilename(originalFilename);
  const safeFolder = sanitizeFolder(folder);
  return `uploads/${userId}/${safeFolder}/${date}/${fileId}-${safeFile}`;
}
