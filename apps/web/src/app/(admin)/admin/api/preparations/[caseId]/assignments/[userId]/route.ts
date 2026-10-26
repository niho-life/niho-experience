import { isExperiencePreparationPathId } from "@niho-experience/api-client/experience-preparations-schema";
import type { ExperiencePreparationRole } from "@niho-experience/api-client/experience-preparations";
import { adminMutationAllowed } from "@/lib/admin/server";
import { isPreparationHttpEnabled, loadPreparationAdminClient, preparationEmpty, preparationFailureJson, preparationJson, readBoundedJson } from "@/lib/preparations/server";

type Context = { params: Promise<{ caseId: string; userId: string }> };

export async function PUT(request: Request, context: Context) {
  const { caseId, userId } = await context.params;
  if (!isPreparationHttpEnabled() || !isExperiencePreparationPathId(caseId) || !isExperiencePreparationPathId(userId)) return preparationJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return preparationJson({ error: "forbidden" }, 403);
  const body = await readBoundedJson(request, 1024);
  if (!body.ok || typeof body.value !== "object" || body.value === null || Array.isArray(body.value) || Object.keys(body.value).length !== 1) return preparationJson({ error: "invalid_input" }, 400);
  const role = (body.value as { role?: unknown }).role;
  if (role !== "COHOST") return preparationJson({ error: "invalid_input" }, 400);
  const loaded = await loadPreparationAdminClient();
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.assign(caseId, userId, role satisfies ExperiencePreparationRole);
  return result.ok ? preparationJson(result.data) : preparationFailureJson(result, "admin");
}

export async function DELETE(request: Request, context: Context) {
  const { caseId, userId } = await context.params;
  if (!isPreparationHttpEnabled() || new URL(request.url).search || !isExperiencePreparationPathId(caseId) || !isExperiencePreparationPathId(userId)) return preparationJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return preparationJson({ error: "forbidden" }, 403);
  const raw = await request.text().catch(() => null);
  if (raw === null || raw.length > 0) return preparationJson({ error: "invalid_input" }, 400);
  const loaded = await loadPreparationAdminClient();
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.removeAssignment(caseId, userId);
  return result.ok ? preparationEmpty() : preparationFailureJson(result, "admin");
}
