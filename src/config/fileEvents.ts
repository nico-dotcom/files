/**
 * Fire-and-forget traffic logging to the file_events table via Hasura.
 * Errors are swallowed — logging must never break the main request flow.
 */
import { hasuraQuery } from "./hasura";

export type FileEventType =
  | "upload_initiated"
  | "upload_confirmed"
  | "download_url_created";

const INSERT_FILE_EVENT = `
  mutation InsertFileEvent(
    $event_type: String!
    $file_id: uuid
    $api_key_id: String
    $object_key: String
    $mime_type: String
    $size_bytes: bigint
  ) {
    insert_file_events_one(object: {
      event_type: $event_type
      file_id: $file_id
      api_key_id: $api_key_id
      object_key: $object_key
      mime_type: $mime_type
      size_bytes: $size_bytes
    }) {
      id
    }
  }
`;

export function logFileEvent(params: {
  event_type: FileEventType;
  file_id?: string;
  api_key_id?: string;
  object_key?: string;
  mime_type?: string;
  size_bytes?: number;
}): void {
  hasuraQuery(INSERT_FILE_EVENT, {
    event_type: params.event_type,
    file_id: params.file_id ?? null,
    api_key_id: params.api_key_id ?? null,
    object_key: params.object_key ?? null,
    mime_type: params.mime_type ?? null,
    size_bytes: params.size_bytes ?? null,
  }).catch(() => {/* ignore — logging must never break the main flow */});
}
