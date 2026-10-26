import { decodeExperiencePreparationDraft } from "@niho-experience/api-client/experience-preparations-schema";
import { adminMutationAllowed } from "@/lib/admin/server";
import { isPreparationHttpEnabled, loadPreparationAdminClient, preparationFailureJson, preparationJson, readBoundedJson } from "@/lib/preparations/server";

export async function GET(request: Request) {
  if (!isPreparationHttpEnabled() || new URL(request.url).search) return preparationJson({ error: "not_found" }, 404);
  const loaded = await loadPreparationAdminClient();
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.listCases();
  return result.ok ? preparationJson(result.data) : preparationFailureJson(result, "admin");
}

export async function POST(request: Request) {
  if (!isPreparationHttpEnabled()) return preparationJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return preparationJson({ error: "forbidden" }, 403);
  const body = await readBoundedJson(request, 256 * 1024);
  if (!body.ok || typeof body.value !== "object" || body.value === null || Array.isArray(body.value) || Object.keys(body.value).length !== 1 || !("draft" in body.value)) return preparationJson({ error: "invalid_input" }, 400);
  const draft = decodeExperiencePreparationDraft(body.value.draft);
  if (!draft) return preparationJson({ error: "invalid_input" }, 400);
  const loaded = await loadPreparationAdminClient();
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.createCase(draft);
  return result.ok ? preparationJson(result.data, 201) : preparationFailureJson(result, "admin");
}
