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
import adminFilesRouter from "./routes/admin/files";
import adminShareRouter from "./routes/admin/share";
import deleteFileRouter from "./routes/deleteFile";

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
        // Allow connecting to MinIO's public URL so the test page can PUT presigned uploads
        connectSrc: ["'self'", env.S3_PUBLIC_URL],
        imgSrc:     ["'self'", "data:", env.S3_PUBLIC_URL],
        // Shrink the blast radius of any injection: no plugins, no <base> hijack,
        // page can't be framed, forms can only post back to this origin.
        objectSrc:     ["'none'"],
        baseUri:       ["'self'"],
        frameAncestors:["'none'"],
        formAction:    ["'self'"],
      },
    },
    // Extra response-header hardening (most are helmet defaults; set explicitly).
    referrerPolicy: { policy: "no-referrer" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    hsts: { maxAge: 15552000, includeSubDomains: true },
  })
);

app.use(express.json({ limit: "16kb" }));

// General rate limit — per client IP (Cloudflare sets X-Forwarded-For; trust proxy=1).
// Kept generous because project backends can burst legitimate traffic through a
// single shared IP; tune down once per-IP traffic patterns are known.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});
app.use(limiter);

// Rate limit on admin endpoints — protected by master key auth, so limit is generous.
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
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

app.get("/test", (_req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "test.html"));
});

app.get("/uploader", (_req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "uploader.html"));
});

// Static files for the dashboard (JS files — served from /static/)
app.use(
  "/static",
  express.static(path.join(__dirname, "dashboard"), {
    maxAge: 0,           // no browser cache — always fetch fresh JS/CSS
    index: false,        // don't serve index.html from /static/
    dotfiles: "deny",    // never serve hidden files
  })
);

// ─── Admin routes (master key required — enforced inside the router) ──────────

app.use("/admin", adminLimiter, adminKeysRouter);
app.use("/admin", adminLimiter, adminFoldersRouter);
app.use("/admin", adminLimiter, adminFilesRouter);
app.use("/", adminLimiter, adminShareRouter);

// ─── API routes (scoped API key required) ─────────────────────────────────────

app.use("/", requireApiKey, createUploadRouter);
app.use("/", requireApiKey, confirmUploadRouter);
app.use("/", requireApiKey, createDownloadUrlRouter);
app.use("/", requireApiKey, deleteFileRouter);

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

// ─── Process-level safety nets ────────────────────────────────────────────────
// Sin esto, un rechazo no manejado (p.ej. un blip de Hasura en un worker de fondo)
// puede dejar el proceso muerto o zombie sin que PM2 lo note. Política:
//  - unhandledRejection → log y SEGUIR (no tumbar el server por un error transitorio).
//  - uncaughtException   → log y SALIR (PM2 reinicia limpio; algo quedó inconsistente).

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  process.exit(1);
});

// ─── Startup ──────────────────────────────────────────────────────────────────
// Se ESCUCHA primero (el puerto y /health quedan arriba al instante, así Cloudflare
// nunca ve 502 por un arranque lento). El schema de Hasura y el bucket de MinIO se
// verifican en segundo plano CON REINTENTOS, atravesando blips transitorios. Las
// rutas de upload ya hablan con Hasura por request, así que no dependen de esto.

async function ensureDependenciesWithRetry(): Promise<void> {
  let delay = 2000;
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureSchema();
      await verifyMinioBucket();
      console.log("✓ Hasura schema + MinIO bucket verificados");
      return;
    } catch (err) {
      console.error(
        `[startup] dependencias no listas (intento ${attempt}), reintento en ${delay}ms:`,
        (err as Error).message
      );
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30000);   // backoff exponencial, tope 30s
    }
  }
}

function start(): void {
  const server = app.listen(env.PORT, () => {
    console.log(`✓ minio-upload-service listening on port ${env.PORT}`);
    console.log(`  Dashboard: http://localhost:${env.PORT}/dashboard`);
  });

  // Un error del propio servidor HTTP (p.ej. EADDRINUSE) sí es fatal → salir y que PM2 reinicie.
  server.on("error", (err) => {
    console.error("[fatal] HTTP server error:", err);
    process.exit(1);
  });

  void ensureDependenciesWithRetry();
}

start();
