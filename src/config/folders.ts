import { hasuraQuery } from "./hasura";

export interface FolderRecord {
  id: string;
  name: string;
  created_at: string;
  key_count?: number;
  size_bytes?: number;
  file_count?: number;
}

export async function createFolder(name: string): Promise<FolderRecord> {
  const data = await hasuraQuery<{ insert_folders_one: FolderRecord }>(
    `mutation CreateFolder($name: String!) {
      insert_folders_one(object: { name: $name }) {
        id name created_at
      }
    }`,
    { name }
  );
  return data.insert_folders_one;
}

export async function listFolders(): Promise<FolderRecord[]> {
  const data = await hasuraQuery<{ folders: Array<FolderRecord & { api_key_folders: { api_key_id: string }[] }> }>(
    `query ListFolders {
      folders(order_by: { name: asc }) {
        id name created_at
        api_key_folders(where: { api_key: { is_active: { _eq: true } } }) {
          api_key_id
        }
      }
    }`
  );
  return data.folders.map(f => ({
    id: f.id,
    name: f.name,
    created_at: f.created_at,
    key_count: f.api_key_folders?.length ?? 0,
  }));
}

export async function deleteFolder(id: string): Promise<boolean> {
  const data = await hasuraQuery<{ delete_folders_by_pk: { id: string } | null }>(
    `mutation DeleteFolder($id: uuid!) {
      delete_folders_by_pk(id: $id) { id }
    }`,
    { id }
  );
  return data.delete_folders_by_pk !== null;
}
