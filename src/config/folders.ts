import { hasuraQuery } from "./hasura";

export interface FolderRecord {
  id: string;
  name: string;
  created_at: string;
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
  const data = await hasuraQuery<{ folders: FolderRecord[] }>(
    `query ListFolders {
      folders(order_by: { name: asc }) {
        id name created_at
      }
    }`
  );
  return data.folders;
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
