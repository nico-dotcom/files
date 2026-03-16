# minio-upload-service

Secure file upload microservice using **MinIO presigned URLs** + **Hasura GraphQL**.
No file bytes ever pass through this service — the client uploads directly to MinIO.

```
Frontend → POST /create-upload → presigned PUT URL
Frontend → PUT <uploadUrl>     → MinIO (direct)
Frontend → POST /confirm-upload → Hasura status = "uploaded"
Frontend → POST /create-download-url → presigned GET URL
```

---

## Project structure

```
minio-upload-service/
├── src/
│   ├── config/
│   │   ├── env.ts            # Typed, validated env vars
│   │   ├── minio.ts          # MinIO client + bucket check
│   │   └── hasura.ts         # Minimal GraphQL client
│   ├── middleware/
│   │   └── validate.ts       # Request validation + MIME allowlist
│   ├── routes/
│   │   ├── createUpload.ts        # POST /create-upload
│   │   ├── confirmUpload.ts       # POST /confirm-upload
│   │   └── createDownloadUrl.ts   # POST /create-download-url
│   ├── utils/
│   │   └── filename.ts       # Filename sanitization + object key builder
│   └── index.ts              # Express app + startup
├── examples/
│   ├── frontend-upload.ts    # Browser upload example (TypeScript)
│   └── api-requests.http     # REST Client / cURL examples
├── sql/
│   └── init.sql              # Table definition (if starting fresh)
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── tsconfig.json
```

---

## Quick start

### 1. Clone and install

```bash
cd minio-upload-service
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your MinIO and Hasura credentials
```

### 3. Run in development

```bash
npm run dev
```

### 4. Build and run in production

```bash
npm run build
npm start
```

---

## Docker

### Build and run with Docker Compose

```bash
# Copy and fill in secrets
cp .env.example .env

# Start the full stack (MinIO + PostgreSQL + Hasura + upload service)
docker compose up -d

# View logs
docker compose logs -f minio-upload-service
```

### Run only the upload service (if MinIO/Hasura run elsewhere)

```bash
docker build -t minio-upload-service .
docker run -p 3001:3001 --env-file .env minio-upload-service
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | no | `3001` | HTTP port |
| `S3_ENDPOINT` | **yes** | — | MinIO hostname (no protocol) |
| `S3_PORT` | no | `9000` | MinIO API port |
| `S3_USE_SSL` | no | `false` | Enable TLS for MinIO connection |
| `S3_ACCESS_KEY` | **yes** | — | MinIO access key |
| `S3_SECRET_KEY` | **yes** | — | MinIO secret key |
| `S3_BUCKET` | **yes** | — | Target bucket name |
| `PRESIGNED_URL_EXPIRY_SECONDS` | no | `900` | Presigned URL lifetime (15 min) |
| `MAX_FILE_SIZE_BYTES` | no | `104857600` | Max upload size (100 MB) |
| `HASURA_GRAPHQL_URL` | **yes** | — | Full Hasura GraphQL endpoint URL |
| `HASURA_ADMIN_SECRET` | **yes** | — | Hasura admin secret |

---

## API reference

### `GET /health`

```json
{ "status": "ok", "timestamp": "2024-01-15T10:30:00.000Z" }
```

---

### `POST /create-upload`

Request:
```json
{
  "filename":  "report.pdf",
  "mimeType":  "application/pdf",
  "sizeBytes": 204800,
  "userId":    "550e8400-e29b-41d4-a716-446655440000"
}
```

Success `201`:
```json
{
  "fileId":           "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "uploadUrl":        "http://localhost:9000/files/uploads/...?X-Amz-Signature=...",
  "objectKey":        "uploads/550e8400-.../2024-01-15/a1b2c3d4-report.pdf",
  "expiresInSeconds": 900
}
```

---

### `POST /confirm-upload`

Request:
```json
{ "fileId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }
```

Success `200`:
```json
{
  "fileId":           "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status":           "uploaded",
  "uploadedAt":       "2024-01-15T10:31:05.123Z",
  "objectKey":        "uploads/550e8400-.../2024-01-15/a1b2c3d4-report.pdf",
  "originalFilename": "report.pdf"
}
```

Error `422` (object not in MinIO yet):
```json
{ "error": "Object not found in storage. Complete the upload before confirming." }
```

---

### `POST /create-download-url`

Request:
```json
{ "fileId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }
```

Success `200`:
```json
{
  "downloadUrl":      "http://localhost:9000/files/uploads/...?X-Amz-Signature=...",
  "expiresInSeconds": 900,
  "originalFilename": "report.pdf",
  "mimeType":         "application/pdf",
  "objectKey":        "uploads/550e8400-.../2024-01-15/a1b2c3d4-report.pdf"
}
```

---

## Security notes

| Concern | How it's handled |
|---|---|
| Secret key exposure | `S3_SECRET_KEY` and `HASURA_ADMIN_SECRET` are server-side only |
| Presigned URL expiry | Configurable, defaults to 15 minutes |
| Filename injection | `sanitizeFilename()` strips path traversal, special chars |
| MIME type allowlist | Only explicitly allowed MIME types are accepted |
| Fake confirmations | `confirm-upload` calls `minioClient.statObject` to verify the object actually exists |
| Payload size | JSON body limit set to 16 KB; file size validated via `sizeBytes` |
| Rate limiting | 60 req/min per IP via `express-rate-limit` |
| HTTP headers | `helmet` sets secure headers (CSP, HSTS, etc.) |
| Non-root container | Docker image runs as `appuser`, not root |

---

## Hasura setup

1. Track the `public.files` table in Hasura console
2. Add the following permission or use the admin secret (server-side only):
   - Insert: allowed for your backend role
   - Select: allowed for your backend role
   - Update: allowed fields — `status`, `uploaded_at`

---

## cURL examples

```bash
# 1. Create upload
curl -s -X POST http://localhost:3001/create-upload \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "test.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 1024,
    "userId": "550e8400-e29b-41d4-a716-446655440000"
  }' | jq .

# 2. Upload file to MinIO (use uploadUrl from step 1)
curl -s -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/pdf" \
  --data-binary @test.pdf

# 3. Confirm (use fileId from step 1)
curl -s -X POST http://localhost:3001/confirm-upload \
  -H "Content-Type: application/json" \
  -d '{"fileId": "'$FILE_ID'"}' | jq .

# 4. Get download URL
curl -s -X POST http://localhost:3001/create-download-url \
  -H "Content-Type: application/json" \
  -d '{"fileId": "'$FILE_ID'"}' | jq .
```
