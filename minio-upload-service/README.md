# minio-upload-service

Secure file upload microservice using **MinIO presigned URLs** + **Hasura GraphQL**,
exposed externally via **Cloudflare Tunnel** (no open inbound ports).

```
Frontend → POST /create-upload        → Upload API (api.yourdomain.com)
Frontend → PUT  <presignedPutUrl>     → MinIO S3 direct (storage.yourdomain.com)
Frontend → POST /confirm-upload       → Upload API
Frontend → POST /create-download-url  → Upload API
Frontend → GET  <presignedGetUrl>     → MinIO S3 direct (storage.yourdomain.com)
```

---

## Project structure

```
minio-upload-service/
├── src/
│   ├── config/
│   │   ├── env.ts                  # Typed, validated env vars
│   │   ├── minio.ts                # MinIO client (internal) + public client (presigned URLs)
│   │   └── hasura.ts               # Minimal GraphQL client
│   ├── middleware/
│   │   ├── apiKey.ts               # Authorization: Bearer <API_KEY>
│   │   └── validate.ts             # MIME allowlist, UUID checks, size limits
│   ├── routes/
│   │   ├── createUpload.ts         # POST /create-upload
│   │   ├── confirmUpload.ts        # POST /confirm-upload
│   │   └── createDownloadUrl.ts    # POST /create-download-url
│   ├── utils/
│   │   └── filename.ts             # Sanitization + object key builder
│   └── index.ts                    # Express app + startup
├── cloudflared/
│   ├── config.yml                  # Cloudflare Tunnel ingress rules
│   └── .gitignore                  # Excludes credentials.json from git
├── examples/
│   ├── frontend-upload.ts          # Browser upload flow with progress
│   └── api-requests.http           # REST Client / cURL examples
├── sql/
│   └── init.sql                    # files table DDL
├── .env.example
├── Dockerfile
└── docker-compose.yml
```

---

## Quick start (local)

```bash
cd minio-upload-service
npm install
cp .env.example .env
# Edit .env — at minimum set S3_ACCESS_KEY, S3_SECRET_KEY, HASURA_ADMIN_SECRET, API_KEY
npm run dev
```

Build for production:

```bash
npm run build
npm start
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | no | `3001` | HTTP listen port |
| `API_KEY` | **yes** | — | Secret clients must send as `Authorization: Bearer` |
| `S3_ENDPOINT` | **yes** | — | MinIO hostname for internal connections (no protocol) |
| `S3_PORT` | no | `9000` | MinIO internal port |
| `S3_USE_SSL` | no | `false` | TLS for internal MinIO connection |
| `S3_ACCESS_KEY` | **yes** | — | MinIO access key |
| `S3_SECRET_KEY` | **yes** | — | MinIO secret key |
| `S3_BUCKET` | **yes** | — | Target bucket name |
| `S3_PUBLIC_URL` | no | — | Public MinIO URL via Cloudflare (e.g. `https://storage.yourdomain.com`) |
| `PRESIGNED_URL_EXPIRY_SECONDS` | no | `900` | Presigned URL lifetime (15 min) |
| `MAX_FILE_SIZE_BYTES` | no | `104857600` | Max upload size (100 MB) |
| `HASURA_GRAPHQL_URL` | **yes** | — | Full Hasura GraphQL endpoint URL |
| `HASURA_ADMIN_SECRET` | **yes** | — | Hasura admin secret |

Generate a strong API key:

```bash
openssl rand -hex 32
```

---

## Cloudflare Tunnel setup

### Why two hostnames?

| Hostname | Port | Who uses it |
|---|---|---|
| `api.yourdomain.com` | 3001 | Frontend → backend API calls |
| `storage.yourdomain.com` | 9000 | Frontend → direct MinIO uploads/downloads |

**The upload flow never proxies file bytes through the backend.** The backend only
generates a presigned URL. The browser then PUTs the file straight to
`storage.yourdomain.com`, which Cloudflare Tunnel forwards to MinIO port 9000.

This means you **must** expose MinIO's port 9000 through Cloudflare, not just the API.

### Critical: MINIO_SERVER_URL

MinIO embeds the server hostname inside every presigned URL it generates.
Without `MINIO_SERVER_URL`, that hostname is `localhost:9000` — useless to an
external browser.

Set in `docker-compose.yml` (already done):

```yaml
environment:
  MINIO_SERVER_URL: https://storage.yourdomain.com
```

The backend also uses `S3_PUBLIC_URL` when instantiating the MinIO SDK client
that generates presigned URLs, so both sides agree on the public hostname.

### Step-by-step Cloudflare Tunnel setup

**1. Install cloudflared on your Linux server**

```bash
# Debian/Ubuntu
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# Or via apt repo (recommended for auto-updates):
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

**2. Authenticate with your Cloudflare account**

```bash
cloudflared tunnel login
# Opens a browser — authorize the domain you want to use
# Saves a certificate to ~/.cloudflared/cert.pem
```

**3. Create a named tunnel**

```bash
cloudflared tunnel create my-app
# Output: Created tunnel my-app with id xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
# Credentials saved to ~/.cloudflared/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.json
```

**4. Copy credentials into the project**

```bash
cp ~/.cloudflared/<TUNNEL_ID>.json ./cloudflared/credentials.json
# This file is gitignored — never commit it
```

**5. Edit `cloudflared/config.yml`**

Replace the placeholders:

```yaml
tunnel: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx   # ← your tunnel ID
credentials-file: /etc/cloudflared/credentials.json

ingress:
  - hostname: api.yourdomain.com
    service: http://minio-upload-service:3001

  - hostname: storage.yourdomain.com
    service: http://minio:9000

  - hostname: minio-console.yourdomain.com     # optional
    service: http://minio:9001

  - service: http_status:404
```

**6. Create DNS records in Cloudflare**

```bash
cloudflared tunnel route dns my-app api.yourdomain.com
cloudflared tunnel route dns my-app storage.yourdomain.com
cloudflared tunnel route dns my-app minio-console.yourdomain.com   # optional
```

This creates CNAME records pointing to `<TUNNEL_ID>.cfargotunnel.com`.
Cloudflare handles HTTPS automatically — no certificates to manage.

**7. Set environment variables**

In your `.env`:

```env
S3_PUBLIC_URL=https://storage.yourdomain.com
MINIO_SERVER_URL=https://storage.yourdomain.com   # also in docker-compose.yml
```

**8. Start everything**

```bash
docker compose up -d
```

**9. Verify**

```bash
# Upload API is reachable
curl https://api.yourdomain.com/health

# MinIO S3 API is reachable
curl https://storage.yourdomain.com/minio/health/live
```

---

## Docker Compose

```bash
# Copy and fill in all secrets
cp .env.example .env

# Start the full stack
docker compose up -d

# Logs
docker compose logs -f minio-upload-service
docker compose logs -f cloudflared
```

Run only the upload service (if MinIO/Hasura already run elsewhere):

```bash
docker build -t minio-upload-service .
docker run -p 3001:3001 --env-file .env minio-upload-service
```

---

## API reference

All endpoints except `/health` require:

```
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

---

### `GET /health`

No authentication required.

```json
{ "status": "ok", "timestamp": "2024-01-15T10:30:00.000Z" }
```

---

### `POST /create-upload`

**Request:**

```json
{
  "filename":  "report.pdf",
  "mimeType":  "application/pdf",
  "sizeBytes": 204800,
  "userId":    "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response `201`:**

```json
{
  "fileId":           "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "uploadUrl":        "https://storage.yourdomain.com/files/uploads/...?X-Amz-Signature=...",
  "objectKey":        "uploads/550e8400-.../2024-01-15/a1b2c3d4-report.pdf",
  "expiresInSeconds": 900
}
```

The `uploadUrl` is a **presigned PUT** for MinIO. The frontend uses it directly —
no API key needed for this call, the HMAC signature in the URL is the credential.

---

### `POST /confirm-upload`

**Request:**

```json
{ "fileId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }
```

**Response `200`:**

```json
{
  "fileId":           "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status":           "uploaded",
  "uploadedAt":       "2024-01-15T10:31:05.123Z",
  "objectKey":        "uploads/550e8400-.../2024-01-15/a1b2c3d4-report.pdf",
  "originalFilename": "report.pdf"
}
```

**Error `422`** — object not found in MinIO (upload did not complete):

```json
{ "error": "Object not found in storage. Complete the upload before confirming." }
```

---

### `POST /create-download-url`

**Request:**

```json
{ "fileId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }
```

**Response `200`:**

```json
{
  "downloadUrl":      "https://storage.yourdomain.com/files/uploads/...?X-Amz-Signature=...",
  "expiresInSeconds": 900,
  "originalFilename": "report.pdf",
  "mimeType":         "application/pdf",
  "objectKey":        "uploads/550e8400-.../2024-01-15/a1b2c3d4-report.pdf"
}
```

---

## Making requests from the frontend

### Full flow (fetch / TypeScript)

```typescript
const API = "https://api.yourdomain.com";
const API_KEY = "your-api-key";                  // keep in env, never hardcode

const headers = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${API_KEY}`,
};

// ── Step 1: request presigned URL ────────────────────────────────────────────
const createRes = await fetch(`${API}/create-upload`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    filename:  file.name,
    mimeType:  file.type,
    sizeBytes: file.size,
    userId:    "550e8400-e29b-41d4-a716-446655440000",
  }),
});
const { fileId, uploadUrl } = await createRes.json();

// ── Step 2: PUT file directly to MinIO (no API key — URL is self-authenticating)
await fetch(uploadUrl, {
  method: "PUT",
  headers: { "Content-Type": file.type },
  body: file,                                    // File object from <input type="file">
});

// ── Step 3: confirm ───────────────────────────────────────────────────────────
await fetch(`${API}/confirm-upload`, {
  method: "POST",
  headers,
  body: JSON.stringify({ fileId }),
});

// ── Step 4: get download URL ──────────────────────────────────────────────────
const dlRes = await fetch(`${API}/create-download-url`, {
  method: "POST",
  headers,
  body: JSON.stringify({ fileId }),
});
const { downloadUrl } = await dlRes.json();

window.open(downloadUrl);   // or set as <a href> / <img src>
```

### cURL examples

```bash
API="https://api.yourdomain.com"
KEY="your-api-key"

# 1. Create upload
RESPONSE=$(curl -s -X POST "$API/create-upload" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "test.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 204800,
    "userId": "550e8400-e29b-41d4-a716-446655440000"
  }')

FILE_ID=$(echo $RESPONSE | jq -r .fileId)
UPLOAD_URL=$(echo $RESPONSE | jq -r .uploadUrl)

# 2. Upload to MinIO directly — no API key, the URL is self-authenticating
curl -s -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/pdf" \
  --data-binary @test.pdf

# 3. Confirm
curl -s -X POST "$API/confirm-upload" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"fileId\": \"$FILE_ID\"}" | jq .

# 4. Download URL
curl -s -X POST "$API/create-download-url" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"fileId\": \"$FILE_ID\"}" | jq .
```

---

## Security overview

| Concern | How it's handled |
|---|---|
| API endpoints protected | `Authorization: Bearer <API_KEY>` on all routes except `/health` |
| Constant-time key comparison | Prevents timing attacks in `apiKey.ts` |
| `S3_SECRET_KEY` never exposed | Server-side only; frontend never sees it |
| Presigned URL = self-auth | Browser uploads/downloads with HMAC-signed URLs — no credentials needed |
| Presigned URL expiry | 15 min by default (`PRESIGNED_URL_EXPIRY_SECONDS`) |
| Fake confirmations blocked | `statObject` verifies the object exists in MinIO before confirming |
| Filename injection | `sanitizeFilename()` strips path traversal + special chars |
| MIME type allowlist | Explicit allowlist in `middleware/validate.ts` |
| File size limit | Validated via `sizeBytes`; JSON body capped at 16 KB |
| Rate limiting | 60 req/min per IP via `express-rate-limit` |
| HTTP headers | `helmet` sets CSP, HSTS, X-Frame-Options, etc. |
| Non-root container | Docker runs as `appuser` |
| Tunnel credentials gitignored | `cloudflared/credentials.json` excluded from version control |
| No open inbound ports | Cloudflare Tunnel is outbound-only; firewall stays closed |

---

## Hasura permissions setup

1. Open Hasura Console → Data → `public.files` → Permissions
2. Create a role (e.g. `backend`) and set:
   - **Insert**: all columns except `id`, `created_at` (let DB defaults apply)
   - **Select**: all columns
   - **Update**: columns `status`, `uploaded_at` only
3. Use the admin secret in this microservice (already configured via `HASURA_ADMIN_SECRET`)

> In production, consider replacing the admin secret with a per-role JWT approach
> so different services have minimal permissions.

---

## Troubleshooting

**Presigned URLs still contain `localhost:9000`**

- Confirm `MINIO_SERVER_URL=https://storage.yourdomain.com` is set on the MinIO container
- Confirm `S3_PUBLIC_URL=https://storage.yourdomain.com` is set on the upload service
- Restart both containers after changing env vars: `docker compose restart minio minio-upload-service`

**Browser gets CORS error on PUT to `storage.yourdomain.com`**

MinIO needs a CORS policy on the bucket. Set it via the MinIO Console or CLI:

```bash
# mc = MinIO Client CLI
mc alias set local http://localhost:9000 <ACCESS_KEY> <SECRET_KEY>
mc anonymous set-json - local/files <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"AWS": ["*"]},
    "Action": ["s3:PutObject", "s3:GetObject"],
    "Resource": ["arn:aws:s3:::files/*"]
  }]
}
EOF
```

Or set CORS through MinIO Console: Buckets → files → Summary → Access Policy.

**401 from the API**

Make sure the request includes `Authorization: Bearer <API_KEY>` and the key
matches `API_KEY` in the service's environment.

**Cloudflare Tunnel not connecting**

```bash
docker compose logs cloudflared
# Common issues:
# - credentials.json missing or wrong tunnel ID in config.yml
# - DNS records not created: cloudflared tunnel route dns my-app api.yourdomain.com
```
