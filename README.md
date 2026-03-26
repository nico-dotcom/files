# minio-upload-service

Microservicio seguro de carga de archivos usando **MinIO presigned URLs** + **Hasura GraphQL**,
expuesto externamente vía **Cloudflare Tunnel** (sin puertos de entrada abiertos).

El sistema gestiona API keys con alcance de carpeta (prefix) desde un dashboard web.
Nunca se almacena una key en texto plano — solo el hash SHA-256.

```
Frontend → POST /create-upload        → Upload API (api.yourdomain.com)
Frontend → PUT  <presignedPutUrl>     → MinIO S3 directo (storage.yourdomain.com)
Frontend → POST /confirm-upload       → Upload API
Frontend → POST /create-download-url  → Upload API
Frontend → GET  <presignedGetUrl>     → MinIO S3 directo (storage.yourdomain.com)
```

---

## Estructura del proyecto

```
/
├── src/
│   ├── config/
│   │   ├── env.ts              # Variables de entorno tipadas y validadas
│   │   ├── minio.ts            # Cliente MinIO interno + cliente público (presigned URLs)
│   │   ├── hasura.ts           # Cliente GraphQL mínimo
│   │   ├── db.ts               # Pool PostgreSQL para la tabla api_keys
│   │   └── apiKeys.ts          # CRUD de API keys + isAllowedPrefix
│   ├── middleware/
│   │   ├── apiKey.ts           # Authorization: Bearer — lookup en DB + checkScope()
│   │   └── validate.ts         # Allowlist MIME, chequeos UUID, límite de tamaño
│   ├── routes/
│   │   ├── createUpload.ts         # POST /create-upload
│   │   ├── confirmUpload.ts        # POST /confirm-upload
│   │   ├── createDownloadUrl.ts    # POST /create-download-url
│   │   └── admin/
│   │       └── keys.ts             # GET|POST|DELETE /admin/keys[/:id]
│   ├── dashboard/
│   │   ├── index.html          # Dashboard SPA (sin JS inline)
│   │   ├── dashboard.js        # Lógica del dashboard
│   │   └── dashboard-init.js   # Wiring de botones
│   ├── utils/
│   │   ├── filename.ts         # sanitizeFilename, sanitizeFolder, buildObjectKey
│   │   └── crypto.ts           # safeEqual() — comparación en tiempo constante
│   └── index.ts                # Express app + startup
├── cloudflared/
│   ├── config.yml              # Reglas de ingreso del Cloudflare Tunnel
│   └── .gitignore              # Excluye credentials.json del repositorio
├── examples/
│   ├── frontend-upload.ts      # Flujo de upload desde el browser con progreso
│   └── api-requests.http       # Ejemplos REST Client / cURL
├── .env.example
├── Dockerfile
└── docker-compose.yml
```

---

## Quick start (local)

```bash
npm install
cp .env.example .env
# Editar .env — como mínimo: MASTER_API_KEY, S3_ACCESS_KEY, S3_SECRET_KEY,
#                             POSTGRES_PASSWORD, HASURA_ADMIN_SECRET
npm run dev
```

Luego abrir el dashboard en **http://localhost:3001/dashboard** para crear las primeras API keys.

Build para producción:

```bash
npm run build
npm start
```

---

## Variables de entorno

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `PORT` | no | `3001` | Puerto HTTP del servicio |
| `MASTER_API_KEY` | **sí** | — | Clave maestra para el dashboard y `/admin/*`. **Mínimo 32 caracteres.** |
| `POSTGRES_HOST` | no | `localhost` | Host del servidor PostgreSQL |
| `POSTGRES_PORT` | no | `5432` | Puerto PostgreSQL |
| `POSTGRES_DB` | **sí** | — | Nombre de la base de datos |
| `POSTGRES_USER` | **sí** | — | Usuario PostgreSQL |
| `POSTGRES_PASSWORD` | **sí** | — | Contraseña PostgreSQL |
| `S3_ENDPOINT` | **sí** | — | Hostname interno de MinIO (sin protocolo ni puerto) |
| `S3_PORT` | no | `9000` | Puerto MinIO interno |
| `S3_USE_SSL` | no | `false` | TLS para la conexión interna con MinIO |
| `S3_ACCESS_KEY` | **sí** | — | Access key de MinIO |
| `S3_SECRET_KEY` | **sí** | — | Secret key de MinIO. **Mínimo 16 caracteres.** |
| `S3_BUCKET` | **sí** | — | Nombre del bucket en MinIO |
| `S3_PUBLIC_URL` | no | — | URL pública de MinIO vía Cloudflare (ej: `https://storage.yourdomain.com`) |
| `PRESIGNED_URL_EXPIRY_SECONDS` | no | `900` | Duración de presigned URLs (15 min) |
| `MAX_FILE_SIZE_BYTES` | no | `104857600` | Tamaño máximo de subida (100 MB) |
| `HASURA_GRAPHQL_URL` | **sí** | — | URL completa del endpoint GraphQL de Hasura |
| `HASURA_ADMIN_SECRET` | **sí** | — | Secret de admin de Hasura. **Mínimo 16 caracteres.** |
| `HASURA_GRAPHQL_DATABASE_URL` | **sí** (docker) | — | Postgres URL completa para Hasura. Formato: `postgres://user:pass@host:5432/db` |
| `MINIO_ROOT_USER` | no | `minioadmin` | Usuario root de MinIO (solo docker-compose). Cambiar en producción. |
| `MINIO_ROOT_PASSWORD` | **sí** (docker) | — | Contraseña root de MinIO (solo docker-compose). **Cambiar siempre del default.** |

> **Nota de seguridad:** El servidor rechaza el inicio si `MASTER_API_KEY` tiene menos de 32 caracteres
> o si `HASURA_ADMIN_SECRET` / `S3_SECRET_KEY` tienen menos de 16.
> Generá valores seguros con: `openssl rand -hex 32`

---

## Gestión de API keys

### Dashboard web

Abrí `http://localhost:3001/dashboard` (o `https://api.yourdomain.com/dashboard` en producción).

Ingresá tu `MASTER_API_KEY` para autenticarte. Desde ahí podés:
- Crear keys con scope de carpeta, permisos de operación y vencimiento opcional
- Ver todas las keys activas y su último uso
- Revocar keys al instante

La key completa (el bearer token) **solo se muestra una vez** al crearla.

> **Nota de seguridad:** `/dashboard` no requiere autenticación a nivel de servidor —
> cualquiera que pueda alcanzar la URL verá la pantalla de login.
> En producción protegé la ruta con
> [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/)
> para agregar una capa de autenticación antes de que llegue al servidor.

### Scopes (prefijo de carpeta)

El campo **prefijo** define a qué carpeta del bucket puede acceder la key:

| Prefijo | Acceso |
|---|---|
| `*` | Todos los archivos del bucket |
| `infopublica/` | Solo archivos bajo `uploads/<userId>/infopublica/` |
| `documentos/` | Solo archivos bajo `uploads/<userId>/documentos/` |

Cuando una key tiene un prefijo específico, el campo `folder` en `/create-upload`
se ignora — la carpeta siempre será la del scope de la key.

### API de admin (para automatización)

Todos los endpoints `/admin/*` requieren `Authorization: Bearer <MASTER_API_KEY>`.

```bash
# Listar keys
curl https://api.yourdomain.com/admin/keys \
  -H "Authorization: Bearer $MASTER_API_KEY"

# Crear key
curl -X POST https://api.yourdomain.com/admin/keys \
  -H "Authorization: Bearer $MASTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Frontend – infopublica",
    "prefix": "infopublica/",
    "can_upload": true,
    "can_download": false,
    "expires_at": null
  }'

# Revocar key
curl -X DELETE https://api.yourdomain.com/admin/keys/<key-id> \
  -H "Authorization: Bearer $MASTER_API_KEY"
```

---

## Cloudflare Tunnel setup

### Por qué dos hostnames

| Hostname | Puerto | Quién lo usa |
|---|---|---|
| `api.yourdomain.com` | 3001 | Frontend → llamadas a la API del backend |
| `storage.yourdomain.com` | 9000 | Frontend → uploads/downloads directos a MinIO |

**El flujo de upload nunca pasa los bytes a través del backend.** El backend solo genera
la presigned URL. El browser hace el PUT directamente a `storage.yourdomain.com`,
que Cloudflare Tunnel reenvía al puerto 9000 de MinIO.

### Critical: MINIO_SERVER_URL

MinIO embebe el hostname del servidor dentro de cada presigned URL que genera.
Sin `MINIO_SERVER_URL`, ese hostname es `localhost:9000` — inútil para un browser externo.

Ya configurado en `docker-compose.yml`:

```yaml
environment:
  MINIO_SERVER_URL: https://storage.yourdomain.com
```

El backend también usa `S3_PUBLIC_URL` al instanciar el cliente SDK que genera las presigned URLs,
para que ambos lados acuerden el hostname público.

### Setup paso a paso

**1. Instalar cloudflared**

```bash
# Debian/Ubuntu
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

**2. Autenticarse con Cloudflare**

```bash
cloudflared tunnel login
# Abre un browser — autorizar el dominio que se quiere usar
# Guarda un certificado en ~/.cloudflared/cert.pem
```

**3. Crear un tunnel con nombre**

```bash
cloudflared tunnel create my-app
# Output: Created tunnel my-app with id xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
# Credentials saved to ~/.cloudflared/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.json
```

**4. Copiar credenciales al proyecto**

```bash
cp ~/.cloudflared/<TUNNEL_ID>.json ./cloudflared/credentials.json
# Este archivo está en .gitignore — nunca commitear
```

**5. Editar `cloudflared/config.yml`**

```yaml
tunnel: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx   # ← tu tunnel ID
credentials-file: /etc/cloudflared/credentials.json

ingress:
  - hostname: api.yourdomain.com
    service: http://minio-upload-service:3001

  - hostname: storage.yourdomain.com
    service: http://minio:9000

  - hostname: minio-console.yourdomain.com     # opcional
    service: http://minio:9001

  - service: http_status:404
```

**6. Crear registros DNS en Cloudflare**

```bash
cloudflared tunnel route dns my-app api.yourdomain.com
cloudflared tunnel route dns my-app storage.yourdomain.com
cloudflared tunnel route dns my-app minio-console.yourdomain.com   # opcional
```

Esto crea registros CNAME apuntando a `<TUNNEL_ID>.cfargotunnel.com`.
Cloudflare gestiona HTTPS automáticamente — sin certificados que mantener.

**7. Configurar variables de entorno**

En `.env`:

```env
S3_PUBLIC_URL=https://storage.yourdomain.com
```

En `docker-compose.yml` (ya está configurado):

```yaml
MINIO_SERVER_URL: https://storage.yourdomain.com
```

**8. Levantar todo**

```bash
docker compose up -d
```

**9. Verificar**

```bash
# API accesible
curl https://api.yourdomain.com/health

# MinIO accesible
curl https://storage.yourdomain.com/minio/health/live
```

---

## Docker Compose

```bash
# Copiar y completar todos los secrets
cp .env.example .env

# Levantar el stack completo
docker compose up -d

# Logs
docker compose logs -f minio-upload-service
docker compose logs -f cloudflared
```

El `docker-compose.yml` incluye:
- **minio-upload-service** — la API
- **MinIO** — almacenamiento de objetos
- **Hasura** — GraphQL sobre la tabla `files`
- **cloudflared** — tunnel hacia Cloudflare

> **Nota:** PostgreSQL **no está incluido** en el `docker-compose.yml`.
> Proveer `HASURA_GRAPHQL_DATABASE_URL` y `POSTGRES_*` apuntando a tu instancia Postgres existente,
> o agregar un servicio `postgres` al compose si no tenés uno.

Correr solo el servicio de upload (si MinIO/Hasura/Postgres ya corren en otro lado):

```bash
docker build -t minio-upload-service .
docker run -p 3001:3001 --env-file .env minio-upload-service
```

---

## Referencia de API

Todos los endpoints excepto `/health` y `/dashboard` requieren:

```
Authorization: Bearer <api-key>
Content-Type: application/json
```

Donde `<api-key>` es una key creada desde el dashboard o la API admin.
Para los endpoints `/admin/*` usar la `MASTER_API_KEY`.

---

### `GET /health`

Sin autenticación.

```json
{ "status": "ok", "timestamp": "2024-01-15T10:30:00.000Z" }
```

---

### `GET /dashboard`

Sin autenticación de bearer — la propia página pide la `MASTER_API_KEY` al cargar.

---

### `POST /create-upload`

**Request:**

```json
{
  "filename":  "report.pdf",
  "mimeType":  "application/pdf",
  "sizeBytes": 204800,
  "userId":    "550e8400-e29b-41d4-a716-446655440000",
  "folder":    "infopublica"
}
```

| Campo | Requerido | Descripción |
|---|---|---|
| `filename` | sí | Nombre original del archivo |
| `mimeType` | sí | MIME type (debe estar en el allowlist) |
| `sizeBytes` | sí | Tamaño en bytes |
| `userId` | sí | UUID del usuario dueño del archivo |
| `folder` | no | Carpeta destino. Si la key tiene un prefijo específico, este campo se ignora y se usa el prefijo de la key. Default: `general` |

**Response `201`:**

```json
{
  "fileId":           "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "uploadUrl":        "https://storage.yourdomain.com/files/uploads/...?X-Amz-Signature=...",
  "objectKey":        "uploads/550e8400-.../infopublica/2024-01-15/a1b2c3d4-report.pdf",
  "expiresInSeconds": 900
}
```

La `uploadUrl` es un **presigned PUT** para MinIO. El frontend lo usa directamente —
no se necesita API key para este llamado, la firma HMAC en la URL es la credencial.

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
  "objectKey":        "uploads/550e8400-.../infopublica/2024-01-15/a1b2c3d4-report.pdf",
  "originalFilename": "report.pdf"
}
```

**Error `403`** — la key no tiene scope sobre el archivo:

```json
{ "error": "Access denied: this key is scoped to prefix \"documentos/\"" }
```

**Error `422`** — el objeto no existe en MinIO (el upload no completó):

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
  "objectKey":        "uploads/550e8400-.../infopublica/2024-01-15/a1b2c3d4-report.pdf"
}
```

---

## Uso desde el frontend

### Flujo completo (fetch / TypeScript)

```typescript
const API = "https://api.yourdomain.com";
// La key viene de una variable de entorno del frontend — nunca hardcodeada
const API_KEY = process.env.NEXT_PUBLIC_UPLOAD_KEY;

const headers = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${API_KEY}`,
};

// ── Paso 1: solicitar presigned URL ───────────────────────────────────────────
const createRes = await fetch(`${API}/create-upload`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    filename:  file.name,
    mimeType:  file.type,
    sizeBytes: file.size,
    userId:    "550e8400-e29b-41d4-a716-446655440000",
    folder:    "infopublica",   // opcional, ignorado si la key tiene prefijo fijo
  }),
});
const { fileId, uploadUrl } = await createRes.json();

// ── Paso 2: PUT del archivo directo a MinIO (sin API key — la URL es auto-autenticante)
await fetch(uploadUrl, {
  method: "PUT",
  headers: { "Content-Type": file.type },
  body: file,   // objeto File de <input type="file">
});

// ── Paso 3: confirmar ─────────────────────────────────────────────────────────
await fetch(`${API}/confirm-upload`, {
  method: "POST",
  headers,
  body: JSON.stringify({ fileId }),
});

// ── Paso 4: URL de descarga ───────────────────────────────────────────────────
const dlRes = await fetch(`${API}/create-download-url`, {
  method: "POST",
  headers,
  body: JSON.stringify({ fileId }),
});
const { downloadUrl } = await dlRes.json();

window.open(downloadUrl);   // o asignar a <a href> / <img src>
```

### Ejemplos cURL

```bash
API="https://api.yourdomain.com"
KEY="sk_..."   # key creada desde el dashboard

# 1. Crear upload
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

# 2. Subir a MinIO directamente — la URL es auto-autenticante
curl -s -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/pdf" \
  --data-binary @test.pdf

# 3. Confirmar
curl -s -X POST "$API/confirm-upload" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"fileId\": \"$FILE_ID\"}" | jq .

# 4. URL de descarga
curl -s -X POST "$API/create-download-url" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"fileId\": \"$FILE_ID\"}" | jq .
```

---

## Resumen de seguridad

| Preocupación | Cómo se maneja |
|---|---|
| Autenticación de endpoints | `Authorization: Bearer <key>` en todas las rutas excepto `/health` y `/dashboard` |
| Keys hasheadas en DB | Solo se almacena el SHA-256 del bearer token — nunca el valor en texto plano |
| Comparación en tiempo constante | `crypto.timingSafeEqual` con Buffers de longitud fija — no filtra el largo de la key |
| `S3_SECRET_KEY` nunca expuesta | Solo del lado del servidor; el frontend nunca la ve |
| Presigned URL = auto-autenticante | Uploads/downloads con URLs HMAC-firmadas — sin credenciales en el request |
| Expiración de presigned URLs | 15 min por default (`PRESIGNED_URL_EXPIRY_SECONDS`) |
| Scope de keys por carpeta | Una key `infopublica/` solo puede acceder a `uploads/<userId>/infopublica/*` |
| Scope verificado en confirm | `/confirm-upload` verifica el scope antes de marcar el archivo |
| Confirmaciones falsas bloqueadas | `statObject` verifica que el objeto exista en MinIO antes de confirmar |
| Sanitización de filename | `sanitizeFilename()` elimina path traversal y chars especiales |
| Sanitización de folder | `sanitizeFolder()` — solo alfanumérico + guiones; no permite slashes |
| Allowlist de MIME types | Lista explícita en `middleware/validate.ts` |
| Límite de tamaño | Validado vía `sizeBytes`; body JSON limitado a 16 KB |
| Rate limiting general | 60 req/min por IP vía `express-rate-limit` |
| Rate limiting en admin | 10 req/15min por IP en `/admin/*` (cuenta todas las requests) |
| Mínimo de largo en secrets | El servidor no arranca si `MASTER_API_KEY` < 32 chars o secrets < 16 chars |
| Headers HTTP | `helmet` configura CSP, HSTS, X-Frame-Options, etc. |
| CSP sin `unsafe-inline` en scripts | Dashboard JS servido como archivos estáticos — sin scripts inline |
| Estilos inline permitidos en CSP | `styleSrc` incluye `'unsafe-inline'` para los `style=` del dashboard — aceptable ya que el HTML es estático y serverside no ejecuta CSS del usuario |
| Dashboard sin auth de servidor | `/dashboard` accesible sin credenciales de servidor — proteger con Cloudflare Access en producción |
| XSS en dashboard | Tabla de keys construida con `createElement`/`textContent` — sin `innerHTML` inseguro |
| Contenedor no-root | Docker corre como `appuser` |
| Credenciales del tunnel en gitignore | `cloudflared/credentials.json` excluido del repositorio |
| Sin puertos de entrada abiertos | Cloudflare Tunnel es solo saliente; el firewall permanece cerrado |

---

## Setup de permisos en Hasura

1. Abrir Hasura Console → Data → `public.files` → Permissions
2. Crear un rol (ej: `backend`) y configurar:
   - **Insert**: todas las columnas excepto `id`, `created_at` (usar defaults de la DB)
   - **Select**: todas las columnas
   - **Update**: solo columnas `status`, `uploaded_at`
3. Usar el admin secret en este microservicio (ya configurado vía `HASURA_ADMIN_SECRET`)

> En producción, considerar reemplazar el admin secret con JWT por rol
> para que cada servicio tenga permisos mínimos.

---

## Troubleshooting

**Las presigned URLs contienen `localhost:9000`**

- Confirmar que `MINIO_SERVER_URL=https://storage.yourdomain.com` está en el contenedor de MinIO
- Confirmar que `S3_PUBLIC_URL=https://storage.yourdomain.com` está en el servicio
- Reiniciar ambos contenedores: `docker compose restart minio minio-upload-service`

**El browser tiene error CORS en el PUT a `storage.yourdomain.com`**

MinIO necesita una política CORS en el bucket:

```bash
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

O desde la MinIO Console: Buckets → files → Summary → Access Policy.

**`401 Unauthorized` desde la API**

Asegurarse de enviar `Authorization: Bearer <key>` donde `<key>` es una key
creada desde el dashboard (no la `MASTER_API_KEY`).
La `MASTER_API_KEY` es solo para los endpoints `/admin/*`.

**`403 Access denied` en confirm-upload**

La key usada para crear el upload y la usada para confirmarlo deben tener
el mismo scope de prefijo. Si creaste el upload con una key de `infopublica/`,
confirmá con la misma key (o con una key `*`).

**El servidor no arranca — error de variable de entorno demasiado corta**

```
Error: Environment variable MASTER_API_KEY is too short (8 chars). Minimum length is 32 characters.
Generate one with: openssl rand -hex 32
```

Generá una clave segura y actualizá el `.env`:

```bash
openssl rand -hex 32
```

**Cloudflare Tunnel no conecta**

```bash
docker compose logs cloudflared
# Causas comunes:
# - credentials.json faltante o TUNNEL_ID incorrecto en config.yml
# - DNS no creado: cloudflared tunnel route dns my-app api.yourdomain.com
```
