# Instrucciones para IAs — Cómo guardar archivos en este sistema

> Copiá y pegá esta sección en el contexto de la IA que quieras integrar.

---

## Contexto del sistema

API de almacenamiento de archivos basada en **MinIO presigned URLs**.
Los archivos **no se envían a través de la API** — la API genera una URL firmada y el cliente hace el upload directo a MinIO.

**URL base de la API:** `https://upload.nicolasrusso.ar` (reemplazar con la URL real)

---

## Autenticación

Todos los requests (excepto `/health`) requieren:

```
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

`<API_KEY>` es una key creada desde el dashboard, NO la master key.

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

Sobre el campo `folder`:
- Si la key tiene **acceso global** (`*`): `folder` es opcional, default `general`.
- Si la key tiene **una carpeta asignada**: `folder` se ignora, se usa la carpeta de la key.
- Si la key tiene **múltiples carpetas**: `folder` es **requerido** y debe ser una de las carpetas asignadas.

**Respuesta `201`:**

```json
{
  "fileId":           "uuid-del-archivo",
  "uploadUrl":        "https://files.nicolasrusso.ar/...?X-Amz-Signature=...",
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

La `uploadUrl` ya tiene la autenticación embebida en los query params. **No agregar `Authorization` header.**

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
  "downloadUrl":      "https://files.nicolasrusso.ar/...?X-Amz-Signature=...",
  "expiresInSeconds": 900,
  "originalFilename": "nombre-del-archivo.pdf",
  "mimeType":         "application/pdf",
  "objectKey":        "uploads/.../carpeta/fecha/uuid-nombre.pdf"
}
```

La `downloadUrl` es válida por 15 minutos. Usarla para servir el archivo al usuario.

---

## Cómo eliminar un archivo

Requiere una API key con `can_delete: true`.

```
DELETE /files/<fileId>
Authorization: Bearer <API_KEY>
```

**Respuesta `200`:** `{ "message": "File deleted", "id": "..." }`

**Errores:**
- `403` — key sin permiso de eliminación, o archivo fuera del scope de la key
- `404` — archivo no encontrado
- `410` — archivo ya eliminado

---

## Tipos de archivo permitidos (MIME types)

- `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/svg+xml`
- `application/pdf`
- `text/plain`, `text/csv`
- `application/json`
- `application/zip`
- `video/mp4`, `video/webm`
- `audio/mpeg`, `audio/wav`
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (docx)
- `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (xlsx)

Otros MIME types → `415 Unsupported Media Type`.

---

## Límites

| Límite | Valor |
|---|---|
| Tamaño máximo de archivo | 100 MB |
| Validez de la URL de upload | 15 minutos |
| Rate limit general | 60 requests/minuto por IP |
| Tamaño del body JSON | 16 KB |

---

## Errores comunes

| Código | Causa | Solución |
|---|---|---|
| `401` | Falta `Authorization` header | Agregar `Authorization: Bearer <key>` |
| `403` | Key inválida, revocada, sin permisos, o carpeta fuera de scope | Verificar key y carpeta |
| `415` | MIME type no permitido | Usar un MIME type de la lista |
| `422` | El PUT a MinIO no se completó | Reintentar el paso 2 antes de confirmar |
| `429` | Rate limit superado | Esperar y reintentar con backoff exponencial |

---

## Ejemplo en Python

```python
import requests

API = "https://upload.nicolasrusso.ar"
API_KEY = "sk_..."  # key creada desde el dashboard

def subir_archivo(filepath: str, user_id: str, folder: str = "general") -> dict:
    import os, mimetypes

    filename = os.path.basename(filepath)
    mime_type, _ = mimetypes.guess_type(filepath)
    size_bytes = os.path.getsize(filepath)

    headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

    # Paso 1
    r = requests.post(f"{API}/create-upload", json={
        "filename": filename, "mimeType": mime_type,
        "sizeBytes": size_bytes, "userId": user_id, "folder": folder,
    }, headers=headers)
    r.raise_for_status()
    data = r.json()

    # Paso 2 — sin Authorization
    with open(filepath, "rb") as f:
        requests.put(data["uploadUrl"], data=f,
                     headers={"Content-Type": mime_type}).raise_for_status()

    # Paso 3
    confirm = requests.post(f"{API}/confirm-upload",
                            json={"fileId": data["fileId"]}, headers=headers)
    confirm.raise_for_status()
    return confirm.json()


def obtener_url_descarga(file_id: str) -> str:
    headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
    r = requests.post(f"{API}/create-download-url",
                      json={"fileId": file_id}, headers=headers)
    r.raise_for_status()
    return r.json()["downloadUrl"]
```

---

## Ejemplo en TypeScript / JavaScript

```typescript
const API = "https://upload.nicolasrusso.ar";
const API_KEY = process.env.UPLOAD_API_KEY!;

const headers = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${API_KEY}`,
};

async function subirArchivo(file: File, userId: string, folder = "general") {
  // Paso 1
  const { fileId, uploadUrl } = await fetch(`${API}/create-upload`, {
    method: "POST", headers,
    body: JSON.stringify({ filename: file.name, mimeType: file.type,
                           sizeBytes: file.size, userId, folder }),
  }).then(r => r.json());

  // Paso 2 — sin Authorization
  await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });

  // Paso 3
  return fetch(`${API}/confirm-upload`, {
    method: "POST", headers,
    body: JSON.stringify({ fileId }),
  }).then(r => r.json());
}

async function obtenerUrlDescarga(fileId: string): Promise<string> {
  const { downloadUrl } = await fetch(`${API}/create-download-url`, {
    method: "POST", headers,
    body: JSON.stringify({ fileId }),
  }).then(r => r.json());
  return downloadUrl;
}
```

---

## Notas importantes

1. **El `userId` debe ser un UUID v4 válido** — el servidor valida el formato.

2. **La `uploadUrl` expira en 15 minutos** — si el usuario tarda más, repetir el Paso 1.

3. **No confirmar sin antes hacer el PUT** — `/confirm-upload` verifica que el objeto exista en MinIO.

4. **No agregar `Authorization` en el PUT a MinIO** — la URL ya tiene las credenciales embebidas en los query params. Agregar el header causa error.

5. **El campo `folder` puede ser requerido** — depende de cuántas carpetas tenga la key (ver sección arriba).
