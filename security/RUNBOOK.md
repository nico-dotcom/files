# Runbook operativo — seguridad de minio-upload-service

Procedimientos concretos. Todo corre en CASA (la Raspberry), donde están Express, MinIO y Hasura.

---

## Deploy de cambios de código

```bash
cd /home/nicolas/files
npx tsc --noEmit                       # typecheck (no genera nada)
npm run build                          # compila a dist/ + copia dashboard
pm2 restart minio-upload-service       # ~1-2 s de blip; escucha-primero
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3002/health   # esperar 200
```

## Verificar la seguridad (regresión)

```bash
node /home/nicolas/files/security/selftest.mjs   # 14 asserts, auto-limpiante, exit≠0 si falla
```

---

## Cifrado en reposo (SSE-S3)

**Estado / activar:**
```bash
node /home/nicolas/files/scripts/enable-sse.js --check   # ver estado
node /home/nicolas/files/scripts/enable-sse.js           # activar (idempotente)
```
> El script llama a `setBucketEncryption` **sin argumentos** a propósito: minio-js 7.1.3
> serializa mal una config custom (algoritmo vacío → no cifra).

**La key KMS (crítica):**
- Vive en `minio-stack/.env` como `MINIO_KMS_SECRET_KEY=minio-files-key:<base64>`.
- Backup en `/home/nicolas/minio-stack/kms-backup/kms_master_key.YYYYMMDD.txt` (chmod 600).
- 🔑 **Si se pierde, los objetos cifrados son irrecuperables.** Guardá una copia **fuera de
  la Raspberry** (gestor de contraseñas / backup offline).

**Verificar que un objeto quedó cifrado (autoritativo, desde el host):**
```bash
# leer el xl.meta del objeto en /mnt/m2/minio/data/files/<object_key>/xl.meta
# y buscar el marcador "Server-Side-Encryption". OJO: el contenedor MinIO NO tiene
# grep/strings — hay que leerlo desde el host (fs), no con `docker exec grep`.
```

**Recifrar los objetos viejos (backlog en texto plano):**
Los objetos subidos antes de activar SSE siguen sin cifrar. Para cifrarlos hay que
reescribirlos (copy-in-place). Con `mc` (si se instala):
```bash
mc cp --recursive --enc-s3 "local/files" local/files
```
Sin `mc`, un loop con el cliente minio (copyObject sobre sí mismo). **No** es urgente ni
destructivo, pero conviene hacerlo en una pasada controlada y verificar una muestra después.

---

## Reiniciar / reconfigurar MinIO (afecta a TODOS los proyectos)

```bash
cd /home/nicolas/minio-stack
cp .env .env.bak.$(date +%Y%m%d%H%M%S)          # respaldo antes de tocar
# editar .env si hace falta
docker compose up -d --force-recreate minio     # ~3-10 s de downtime; usa la imagen local
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9000/minio/health/live   # esperar 200
```
> ⚠️ La imagen es `:latest`. `up -d` **no** re-descarga (usa la local); no cambiar de versión
> sin querer. Un formato mal en `MINIO_KMS_SECRET_KEY` puede impedir el arranque → tener el
> `.env.bak` a mano.

---

## Rotación de la master key del servicio (no confundir con la KMS)

La `MASTER_API_KEY` (admin del dashboard) está en `files/.env`. Para rotarla:
```bash
openssl rand -hex 32                    # generar nueva (≥32 chars)
# editar MASTER_API_KEY= en files/.env
pm2 restart minio-upload-service
```
Hacerlo tras cualquier sospecha de exposición.

---

## Respuesta a incidentes

**Sospecha de master key filtrada** → rotar `MASTER_API_KEY` (arriba) + revisar
`file_events` en Hasura por descargas anómalas + revocar keys sospechosas desde el dashboard.

**502 en `upload.nicolasrusso.ar`** → `ss -ltn | grep :3002` (¿escucha?),
`pm2 logs minio-upload-service`, `tail /home/nicolas/files/logs/watchdog.log`.

**Verificar que no hay fugas de acceso** → `node security/selftest.mjs` (falla si algún
control se aflojó).

---

## Referencias
- Informe completo: [`SECURITY-REPORT.md`](./SECURITY-REPORT.md)
- Autorización / alcance: [`PENTEST-AUTHORIZATION.md`](./PENTEST-AUTHORIZATION.md)
- Testing exploratorio en chat nuevo: [`PENTEST-PROMPT.md`](./PENTEST-PROMPT.md)
