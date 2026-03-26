# Guía de inicio rápido

> Esta guía asume que ya tenés Docker instalado. Si no lo tenés, instalalo primero desde
> [docker.com](https://docs.docker.com/get-docker/).

---

## Qué vas a necesitar antes de empezar

- **Docker** y **Docker Compose** instalados
- Una cuenta en **Cloudflare** con un dominio tuyo (para exponerlo a internet)
- Una instancia de **PostgreSQL** corriendo (puede ser Supabase, Railway, Neon, o local)

---

## Paso 1 — Clonar el repo y pararte en la carpeta

```bash
git clone <url-del-repo>
cd files
```

---

## Paso 2 — Crear el archivo de configuración

```bash
cp .env.example .env
```

Ahora abrí `.env` con cualquier editor de texto y completá estos valores:

### Los que SÍ o SÍ tenés que cambiar

| Variable | Qué poner |
|---|---|
| `MASTER_API_KEY` | Una clave larga y segura. Generala con: `openssl rand -hex 32` |
| `S3_ACCESS_KEY` | El nombre de usuario de MinIO (ej: `miadmin`) |
| `S3_SECRET_KEY` | La contraseña de MinIO. Mínimo 16 caracteres. |
| `MINIO_ROOT_USER` | El mismo valor que `S3_ACCESS_KEY` |
| `MINIO_ROOT_PASSWORD` | El mismo valor que `S3_SECRET_KEY` |
| `HASURA_ADMIN_SECRET` | Una clave larga para Hasura. Generala con: `openssl rand -hex 16` |
| `HASURA_GRAPHQL_DATABASE_URL` | La URL de tu base de datos Postgres. Formato: `postgres://usuario:contraseña@host:5432/nombre_db` |
| `POSTGRES_HOST` | El host de tu Postgres (mismo que en la URL de arriba) |
| `POSTGRES_USER` | El usuario de Postgres |
| `POSTGRES_PASSWORD` | La contraseña de Postgres |
| `POSTGRES_DB` | El nombre de la base de datos |
| `S3_PUBLIC_URL` | La URL pública de MinIO (la que vas a crear en el Paso 4). Ejemplo: `https://storage.midominio.com` |

### Para generar claves seguras rápido

```bash
openssl rand -hex 32   # para MASTER_API_KEY
openssl rand -hex 16   # para HASURA_ADMIN_SECRET y S3_SECRET_KEY
```

---

## Paso 3 — Levantar los servicios

```bash
docker compose up -d
```

Esto levanta:
- La **API de uploads** en el puerto 3001
- **MinIO** (almacenamiento) en los puertos 9000 y 9001
- **Hasura** (base de datos GraphQL) en el puerto 8080
- **Cloudflare Tunnel** (para exponerlo a internet)

Para ver si todo está corriendo:

```bash
docker compose ps
```

Para ver los logs:

```bash
docker compose logs -f
```

---

## Paso 4 — Configurar Cloudflare Tunnel (para acceso desde internet)

> Si solo querés probarlo en local, saltate este paso.

**4a. Instalar cloudflared** (una sola vez en tu máquina)

```bash
# En Debian/Ubuntu:
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# En Mac:
brew install cloudflared
```

**4b. Conectar tu cuenta de Cloudflare**

```bash
cloudflared tunnel login
```

Se va a abrir un browser. Elegí el dominio que querés usar y autorizá.

**4c. Crear el tunnel**

```bash
cloudflared tunnel create mi-servicio
```

Esto te va a dar un ID del estilo `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. Guardalo.

**4d. Copiar las credenciales al proyecto**

```bash
cp ~/.cloudflared/<TU-TUNNEL-ID>.json ./cloudflared/credentials.json
```

**4e. Editar `cloudflared/config.yml`**

Abrí el archivo y reemplazá los valores:

```yaml
tunnel: TU-TUNNEL-ID-ACA
credentials-file: /etc/cloudflared/credentials.json

ingress:
  - hostname: api.midominio.com
    service: http://minio-upload-service:3001

  - hostname: storage.midominio.com
    service: http://minio:9000

  - service: http_status:404
```

**4f. Crear los registros DNS**

```bash
cloudflared tunnel route dns mi-servicio api.midominio.com
cloudflared tunnel route dns mi-servicio storage.midominio.com
```

**4g. Actualizar `.env` con las URLs públicas**

```env
S3_PUBLIC_URL=https://storage.midominio.com
```

**4h. Reiniciar todo**

```bash
docker compose down
docker compose up -d
```

---

## Paso 5 — Crear el bucket en MinIO

1. Abrí `http://localhost:9001` en el browser (o `https://minio-console.midominio.com` si configuraste el tunnel)
2. Logeate con `MINIO_ROOT_USER` y `MINIO_ROOT_PASSWORD` que pusiste en `.env`
3. Hacé clic en **"Create Bucket"**
4. Poné el nombre `files` (o el que hayas puesto en `S3_BUCKET`)
5. Hacé clic en **"Create Bucket"**

---

## Paso 6 — Configurar Hasura

1. Abrí `http://localhost:8080` en el browser
2. Ingresá con tu `HASURA_ADMIN_SECRET`
3. Andá a **Data → SQL** y ejecutá este SQL para crear la tabla:

```sql
CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  original_filename TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  folder TEXT NOT NULL DEFAULT 'general',
  uploaded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

4. Hacé clic en **Track** cuando te aparezca la tabla para exponerla en GraphQL

---

## Paso 7 — Verificar que todo funciona

```bash
# Probar que la API está viva
curl http://localhost:3001/health
# Debe responder: {"status":"ok","timestamp":"..."}
```

Si usás Cloudflare Tunnel:

```bash
curl https://api.midominio.com/health
```

---

## Paso 8 — Crear tu primera API key

1. Abrí `http://localhost:3001/dashboard`
2. Ingresá tu `MASTER_API_KEY`
3. Completá el formulario:
   - **Nombre**: lo que quieras (ej: `Mi primer key`)
   - **Prefijo**: `*` para acceso total
   - **Operaciones**: `Subir y descargar`
4. Hacé clic en **Generar key**
5. **Copiá la key que aparece** — solo se muestra una vez

---

## Listo — Ya podés subir archivos

Con la key que acabás de crear, podés subir un archivo así:

```bash
KEY="la-key-que-copiaste"
API="http://localhost:3001"   # o https://api.midominio.com

# 1. Pedir la URL de upload
RESPONSE=$(curl -s -X POST "$API/create-upload" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "test.txt",
    "mimeType": "text/plain",
    "sizeBytes": 12,
    "userId": "00000000-0000-0000-0000-000000000001"
  }')

FILE_ID=$(echo $RESPONSE | python3 -c "import sys,json; print(json.load(sys.stdin)['fileId'])")
UPLOAD_URL=$(echo $RESPONSE | python3 -c "import sys,json; print(json.load(sys.stdin)['uploadUrl'])")

# 2. Subir el archivo directo a MinIO
echo "Hola mundo!" | curl -s -X PUT "$UPLOAD_URL" \
  -H "Content-Type: text/plain" \
  --data-binary @-

# 3. Confirmar
curl -s -X POST "$API/confirm-upload" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"fileId\": \"$FILE_ID\"}" | python3 -m json.tool
```

---

## Problemas comunes

**"El servidor no arranca"** → Revisá que `.env` tenga todos los valores requeridos y que `MASTER_API_KEY` tenga al menos 32 caracteres.

**"Las URLs de upload tienen `localhost:9000`"** → Revisá que `S3_PUBLIC_URL` esté configurado en `.env` y que `MINIO_SERVER_URL` esté en el docker-compose.

**"Error CORS al subir"** → MinIO necesita una política CORS. Configurarla desde MinIO Console: Buckets → files → Summary → Access Policy → set to `public`.

**"No conecta el Cloudflare Tunnel"** → Revisá que `credentials.json` esté en `./cloudflared/` y que el TUNNEL_ID en `config.yml` sea correcto.

**"401 Unauthorized"** → La key que estás usando es incorrecta o está revocada. La `MASTER_API_KEY` solo sirve para `/admin/*` y el dashboard.
