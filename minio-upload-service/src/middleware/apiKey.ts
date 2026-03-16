import { Request, Response, NextFunction } from "express";

const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  throw new Error("Missing required environment variable: API_KEY");
}

/**
 * Simple API key authentication.
 * Clients must send:  Authorization: Bearer <API_KEY>
 *
 * The /health endpoint is intentionally excluded so load balancers and
 * Cloudflare health checks can reach it without credentials.
 */
export function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers["authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }

  const token = authHeader.slice(7); // strip "Bearer "

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(token, API_KEY!)) {
    res.status(403).json({ error: "Invalid API key" });
    return;
  }

  next();
}

/** Poor-man's constant-time string comparison (Node < 21 doesn't expose timingSafeEqual for strings) */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
