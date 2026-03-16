import { Request, Response, NextFunction } from "express";
import { env } from "../config/env";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value);
}

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "text/plain",
  "text/csv",
  "application/json",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
]);

export function validateCreateUpload(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const { filename, mimeType, sizeBytes, userId } = req.body;

  if (typeof filename !== "string" || filename.trim().length === 0) {
    res.status(400).json({ error: "filename is required and must be a string" });
    return;
  }

  if (typeof mimeType !== "string" || !ALLOWED_MIME_TYPES.has(mimeType)) {
    res.status(400).json({
      error: `mimeType "${mimeType}" is not allowed`,
      allowed: Array.from(ALLOWED_MIME_TYPES),
    });
    return;
  }

  if (
    typeof sizeBytes !== "number" ||
    !Number.isInteger(sizeBytes) ||
    sizeBytes <= 0
  ) {
    res
      .status(400)
      .json({ error: "sizeBytes must be a positive integer" });
    return;
  }

  if (sizeBytes > env.MAX_FILE_SIZE_BYTES) {
    res.status(400).json({
      error: `File size ${sizeBytes} exceeds maximum allowed size of ${env.MAX_FILE_SIZE_BYTES} bytes`,
    });
    return;
  }

  if (!isValidUuid(userId)) {
    res.status(400).json({ error: "userId must be a valid UUID" });
    return;
  }

  next();
}

export function validateFileId(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const { fileId } = req.body;
  if (!isValidUuid(fileId)) {
    res.status(400).json({ error: "fileId must be a valid UUID" });
    return;
  }
  next();
}
