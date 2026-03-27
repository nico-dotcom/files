import { Request, Response, NextFunction } from "express";
import { findApiKey, isAllowed, ApiKeyRecord } from "../config/apiKeys";
import { safeEqual } from "../utils/crypto";

// Attach the resolved key record to the request so routes can read it
declare global {
  namespace Express {
    interface Request {
      apiKey?: ApiKeyRecord;
    }
  }
}

/**
 * Resolves the bearer token from the Authorization header against the
 * api_keys table. Attaches the key record to req.apiKey.
 *
 * Does NOT check prefix or operation — use checkScope() for that.
 * The /health and /dashboard routes skip this middleware entirely.
 */
export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const masterKey = process.env.MASTER_API_KEY;
  const authHeader = req.headers["authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization: Bearer <key>" });
    return;
  }

  const rawKey = authHeader.slice(7);

  // Master key gets full access — uses constant-time comparison
  if (masterKey && safeEqual(rawKey, masterKey)) {
    req.apiKey = {
      id: "master",
      name: "Master Key",
      prefix: "*",
      can_upload: true,
      can_download: true,
      can_delete: true,
      is_active: true,
      expires_at: null,
      created_at: new Date().toISOString(),
      last_used_at: null,
      folders: [],
    };
    next();
    return;
  }

  // DB-backed key lookup
  try {
    const keyRecord = await findApiKey(rawKey);
    if (!keyRecord) {
      res.status(403).json({ error: "Invalid or revoked API key" });
      return;
    }
    req.apiKey = keyRecord;
    next();
  } catch (err) {
    console.error("[apiKey] DB error during key lookup:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * Checks that req.apiKey has permission to access the given object key.
 * Must be called after requireApiKey middleware.
 */
export function checkScope(
  objectKey: string,
  operation: "upload" | "download",
  req: Request,
  res: Response
): boolean {
  const key = req.apiKey;
  if (!key) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }

  if (operation === "upload" && !key.can_upload) {
    res.status(403).json({ error: "This API key does not allow uploads" });
    return false;
  }

  if (operation === "download" && !key.can_download) {
    res.status(403).json({ error: "This API key does not allow downloads" });
    return false;
  }

  if (!isAllowed(key, objectKey)) {
    const scope = key.folders?.length
      ? key.folders.map(f => f.name).join(", ")
      : key.prefix;
    res.status(403).json({
      error: `Access denied: this key is scoped to "${scope}"`,
    });
    return false;
  }

  return true;
}
