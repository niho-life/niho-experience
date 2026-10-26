import { decodeExperiencePreparationDraft, isExperiencePreparationPathId } from "@niho-experience/api-client/experience-preparations-schema";
import { adminMutationAllowed } from "@/lib/admin/server";
import { isPreparationHttpEnabled, loadPreparationAdminClient, preparationEmpty, preparationFailureJson, preparationJson, readBoundedJson } from "@/lib/preparations/server";

type Context = { params: Promise<{ caseId: string }> };

export async function GET(request: Request, context: Context) {
  const { caseId } = await context.params;
  if (!isPreparationHttpEnabled() || new URL(request.url).search || !isExperiencePreparationPathId(caseId)) return preparationJson({ error: "not_found" }, 404);
  const loaded = await loadPreparationAdminClient();
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.getCase(caseId);
  return result.ok ? preparationJson(result.data) : preparationFailureJson(result, "admin");
}

export async function PATCH(request: Request, context: Context) {
  const { caseId } = await context.params;
  if (!isPreparationHttpEnabled() || !isExperiencePreparationPathId(caseId)) return preparationJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return preparationJson({ error: "forbidden" }, 403);
  const body = await readBoundedJson(request, 256 * 1024);
  if (!body.ok || typeof body.value !== "object" || body.value === null || Array.isArray(body.value) || Object.keys(body.value).length !== 2) return preparationJson({ error: "invalid_input" }, 400);
  const value = body.value as Record<string, unknown>;
  const draft = decodeExperiencePreparationDraft(value.draft);
  if (!draft || !Number.isInteger(value.expectedRevision) || (value.expectedRevision as number) < 1) return preparationJson({ error: "invalid_input" }, 400);
  const loaded = await loadPreparationAdminClient();
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.patchCase(caseId, value.expectedRevision as number, draft);
  return result.ok ? preparationJson(result.data) : preparationFailureJson(result, "admin");
}

export async function DELETE(request: Request, context: Context) {
  const { caseId } = await context.params;
  if (!isPreparationHttpEnabled() || new URL(request.url).search || !isExperiencePreparationPathId(caseId)) return preparationJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return preparationJson({ error: "forbidden" }, 403);
  const raw = await request.text().catch(() => null);
  if (raw === null || raw.length > 0) return preparationJson({ error: "invalid_input" }, 400);
  const loaded = await loadPreparationAdminClient();
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.purge(caseId);
  return result.ok ? preparationEmpty() : preparationFailureJson(result, "admin");
}
