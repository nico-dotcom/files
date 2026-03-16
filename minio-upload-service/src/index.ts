import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env } from "./config/env";
import { verifyMinioBucket } from "./config/minio";
import createUploadRouter from "./routes/createUpload";
import confirmUploadRouter from "./routes/confirmUpload";
import createDownloadUrlRouter from "./routes/createDownloadUrl";

const app = express();

// ─── Security middleware ──────────────────────────────────────────────────────

// Sets secure HTTP headers
app.use(helmet());

// Parse JSON bodies (limit size to prevent DoS via huge payloads)
app.use(express.json({ limit: "16kb" }));

// Rate limiting — 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});
app.use(limiter);

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use("/", createUploadRouter);
app.use("/", confirmUploadRouter);
app.use("/", createDownloadUrlRouter);

// ─── 404 handler ─────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ─── Global error handler ─────────────────────────────────────────────────────

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
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
