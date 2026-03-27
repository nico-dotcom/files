# minio-upload-service

Microservicio seguro de carga de archivos usando **MinIO presigned URLs** + **Hasura GraphQL**,
expuesto externamente vía **Cloudflare Tunnel** (sin puertos de entrada abiertos).

Las API keys tienen scope por **carpeta** (many-to-many), permisos granulares, y el schema de
base de datos se crea automáticamente al iniciar el servicio.

```
Frontend → POST /create-upload        → API (upload.tudominio.com)
Frontend → PUT  <presignedPutUrl>     → MinIO directo (files.tudominio.com)
Frontend → POST /confirm-upload       → API
Frontend → POST /create-download-url  → API
Frontend → GET  <presignedGetUrl>     → MinIO directo (files.tudominio.com)
```

---

## Estructura del proyecto

```
src/
├── config/
│   ├── env.ts              # Variables de entorno tipadas y validadas
│   ├── minio.ts            # Cliente MinIO interno + cliente público (presigned URLs)
│   ├── hasura.ts           # Cliente GraphQL mínimo
│   ├── setup.ts            # Crea tablas y relaciones en Hasura al iniciar (idempotente)
│   ├── apiKeys.ts          # CRUD de API keys + isAllowed()
│   ├── folders.ts          # CRUD de carpetas
│   ├── files.ts            # Listado y borrado suave de archivos
│   └── fileEvents.ts       # Log de tráfico (fire-and-forget)
├── middleware/
│   ├── apiKey.ts           # Authorization: Bearer — lookup + checkScope()
│   └── validate.ts         # Allowlist MIME, chequeos UUID, límite de tamaño
├── routes/
│   ├── createUpload.ts         # POST /create-upload
│   ├── confirmUpload.ts        # POST /confirm-upload
│   ├── createDownloadUrl.ts    # POST /create-download-url
│   ├── deleteFile.ts           # DELETE /files/:fileId
│   └── admin/
│       ├── keys.ts             # GET|POST|PUT|DELETE /admin/keys[/:id]
│       ├── folders.ts          # GET|POST|DELETE /admin/folders[/:id]
│       └── files.ts            # GET|DELETE /admin/files[/:id]
├── dashboard/
│   ├── index.html          # Dashboard SPA (sin JS inline)
│   ├── dashboard.js        # Lógica del dashboard
│   ├── dashboard-init.js   # Wiring de botones
│   ├── test.html           # Página de test de API
│   └── test.js             # Lógica de la página de test
├── utils/
│   ├── filename.ts         # sanitizeFilename, sanitizeFolder, buildObjectKey
│   └── crypto.ts           # safeEqual() — comparación en tiempo constante
└── index.ts                # Express app + startup
```

---

## Quick start

```bash
npm install
cp .env.example .env
# Completar .env (ver sección Variables de entorno)
npm run dev
```

Al iniciar, el servicio crea automáticamente todas las tablas necesarias en Postgres vía Hasura.
No hace falta correr SQL manualmente.

Abrí el dashboard en **http://localhost:3002/dashboard** y la página de test en **http://localhost:3002/test**.

Build para producción:

```bash
npm run build
npm start
```

---

## Variables de entorno

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `PORT` | no | `3002` | Puerto HTTP del servicio |
| `MASTER_API_KEY` | **sí** | — | Clave maestra para el dashboard y `/admin/*`. **Mínimo 32 caracteres.** |
| `S3_ENDPOINT` | **sí** | — | Hostname interno de MinIO (sin protocolo ni puerto) |
| `S3_PORT` | no | `9000` | Puerto MinIO interno |
| `S3_USE_SSL` | no | `false` | TLS para la conexión interna con MinIO |
| `S3_ACCESS_KEY` | **sí** | — | Access key de MinIO |
| `S3_SECRET_KEY` | **sí** | — | Secret key de MinIO. **Mínimo 16 caracteres.** |
| `S3_BUCKET` | **sí** | — | Nombre del bucket en MinIO |
| `S3_PUBLIC_URL` | **sí** | — | URL pública de MinIO vía Cloudflare (ej: `https://files.tudominio.com`) |
| `PRESIGNED_URL_EXPIRY_SECONDS` | no | `900` | Duración de presigned URLs (15 min) |
| `MAX_FILE_SIZE_BYTES` | no | `104857600` | Tamaño máximo de subida (100 MB) |
| `HASURA_GRAPHQL_URL` | **sí** | — | URL completa del endpoint GraphQL de Hasura |
| `HASURA_ADMIN_SECRET` | **sí** | — | Secret de admin de Hasura. **Mínimo 16 caracteres.** |
| `MINIO_ROOT_USER` | no | — | Usuario root de MinIO (solo docker-compose) |
| `MINIO_ROOT_PASSWORD` | no | — | Contraseña root de MinIO (solo docker-compose) |

> El servidor no arranca si `MASTER_API_KEY` < 32 chars o si `HASURA_ADMIN_SECRET`/`S3_SECRET_KEY` < 16 chars.
> Generá valores seguros con: `openssl rand -hex 32`

---

## Dashboard

Abrí `/dashboard` e ingresá tu `MASTER_API_KEY`.

### Carpetas

Las carpetas son entidades de primera clase. Se crean desde la sección "Carpetas" del dashboard.
Los nombres pueden incluir subcarpetas con `/` (ej: `imagenes/perfil`, `documentos/2024`).

### API Keys

Cada key puede tener:
- **Acceso global** (`*`) — todos los archivos del bucket
- **Carpetas específicas** — acceso solo a las carpetas asignadas (many-to-many)
- **Operaciones**: Subir y descargar / Solo subir / Solo descargar
- **Permiso de eliminación** (`can_delete`) — permite `DELETE /files/:fileId`
- **Vencimiento** — opcional, la key se rechaza después de la fecha

Desde la tabla de keys podés:
- **Editar** una key activa (cambiar permisos y carpetas sin generar una nueva)
- **Renovar** — genera una nueva key con la misma configuración, revoca la anterior
- **Revocar** — desactiva la key (sigue apareciendo en la lista)
- **Eliminar** — solo disponible para keys revocadas, las borra permanentemente

La key completa solo se muestra una vez al crearla o renovarla.

### Página de test (`/test`)

Permite testear el flujo completo con una API key:
1. Ingresar la key (se guarda solo en memoria, no en localStorage)
2. Subir un archivo (con barra de progreso)
3. Ver (abre URL de descarga en nueva pestaña)
4. Eliminar (si la key tiene `can_delete`)

---

## Sistema de carpetas

Al crear una key con carpetas específicas, el acceso queda restringido a esas carpetas:

| Key | Puede acceder |
|---|---|
| Global (`*`) | Todos los archivos |
| Carpeta `infopublica` | Solo archivos bajo `uploads/.../infopublica/...` |
| Carpetas `facturas` + `contratos` | Archivos bajo cualquiera de las dos |

Si una key tiene una sola carpeta asignada, el campo `folder` en `/create-upload` se ignora — todos los archivos van a esa carpeta automáticamente.

Si tiene múltiples carpetas, el campo `folder` es **requerido** y debe ser una de las carpetas asignadas.

---

## Referencia de API

Todos los endpoints (excepto `/health`, `/dashboard`, `/test`) requieren:

```
Authorization: Bearer <api-key>
Content-Type: application/json
```

Para `/admin/*` usar la `MASTER_API_KEY`.

---

### `GET /health`

```json
{ "status": "ok", "timestamp": "2024-01-15T10:30:00.000Z" }
```

---

### `POST /create-upload`

**Request:**

```json
{
  "filename":  "reporte.pdf",
  "mimeType":  "application/pdf",
  "sizeBytes": 204800,
  "userId":    "550e8400-e29b-41d4-a716-446655440000",
  "folder":    "facturas"
}
```

| Campo | Requerido | Descripción |
|---|---|---|
| `filename` | sí | Nombre original del archivo |
| `mimeType` | sí | MIME type (debe estar en el allowlist) |
| `sizeBytes` | sí | Tamaño en bytes |
| `userId` | sí | UUID del usuario dueño del archivo |
| `folder` | condicional | Carpeta destino. Requerido si la key tiene múltiples carpetas. Ignorado si tiene exactamente una. Default para keys globales: `general`. |

**Response `201`:**

```json
{
  "fileId":           "a1b2c3d4-...",
  "uploadUrl":        "https://files.tudominio.com/bucket/uploads/...?X-Amz-Signature=...",
  "objectKey":        "uploads/550e8400-.../facturas/2024-01-15/a1b2c3d4-reporte.pdf",
  "expiresInSeconds": 900
}
```

---

### `POST /confirm-upload`

**Request:** `{ "fileId": "..." }`

Verifica que el objeto exista en MinIO antes de marcar como `uploaded`.

**Response `200`:**

```json
{
  "fileId": "...", "status": "uploaded",
  "uploadedAt": "...", "objectKey": "...", "originalFilename": "reporte.pdf"
}
```

---

### `POST /create-download-url`

**Request:** `{ "fileId": "..." }`

**Response `200`:**

```json
{
  "downloadUrl": "https://files.tudominio.com/...?X-Amz-Signature=...",
  "expiresInSeconds": 900,
  "originalFilename": "reporte.pdf",
  "mimeType": "application/pdf",
  "objectKey": "..."
}
```

---

### `DELETE /files/:fileId`

Requiere `can_delete: true` en la key. La key debe tener scope sobre el archivo.
Soft-delete: marca `deleted_at` en la DB y elimina el objeto de MinIO.

**Response `200`:** `{ "message": "File deleted", "id": "..." }`

**Errores:**
- `403` — key sin `can_delete`, o archivo fuera del scope de la key
- `404` — archivo no encontrado
- `410` — archivo ya eliminado

---

### `GET /admin/folders`

Lista todas las carpetas.

```json
{ "folders": [{ "id": "...", "name": "facturas", "created_at": "..." }] }
```

---

### `POST /admin/folders`

**Request:** `{ "name": "facturas" }` — puede incluir `/` para subcarpetas (ej: `imagenes/perfil`)

---

### `DELETE /admin/folders/:id`

Elimina la carpeta. Las keys que la tenían asignada pierden acceso. Los archivos en MinIO no se borran.

---

### `GET /admin/keys`

Lista todas las keys (nunca devuelve el hash).

---

### `POST /admin/keys`

**Request:**

```json
{
  "name":         "Frontend – facturas",
  "can_upload":   true,
  "can_download": true,
  "can_delete":   false,
  "expires_at":   null,
  "folder_ids":   ["uuid-carpeta-1", "uuid-carpeta-2"]
}
```

Omitir `folder_ids` o enviar `[]` + `"prefix": "*"` para key global.

**Response `201`:** incluye `key` (bearer token, solo se muestra una vez).

---

### `PUT /admin/keys/:id`

Edita permisos y carpetas de una key existente. No genera una nueva key.

**Request:** `{ can_upload, can_download, can_delete, expires_at, folder_ids }`

---

### `DELETE /admin/keys/:id`

- Sin parámetros: revoca (soft-delete, `is_active = false`)
- Con `?hard=true`: elimina permanentemente de la DB

---

### `POST /admin/keys/:id/renew`

Genera una nueva key con la misma configuración y revoca la anterior.
Devuelve el nuevo bearer token (solo una vez).

---

### `GET /admin/files`

Lista archivos no eliminados (máx 200). Filtro opcional: `?folder=facturas`.

---

### `DELETE /admin/files/:id`

Elimina un archivo permanentemente (soft-delete en DB + `removeObject` en MinIO).

---

## Cloudflare Tunnel

Dos hostnames:

| Hostname | Puerto | Uso |
|---|---|---|
| `upload.tudominio.com` | 3002 | API (frontend → backend) |
| `files.tudominio.com` | 9000 | MinIO directo (presigned URLs) |

El backend genera las presigned URLs apuntando a `files.tudominio.com` (configurado en `S3_PUBLIC_URL`).
El browser hace PUT/GET directamente a MinIO — los bytes nunca pasan por el backend.

**`/etc/cloudflared/config.yml` (servicio del sistema):**

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: upload.tudominio.com
    service: http://localhost:3002

  - hostname: files.tudominio.com
    service: http://localhost:9000

  - service: http_status:404
```

---

## Seguridad

| Aspecto | Implementación |
|---|---|
| Keys hasheadas | Solo SHA-256 en DB, nunca texto plano |
| Comparación en tiempo constante | `crypto.timingSafeEqual` — no filtra longitud |
| Scope verificado en todos los endpoints | Upload, confirm, download y delete verifican carpeta |
| `can_delete` por key | Delete requiere permiso explícito |
| Confirmaciones falsas bloqueadas | `statObject` verifica que el objeto exista antes de confirmar |
| Sanitización de nombres | Path traversal y chars especiales eliminados |
| Allowlist MIME | Lista explícita en `validate.ts` |
| Rate limiting | 60 req/min general, 200 req/15min en `/admin/*` |
| Headers HTTP seguros | `helmet` con CSP, HSTS, X-Frame-Options |
| CSP sin `unsafe-inline` en scripts | JS del dashboard servido como archivos estáticos |
| Sin puertos de entrada abiertos | Cloudflare Tunnel es solo saliente |
| Trust proxy | `app.set("trust proxy", 1)` para X-Forwarded-For correcto detrás de Cloudflare |

---

## Troubleshooting

**Las presigned URLs tienen `localhost:9000`**
→ Verificar que `S3_PUBLIC_URL=https://files.tudominio.com` esté en `.env`

**Error CORS en el PUT a MinIO**
→ Configurar política CORS en el bucket desde MinIO Console → Buckets → files → Access Policy

**`401` desde la API**
→ Enviar `Authorization: Bearer <key>`. La `MASTER_API_KEY` solo sirve para `/admin/*`.

**`403 Access denied`**
→ La key no tiene scope sobre la carpeta del archivo, o no tiene el permiso requerido (`can_upload`, `can_download`, `can_delete`).

**El servidor no arranca**
→ Verificar que `MASTER_API_KEY` ≥ 32 chars y que Hasura esté accesible en `HASURA_GRAPHQL_URL`.
