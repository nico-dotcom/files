# Informe de seguridad — minio-upload-service

**Fecha del trabajo:** 2026-07-24 · **Documentado:** 2026-07-25
**Alcance:** servicio `minio-upload-service` (Express + MinIO + Hasura) en la Raspberry Pi propia.
**Naturaleza:** auditoría + pentest autorizado + corrección, sobre infraestructura propia.

---

## 1. Resumen ejecutivo

Se auditó el servicio de uploads (~2.500 LOC) que usan casi todos los proyectos. Se
encontraron **2 vulnerabilidades altas, 3 medias y varias de hardening**, y se demostró
con un pentest controlado que **una sola credencial comprometida permitía extraer todos
los archivos de todos los proyectos**. Se corrigieron y deployaron las de mayor impacto,
se activó cifrado en reposo, y se dejó una suite de regresión que verifica que las
protecciones sigan en pie.

**Base defensiva que ya estaba bien:** bucket no público, API keys hasheadas (SHA-256),
comparación de master key en tiempo constante, helmet + CSP, expiración de keys,
presigned URLs, `.env` fuera de git.

---

## 2. Hallazgos

### 🔴 ALTO

**H1 — XSS almacenado vía nombre de archivo → robo de la master key.**
`dashboard.js` insertaba `original_filename` sin escapar en un template `innerHTML`
(widget "archivos más grandes"). `original_filename` es controlado por cualquiera con una
key de upload (la validación no restringía caracteres). Al abrir el dashboard, el admin
ejecutaba el payload en el origen `upload.nicolasrusso.ar`, donde la master key vive en
memoria → exfiltración → **control total** del servicio (todos los proyectos).
→ **Corregido:** H1a escape de salida (`esc()`), H1b master key sólo en memoria, H1c
validación server-side del nombre.

**H2 — Aislamiento entre proyectos débil (cross-tenant).**
El scope de una key es sólo por **nombre de carpeta**, con match de **substring**
(`objectKey.includes('/'+folder+'/')`), sin atar al proyecto/`owner_user_id`. Dos proyectos
que compartan nombre de carpeta pueden leerse/borrarse archivos. `create-download-url` sólo
pide un `fileId`; el propio código admitía que faltaba verificar ownership.
→ **Pendiente (E):** fix riesgoso porque cambia el modelo de scoping de keys ya emitidas.

### 🟠 MEDIO

**M3 — Tamaño/tipo no se hacían cumplir en el PUT presignado.** `MAX_FILE_SIZE_BYTES` y
`mimeType` se validaban sólo contra lo declarado por el cliente; el PUT a MinIO no capa
`Content-Length` ni `Content-Type` → subida de archivos de cualquier tamaño (abuso de
disco) o tipo. → **Corregido:** validación del tamaño real en `confirm-upload` vía
`statObject` (borra + 413 si excede).

**M4 — SVG permitido y servido inline.** `image/svg+xml` en el allowlist; un SVG lleva JS
que corre en `files.nicolasrusso.ar` al abrirlo en el browser. → **Corregido:** SVG fuera
del allowlist + `Content-Disposition: attachment` para tipos activos.

**M5 — Master key en `sessionStorage`** (`uploader.js`). Persistida en el origen público →
cualquier XSS la levanta. → **Corregido:** sólo en memoria.

### 🟡 BAJO / HARDENING

- **B6 — Sin cifrado en reposo.** → **Corregido:** SSE-S3 activado (ver §4).
- **F7 — `.env` world-readable (664)** con master key, admin secret, MinIO root. → **Corregido:** `chmod 600`.
- **F8 — Dashboard público sin Cloudflare Access.** → **Pendiente** (lado del usuario).
- **B9 — Rate limit laxo** (1000/min; el comentario decía 60). → Documentado; requiere análisis de tráfico real.
- **B10 — Menores:** `hasuraQuery` sin timeout; hash de keys sin pepper HMAC (aceptable por entropía).

---

## 3. Pentest (cadenas demostradas, no destructivo, sin exfiltración)

Ejecutado contra el servicio en vivo el 2026-07-24. Todos los artefactos de prueba fueron
eliminados y verificados en 0.

**Cadena A — Master key = TODO (jackpot).** Con la master key: enumeración de **1.341
archivos** de todos los proyectos vía `/admin/files`, y descarga de los bytes reales de un
archivo. Cloudflare devolvió `error 1010` (bloqueo de bot) al primer intento, pero se
**saltó con un User-Agent de navegador** → esa capa no es protección.

**Cadena B — Key scopeada filtrada = su carpeta entera.** Una key de frontend filtrada
(viven en el browser) extrae todos los archivos de su carpeta. El cruce a otra carpeta de
**nombre distinto** está bloqueado (403) — el aislamiento contiene ese caso, pero no el de
carpetas con nombre compartido (H2).

**Cadena C — XSS almacenado = robo de la master key (la entrada).** Un `create-upload` con
`original_filename` malicioso se aceptaba (201) y guardaba sin escapar → ejecuta en el
dashboard → roba la master key → habilita la Cadena A.

**Kill chain externa completa:**
```
1. Conseguir una key de upload de bajo privilegio (viven en frontends → DevTools, o leaks)
2. Plantar el XSS: /create-upload con nombre de archivo malicioso            (Cadena C)
3. El admin abre el dashboard → el JS roba la MASTER_KEY de memoria
4. Con la master: enumerar 1.341 archivos + minta URLs de descarga           (Cadena A)
   → descargar con UA de navegador (bypass Cloudflare) → EXFILTRACIÓN TOTAL
```

---

## 4. Correcciones aplicadas (deployadas + verificadas)

| ID | Cambio | Archivo(s) |
|---|---|---|
| H1a | `esc()` escapa `original_filename`/`mime_type`/carpeta en `innerHTML` | `src/dashboard/dashboard.js` |
| H1b | Master key del uploader sólo en memoria (sin `sessionStorage`) | `src/dashboard/uploader.js` |
| H1c | Nombre de archivo rechaza `<>`, caracteres de control y >255 chars | `src/middleware/validate.ts` |
| M3 | Enforce del tamaño real en confirm (borra + 413 si excede) | `src/routes/confirmUpload.ts` |
| M4 | SVG fuera del allowlist | `src/middleware/validate.ts` |
| M4/C | `Content-Disposition` quirúrgico: inline para imágenes/PDF, attachment para el resto | `src/routes/createDownloadUrl.ts`, `src/routes/admin/share.ts` |
| D | helmet/CSP endurecido: `objectSrc 'none'`, `baseUri`, `frameAncestors 'none'`, `formAction`, CORP, referrer, HSTS | `src/index.ts` |
| B6 | SSE-S3/AES256 activado en el bucket | MinIO + `scripts/enable-sse.js` |
| F7 | `chmod 600` en `files/.env` y `minio-stack/.env` | — |

### Cifrado en reposo (B6) — detalle
- El KMS de MinIO **nunca estuvo configurado** (`MINIO_KMS_SECRET_KEY_FILE=kms_master_key`
  viene horneado en la imagen y apunta a un archivo inexistente = inofensivo).
- Se generó una master key de 32 bytes, se puso `MINIO_KMS_SECRET_KEY=minio-files-key:<base64>`
  en `minio-stack/.env`, y se recreó el contenedor (~3 s de downtime).
- **Gotcha:** minio-js 7.1.3 serializa mal `setBucketEncryption(b,{Rule:[...]})` (algoritmo
  vacío → no cifra). Hay que llamarlo **sin argumentos**. `scripts/enable-sse.js` ya está corregido.
- **Verificado en disco:** los objetos nuevos tienen marcadores `Server-Side-Encryption` en
  su `xl.meta`; la lectura es transparente. Los **1.341 objetos viejos siguen en texto plano**
  hasta reescribirlos.

> ⚠️ Durante la verificación hubo dos falsos positivos porque el contenedor MinIO no tiene
> `grep`/`strings` (imagen mínima) y esos chequeos fallaban en silencio. La verificación
> correcta es leyendo el `xl.meta` **desde el host**, no con `docker exec grep`.

---

## 5. Verificación

- `tsc --noEmit` limpio · `npm run build` OK · `pm2 restart` sin errores.
- Smoke test round-trip real: upload (nombre con ñ/espacios)→201, confirm→200, download con
  bytes coincidentes + `inline` para imagen, `<>`→400, SVG→400.
- `/health` 200 local y público; MinIO `/health` 200.
- **Suite de regresión: 14/14 PASS** (`node security/selftest.mjs`).

---

## 6. Pendientes y recomendaciones (orden de prioridad)

1. **Cloudflare Access sobre `/dashboard`, `/uploader`, `/test`** — mitigación clave de la
   Cadena A: hoy cualquiera carga la pantalla donde se tipea la master key. (Lado del usuario.)
2. **Recifrar los 1.341 objetos viejos** — SSE sólo cifró los nuevos (ver RUNBOOK).
3. **Rotar la master key** tras deployar (por si estuvo expuesta).
4. **E — Aislamiento cross-tenant (H2):** atar keys a un namespace propio, no a nombre de
   carpeta compartido. Riesgoso: afecta las keys ya emitidas de todos los proyectos.
5. **Bug latente:** `listObjectsV2` del SDK crashea al listar todo el bucket (fast-xml-parser,
   "entity expansion"); no afecta la app (usa Hasura), sí scripts de mantenimiento.

---

## 7. Archivos tocados (sin commitear)

```
src/dashboard/dashboard.js        src/routes/confirmUpload.ts
src/dashboard/uploader.js         src/routes/createDownloadUrl.ts
src/middleware/validate.ts        src/routes/admin/share.ts
src/index.ts                      scripts/enable-sse.js            (nuevo)
security/                         (nuevo: README, este informe, RUNBOOK, selftest, autorización, prompt)
minio-stack/.env                  (+ MINIO_KMS_SECRET_KEY)
minio-stack/kms-backup/           (nuevo: backup de la key KMS)
```
