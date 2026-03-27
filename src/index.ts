import path from "path";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env } from "./config/env";
import { verifyMinioBucket } from "./config/minio";
import { ensureSchema } from "./config/setup";
import { requireApiKey } from "./middleware/apiKey";
import createUploadRouter from "./routes/createUpload";
import confirmUploadRouter from "./routes/confirmUpload";
import createDownloadUrlRouter from "./routes/createDownloadUrl";
import adminKeysRouter from "./routes/admin/keys";
import adminFoldersRouter from "./routes/admin/folders";

const app = express();

// Trust the first proxy (Cloudflare Tunnel sets X-Forwarded-For)
app.set("trust proxy", 1);

// ─── Security middleware ──────────────────────────────────────────────────────

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'"],           // no unsafe-inline — scripts served as files
        styleSrc:   ["'self'", "'unsafe-inline'"],  // inline styles only (no external CSS)
        connectSrc: ["'self'"],
        imgSrc:     ["'self'", "data:"],
      },
    },
  })
);

app.use(express.json({ limit: "16kb" }));

// General rate limit — 60 req/min per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});
app.use(limiter);

// Rate limit on admin endpoints — protected by master key auth, so limit is generous.
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin requests, please try again later" },
});

// ─── Health check (no auth) ───────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Dashboard (no auth — the page authenticates itself via master key) ───────
// Access at:  http://localhost:3001/dashboard
// Or via Cloudflare: https://api.yourdomain.com/dashboard
// Protect this route with Cloudflare Access in production for extra security.

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "index.html"));
});

// Static files for the dashboard (JS files — served from /static/)
app.use(
  "/static",
  express.static(path.join(__dirname, "dashboard"), {
    // Cache JS for 1 hour — bump when deploying changes
    maxAge: "1h",
    index: false,        // don't serve index.html from /static/
    dotfiles: "deny",    // never serve hidden files
  })
);

// ─── Admin routes (master key required — enforced inside the router) ──────────

app.use("/admin", adminLimiter, adminKeysRouter);
app.use("/admin", adminLimiter, adminFoldersRouter);

// ─── API routes (scoped API key required) ─────────────────────────────────────

app.use("/", requireApiKey, createUploadRouter);
app.use("/", requireApiKey, confirmUploadRouter);
app.use("/", requireApiKey, createDownloadUrlRouter);

// ─── 404 ─────────────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ─── Global error handler ────────────────────────────────────────────────────

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction
  ) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
);

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  try {
    await ensureSchema();
    await verifyMinioBucket();
    app.listen(env.PORT, () => {
      console.log(`✓ minio-upload-service listening on port ${env.PORT}`);
      console.log(`  Dashboard: http://localhost:${env.PORT}/dashboard`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
