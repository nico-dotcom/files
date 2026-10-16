/**
 * Fire-and-forget traffic logging to the file_events table via Hasura.
 * Errors are swallowed — logging must never break the main request flow.
 */
import { hasuraQuery } from "./hasura";

export type FileEventType =
  | "upload_initiated"
  | "upload_confirmed"
  | "download_url_created"
  | "file_deleted";

const INSERT_FILE_EVENT = `
  mutation InsertFileEvent(
    $event_type: String!
    $file_id: uuid
    $api_key_id: String
    $api_key_uuid: uuid
    $object_key: String
    $mime_type: String
    $size_bytes: bigint
  ) {
    insert_file_events_one(object: {
      event_type: $event_type
      file_id: $file_id
      api_key_id: $api_key_id
      api_key_uuid: $api_key_uuid
      object_key: $object_key
      mime_type: $mime_type
      size_bytes: $size_bytes
    }) {
      id
    }
  }
`;

// Matches a canonical uuid. The master key uses the literal id "master"
// (non-uuid) and deleted keys may not be FK-resolvable, so api_key_uuid is
// only set when api_key_id is a real uuid; otherwise it stays NULL.
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function logFileEvent(params: {
  event_type: FileEventType;
  file_id?: string;
  api_key_id?: string;
  object_key?: string;
  mime_type?: string;
  size_bytes?: number;
}): void {
  const apiKeyId = params.api_key_id ?? null;
  hasuraQuery(INSERT_FILE_EVENT, {
    event_type: params.event_type,
    file_id: params.file_id ?? null,
    api_key_id: apiKeyId,
    api_key_uuid: apiKeyId && UUID_RE.test(apiKeyId) ? apiKeyId : null,
    object_key: params.object_key ?? null,
    mime_type: params.mime_type ?? null,
    size_bytes: params.size_bytes ?? null,
  }).catch(() => {/* ignore — logging must never break the main flow */});
}
