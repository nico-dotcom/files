# Instrucciones para IAs — Cómo guardar archivos en este sistema

> Copiá y pegá esta sección en el contexto de la IA que quieras integrar.

---

## Contexto del sistema

Este sistema es una API de almacenamiento de archivos basada en **MinIO presigned URLs**.
Los archivos **no se envían a través de la API** — la API genera una URL firmada y vos hacés el upload directo a MinIO.

**URL base de la API:** `https://api.tudominio.com` (reemplazar con la URL real)

---

## Autenticación

Todos los requests (excepto `/health`) requieren:

```
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

Donde `<API_KEY>` es una key generada desde el dashboard del sistema, NO la master key.

---

## Flujo completo para guardar un archivo (3 pasos)

### Paso 1 — Pedir la URL de upload

```
POST /create-upload
Authorization: Bearer <API_KEY>
Content-Type: application/json

{
  "filename":  "nombre-del-archivo.pdf",
  "mimeType":  "application/pdf",
  "sizeBytes": 204800,
  "userId":    "uuid-del-usuario-dueño",
  "folder":    "carpeta-opcional"
}
```

**Respuesta `201`:**

```json
{
  "fileId":           "uuid-del-archivo",
  "uploadUrl":        "https://storage.tudominio.com/...?X-Amz-Signature=...",
  "objectKey":        "uploads/.../carpeta/fecha/uuid-nombre.pdf",
  "expiresInSeconds": 900
}
```

Guardar el `fileId` — se necesita en los pasos siguientes.

### Paso 2 — Subir el archivo a MinIO (directo, sin API key)

```
PUT <uploadUrl>
Content-Type: <mimeType-del-archivo>

<bytes del archivo>
```

La `uploadUrl` ya tiene la autenticación embebida en los query params. No agregar `Authorization` header.

### Paso 3 — Confirmar el upload

```
POST /confirm-upload
Authorization: Bearer <API_KEY>
Content-Type: application/json

{
  "fileId": "uuid-del-archivo"
}
```

**Respuesta `200`:**

```json
{
  "fileId":           "uuid-del-archivo",
  "status":           "uploaded",
  "uploadedAt":       "2024-01-15T10:31:05.123Z",
  "objectKey":        "uploads/.../carpeta/fecha/uuid-nombre.pdf",
  "originalFilename": "nombre-del-archivo.pdf"
}
```

---

## Cómo obtener una URL de descarga

```
POST /create-download-url
Authorization: Bearer <API_KEY>
Content-Type: application/json

{
  "fileId": "uuid-del-archivo"
}
```

**Respuesta `200`:**

```json
{
  "downloadUrl":      "https://storage.tudominio.com/...?X-Amz-Signature=...",
  "expiresInSeconds": 900,
  "originalFilename": "nombre-del-archivo.pdf",
  "mimeType":         "application/pdf",
  "objectKey":        "uploads/.../carpeta/fecha/uuid-nombre.pdf"
}
```

La `downloadUrl` es válida por 15 minutos (configurable). Usarla para servir el archivo al usuario.

---

## Tipos de archivo permitidos (MIME types)

Solo estos MIME types son aceptados:

- `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/svg+xml`
- `application/pdf`
- `text/plain`, `text/csv`
- `application/json`
- `application/zip`
- `video/mp4`, `video/webm`
- `audio/mpeg`, `audio/wav`
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (docx)
- `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (xlsx)

Si enviás otro MIME type, el servidor responde `415 Unsupported Media Type`.

---

## Límites

| Límite | Valor |
|---|---|
| Tamaño máximo de archivo | 100 MB (configurable) |
| Validez de la URL de upload | 15 minutos |
| Rate limit general | 60 requests/minuto por IP |
| Tamaño del body JSON | 16 KB |

---

## Campos requeridos en `/create-upload`

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `filename` | string | sí | Nombre del archivo con extensión |
| `mimeType` | string | sí | MIME type del archivo |
| `sizeBytes` | number | sí | Tamaño exacto en bytes |
| `userId` | string (UUID v4) | sí | Identificador del usuario propietario |
| `folder` | string | no | Subcarpeta dentro del bucket. Si la API key tiene un prefijo fijo, este campo se ignora. |

---

## Errores comunes y cómo manejarlos

| Código | Significado | Qué hacer |
|---|---|---|
| `401` | Falta el header `Authorization` | Agregar `Authorization: Bearer <key>` |
| `403` | Key inválida, revocada, o sin permisos para esa carpeta | Verificar que la key sea correcta y tenga scope sobre la carpeta |
| `415` | MIME type no permitido | Verificar que el tipo de archivo esté en la lista de permitidos |
| `422` | Archivo no encontrado en storage al confirmar | El PUT al `uploadUrl` no se completó — reintentar el paso 2 |
| `429` | Rate limit superado | Esperar y reintentar con backoff exponencial |

---

## Ejemplo completo en Python

```python
import requests

API = "https://api.tudominio.com"
API_KEY = "sk_..."  # tu API key

def subir_archivo(filepath: str, user_id: str, folder: str = "general") -> dict:
    import os, mimetypes

    filename = os.path.basename(filepath)
    mime_type, _ = mimetypes.guess_type(filepath)
    size_bytes = os.path.getsize(filepath)

    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }

    # Paso 1: pedir URL de upload
    r = requests.post(f"{API}/create-upload", json={
        "filename": filename,
        "mimeType": mime_type,
        "sizeBytes": size_bytes,
        "userId": user_id,
        "folder": folder,
    }, headers=headers)
    r.raise_for_status()
    data = r.json()

    file_id = data["fileId"]
    upload_url = data["uploadUrl"]

    # Paso 2: subir directo a MinIO (sin headers de autenticación)
    with open(filepath, "rb") as f:
        put_response = requests.put(upload_url, data=f, headers={"Content-Type": mime_type})
    put_response.raise_for_status()

    # Paso 3: confirmar
    confirm = requests.post(f"{API}/confirm-upload", json={"fileId": file_id}, headers=headers)
    confirm.raise_for_status()

    return confirm.json()  # incluye fileId, status, objectKey, originalFilename


def obtener_url_descarga(file_id: str) -> str:
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }
    r = requests.post(f"{API}/create-download-url", json={"fileId": file_id}, headers=headers)
    r.raise_for_status()
    return r.json()["downloadUrl"]
```

---

## Ejemplo completo en TypeScript / JavaScript

```typescript
const API = "https://api.tudominio.com";
const API_KEY = process.env.UPLOAD_API_KEY!;

const headers = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${API_KEY}`,
};

async function subirArchivo(file: File, userId: string, folder = "general") {
  // Paso 1
  const createRes = await fetch(`${API}/create-upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      userId,
      folder,
    }),
  });
  if (!createRes.ok) throw new Error(`create-upload failed: ${createRes.status}`);
  const { fileId, uploadUrl } = await createRes.json();

  // Paso 2 — no agregar Authorization acá
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!putRes.ok) throw new Error(`upload to MinIO failed: ${putRes.status}`);

  // Paso 3
  const confirmRes = await fetch(`${API}/confirm-upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({ fileId }),
  });
  if (!confirmRes.ok) throw new Error(`confirm-upload failed: ${confirmRes.status}`);
  return confirmRes.json();
}

async function obtenerUrlDescarga(fileId: string): Promise<string> {
  const res = await fetch(`${API}/create-download-url`, {
    method: "POST",
    headers,
    body: JSON.stringify({ fileId }),
  });
  if (!res.ok) throw new Error(`create-download-url failed: ${res.status}`);
  const { downloadUrl } = await res.json();
  return downloadUrl;
}
```

---

## Notas importantes

1. **No enviar la API key al browser directamente** — si es una integración frontend, usar una variable de entorno del framework (`NEXT_PUBLIC_*` en Next.js, etc.) y crear una key con permisos mínimos (solo la carpeta que necesite).

2. **El `userId` debe ser un UUID v4 válido** — el servidor valida el formato. Si tu sistema no usa UUIDs, podés generar uno determinístico a partir del ID de usuario (ej: UUID v5 con namespace propio).

3. **La `uploadUrl` expira en 15 minutos** — si el usuario tarda más, el PUT va a fallar con 403. En ese caso, repetir el Paso 1 para obtener una URL nueva.

4. **No confirmar un upload sin antes hacer el PUT** — el endpoint `/confirm-upload` verifica que el objeto exista en MinIO antes de marcarlo como subido.

5. **El `folder` en `/create-upload` se ignora si la API key tiene un prefijo fijo** — si la key fue creada con prefijo `documentos/`, todos los archivos van a esa carpeta sin importar lo que se mande en `folder`.
