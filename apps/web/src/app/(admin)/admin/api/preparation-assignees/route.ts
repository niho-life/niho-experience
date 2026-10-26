import { isExperiencePreparationSearch } from "@niho-experience/api-client/experience-preparations-schema";
import { adminMutationAllowed } from "@/lib/admin/server";
import { isPreparationHttpEnabled, loadPreparationAdminClient, preparationFailureJson, preparationJson, readBoundedJson } from "@/lib/preparations/server";

export async function POST(request: Request) {
  if (!isPreparationHttpEnabled()) return preparationJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return preparationJson({ error: "forbidden" }, 403);
  const body = await readBoundedJson(request, 1024);
  if (!body.ok || typeof body.value !== "object" || body.value === null || Array.isArray(body.value) || Object.keys(body.value).length !== 1) return preparationJson({ error: "invalid_input" }, 400);
  const query = (body.value as { query?: unknown }).query;
  if (!isExperiencePreparationSearch(query)) return preparationJson({ error: "invalid_input" }, 400);
  const loaded = await loadPreparationAdminClient();
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.searchAssignmentCandidates(query);
  return result.ok ? preparationJson(result.data) : preparationFailureJson(result, "admin");
}
