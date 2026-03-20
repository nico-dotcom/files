import { env } from "./env";

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

/**
 * Minimal GraphQL client for Hasura.
 * Authenticates with the admin secret but operates under the service role,
 * which only has permissions on the tables this service needs.
 */
export async function hasuraQuery<T>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const response = await fetch(env.HASURA_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hasura-admin-secret": env.HASURA_ADMIN_SECRET,
      // Restricts operations to the permissions defined for this role,
      // even though we're authenticated with the admin secret.
      "x-hasura-role": env.HASURA_SERVICE_ROLE,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(
      `Hasura HTTP error: ${response.status} ${response.statusText}`
    );
  }

  const json: GraphQLResponse<T> = await response.json();

  if (json.errors && json.errors.length > 0) {
    const messages = json.errors.map((e) => e.message).join("; ");
    throw new Error(`Hasura GraphQL error: ${messages}`);
  }

  if (!json.data) {
    throw new Error("Hasura returned no data and no errors");
  }

  return json.data;
}
