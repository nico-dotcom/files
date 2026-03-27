# Guía de inicio rápido

---

## Requisitos previos

- **Node.js 18+** y **npm**
- **MinIO** corriendo (en Docker o standalone)
- **Hasura** corriendo y conectado a una base de datos Postgres
- Una cuenta en **Cloudflare** con un dominio (para exponerlo a internet)

---

## Paso 1 — Clonar y configurar

```bash
git clone <url-del-repo>
cd files
npm install
cp .env.example .env
```

Completá `.env` con tus valores. Los mínimos requeridos:

```env
PORT=3002
MASTER_API_KEY=<openssl rand -hex 32>

# MinIO interno
S3_ENDPOINT=localhost
S3_PORT=9000
S3_USE_SSL=false
S3_ACCESS_KEY=tu-usuario-minio
S3_SECRET_KEY=tu-password-minio
S3_BUCKET=files

# URL pública de MinIO (vía Cloudflare Tunnel)
S3_PUBLIC_URL=https://files.tudominio.com

# Hasura
HASURA_GRAPHQL_URL=http://localhost:8080/v1/graphql
HASURA_ADMIN_SECRET=<openssl rand -hex 16>
```

> Generá claves seguras con: `openssl rand -hex 32`

---

## Paso 2 — Iniciar el servicio

```bash
npm run dev
```

Al iniciar, el servicio **crea automáticamente** todas las tablas necesarias en Postgres vía Hasura:
`api_keys`, `folders`, `api_key_folders`, `files`, `file_events`.
No hace falta correr SQL manualmente ni configurar nada en la consola de Hasura.

Para correrlo en producción con PM2:

```bash
pm2 start npm --name files -- run dev
pm2 save
```

---

## Paso 3 — Verificar

```bash
curl http://localhost:3002/health
# {"status":"ok","timestamp":"..."}
```

---

## Paso 4 — Configurar Cloudflare Tunnel

Se necesitan dos hostnames:

| Hostname | Puerto | Uso |
|---|---|---|
| `upload.tudominio.com` | 3002 | API del servicio |
| `files.tudominio.com` | 9000 | MinIO (presigned URLs directas) |

**4a. El tunnel ya debe existir como servicio del sistema.**
El config del sistema está en `/etc/cloudflared/config.yml`:

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

**4b. Reiniciar cloudflared:**

```bash
sudo systemctl restart cloudflared
```

**4c. Crear registros DNS en Cloudflare:**

```bash
cloudflared tunnel route dns <nombre-tunnel> upload.tudominio.com
cloudflared tunnel route dns <nombre-tunnel> files.tudominio.com
```

---

## Paso 5 — Crear el bucket en MinIO

1. Abrí la consola de MinIO en `http://localhost:9001`
2. Logeate con tu usuario/password de MinIO
3. Creá un bucket con el nombre que pusiste en `S3_BUCKET` (ej: `files`)
4. Configurá la política de acceso del bucket para permitir PUT/GET presignados

---

## Paso 6 — Crear tu primera API key

1. Abrí `https://upload.tudominio.com/dashboard`
2. Ingresá tu `MASTER_API_KEY`
3. **Carpetas**: primero creá las carpetas que necesites (ej: `documentos`, `imagenes/perfil`)
4. **Nueva API Key**:
   - Nombre: lo que quieras
   - Operaciones: Subir y descargar
   - Acceso: Global (para testear) o carpetas específicas
5. Copiá la key — **solo se muestra una vez**

---

## Paso 7 — Testear con la página de test

Abrí `https://upload.tudominio.com/test` e ingresá tu key.

La página te permite:
- Subir un archivo (flujo completo con barra de progreso)
- Ver (abre URL de descarga en nueva pestaña)
- Eliminar (si la key tiene permiso `can_delete`)

La key se guarda solo en memoria de la pestaña — no queda guardada en ningún lado.

---

## Paso 8 — Integrar en tu app

Ver **PARA-IAS.md** para la referencia completa del API con ejemplos en Python y TypeScript.

Flujo básico:

```bash
API="https://upload.tudominio.com"
KEY="sk_..."

# 1. Pedir presigned URL
RESPONSE=$(curl -s -X POST "$API/create-upload" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"filename":"test.txt","mimeType":"text/plain","sizeBytes":12,"userId":"00000000-0000-0000-0000-000000000001"}')

FILE_ID=$(echo $RESPONSE | python3 -c "import sys,json; print(json.load(sys.stdin)['fileId'])")
UPLOAD_URL=$(echo $RESPONSE | python3 -c "import sys,json; print(json.load(sys.stdin)['uploadUrl'])")

# 2. Subir directo a MinIO (sin Authorization)
echo "Hola mundo!" | curl -s -X PUT "$UPLOAD_URL" -H "Content-Type: text/plain" --data-binary @-

# 3. Confirmar
curl -s -X POST "$API/confirm-upload" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"fileId\": \"$FILE_ID\"}" | python3 -m json.tool
```

---

## Problemas comunes

**"El servidor no arranca"**
→ Verificar que `MASTER_API_KEY` tenga al menos 32 caracteres y que Hasura esté accesible.

**"Las URLs de upload tienen `localhost:9000`"**
→ Verificar que `S3_PUBLIC_URL=https://files.tudominio.com` esté en `.env` y reiniciar el servicio.

**"Error CORS en el PUT a MinIO"**
→ Configurar política CORS en el bucket desde MinIO Console → Buckets → files → Access Policy.

**"Error 1033 de Cloudflare"**
→ Verificar que `/etc/cloudflared/config.yml` (no `~/.cloudflared/`) tenga las entradas correctas y que cloudflared esté corriendo: `sudo systemctl status cloudflared`.

**"401 Unauthorized"**
→ Usar `Authorization: Bearer <key>`. La `MASTER_API_KEY` solo sirve para `/admin/*` y el dashboard.

**"403 Access denied"**
→ La key no tiene scope sobre la carpeta solicitada, o no tiene el permiso requerido (`can_upload`, `can_download`, `can_delete`).
