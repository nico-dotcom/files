import path from "path";

/**
 * Sanitize a filename so it is safe to use as part of an object key.
 * - Strips directory traversal attempts
 * - Replaces spaces and special chars with dashes
 * - Lowercases everything
 * - Limits length to 200 chars
 */
export function sanitizeFilename(raw: string): string {
  // Remove any directory components
  const base = path.basename(raw);

  // Replace anything that is not alphanumeric, dot, dash, or underscore
  const clean = base
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9.\-_]/g, "")
    .replace(/\.{2,}/g, ".") // collapse multiple dots (prevent e.g. "../../")
    .slice(0, 200);

  return clean || "file";
}

/**
 * Build an S3/MinIO object key in the form:
 *   uploads/<userId>/<date>/<uuid>-<sanitizedFilename>
 */
export function buildObjectKey(
  userId: string,
  fileId: string,
  originalFilename: string
): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const safe = sanitizeFilename(originalFilename);
  return `uploads/${userId}/${date}/${fileId}-${safe}`;
}
