import path from "path";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env } from "./config/env";
import { verifyMinioBucket } from "./config/minio";
import { requireApiKey } from "./middleware/apiKey";
import createUploadRouter from "./routes/createUpload";
import confirmUploadRouter from "./routes/confirmUpload";
import createDownloadUrlRouter from "./routes/createDownloadUrl";
import adminKeysRouter from "./routes/admin/keys";

const app = express();

// ─── Security middleware ──────────────────────────────────────────────────────

app.use(
  helmet({
    // Relax CSP for the dashboard (inline scripts needed)
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
      },
    },
  })
);

app.use(express.json({ limit: "16kb" }));

// Rate limiting — 60 req/min per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});
app.use(limiter);

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

// ─── Admin routes (master key required — enforced inside the router) ──────────

app.use("/", adminKeysRouter);

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
