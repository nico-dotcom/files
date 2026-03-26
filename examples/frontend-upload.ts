/**
 * Frontend upload example (TypeScript / browser)
 *
 * This shows the complete 3-step upload flow:
 *   1. Request a presigned PUT URL from your backend
 *   2. PUT the file directly to MinIO using the presigned URL
 *   3. Confirm the upload via your backend
 *
 * No MinIO credentials ever touch the frontend.
 */

const BACKEND_URL = "http://localhost:3001"; // your upload microservice

// ─── Types ────────────────────────────────────────────────────────────────────

interface CreateUploadResponse {
  fileId: string;
  uploadUrl: string;
  objectKey: string;
  expiresInSeconds: number;
}

interface ConfirmUploadResponse {
  fileId: string;
  status: string;
  uploadedAt: string;
  objectKey: string;
  originalFilename: string;
}

interface CreateDownloadUrlResponse {
  downloadUrl: string;
  expiresInSeconds: number;
  originalFilename: string;
  mimeType: string;
  objectKey: string;
}

// ─── Step 1: Request presigned URL ───────────────────────────────────────────

async function requestUploadUrl(
  file: File,
  userId: string
): Promise<CreateUploadResponse> {
  const response = await fetch(`${BACKEND_URL}/create-upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      userId,
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`create-upload failed: ${err.error}`);
  }

  return response.json();
}

// ─── Step 2: PUT file directly to MinIO ──────────────────────────────────────

async function uploadFileToMinio(
  file: File,
  uploadUrl: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });

    xhr.addEventListener("load", () => {
      // MinIO returns 200 for successful presigned PUT
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`MinIO upload failed with status ${xhr.status}`));
      }
    });

    xhr.addEventListener("error", () =>
      reject(new Error("Network error during upload"))
    );
    xhr.addEventListener("abort", () => reject(new Error("Upload aborted")));

    xhr.open("PUT", uploadUrl);
    // IMPORTANT: set Content-Type to match what you sent to create-upload
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.send(file);
  });
}

// ─── Step 3: Confirm upload ───────────────────────────────────────────────────

async function confirmUpload(fileId: string): Promise<ConfirmUploadResponse> {
  const response = await fetch(`${BACKEND_URL}/confirm-upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`confirm-upload failed: ${err.error}`);
  }

  return response.json();
}

// ─── Full upload flow ─────────────────────────────────────────────────────────

export async function uploadFile(
  file: File,
  userId: string,
  onProgress?: (percent: number) => void
): Promise<ConfirmUploadResponse> {
  console.log(`[upload] Starting upload for "${file.name}" (${file.size} bytes)`);

  // 1. Get presigned URL
  const { fileId, uploadUrl } = await requestUploadUrl(file, userId);
  console.log(`[upload] Got presigned URL for fileId=${fileId}`);

  // 2. Upload directly to MinIO
  await uploadFileToMinio(file, uploadUrl, onProgress);
  console.log(`[upload] File uploaded to MinIO`);

  // 3. Confirm with backend
  const result = await confirmUpload(fileId);
  console.log(`[upload] Confirmed. Status=${result.status}`);

  return result;
}

// ─── Download URL helper ──────────────────────────────────────────────────────

export async function getDownloadUrl(
  fileId: string
): Promise<CreateDownloadUrlResponse> {
  const response = await fetch(`${BACKEND_URL}/create-download-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`create-download-url failed: ${err.error}`);
  }

  return response.json();
}

// ─── React hook example ───────────────────────────────────────────────────────
/*
import { useState, useCallback } from "react";

export function useFileUpload(userId: string) {
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(async (file: File) => {
    setUploading(true);
    setError(null);
    setProgress(0);
    try {
      const result = await uploadFile(file, userId, setProgress);
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      throw err;
    } finally {
      setUploading(false);
    }
  }, [userId]);

  return { upload, progress, uploading, error };
}
*/

// ─── Vanilla JS usage example ─────────────────────────────────────────────────
/*
document.getElementById("file-input")?.addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;

  try {
    const result = await uploadFile(file, "550e8400-e29b-41d4-a716-446655440000", (pct) => {
      console.log(`Upload progress: ${pct}%`);
    });
    console.log("Upload complete:", result);
  } catch (err) {
    console.error("Upload failed:", err);
  }
});
*/
