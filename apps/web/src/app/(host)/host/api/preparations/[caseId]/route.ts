import { decodeExperiencePreparationEditorPatch, isExperiencePreparationPathId } from "@niho-experience/api-client/experience-preparations-schema";
import { isPreparationHttpEnabled, loadPreparationHostClient, preparationFailureJson, preparationJson, preparationMutationAllowed, readBoundedJson } from "@/lib/preparations/server";

type Context = { params: Promise<{ caseId: string }> };

export async function GET(request: Request, context: Context) {
  const { caseId } = await context.params;
  if (!isPreparationHttpEnabled() || new URL(request.url).search || !isExperiencePreparationPathId(caseId)) return preparationJson({ error: "not_found" }, 404);
  const loaded = await loadPreparationHostClient();
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.getCase(caseId);
  return result.ok ? preparationJson(result.data) : preparationFailureJson(result, "host");
}

export async function PATCH(request: Request, context: Context) {
  const { caseId } = await context.params;
  if (!isPreparationHttpEnabled() || !isExperiencePreparationPathId(caseId)) return preparationJson({ error: "not_found" }, 404);
  if (!preparationMutationAllowed(request)) return preparationJson({ error: "forbidden" }, 403);
  const body = await readBoundedJson(request, 192 * 1024);
  const patch = body.ok ? decodeExperiencePreparationEditorPatch(body.value) : null;
  if (!patch) return preparationJson({ error: "invalid_input" }, 400);
  const loaded = await loadPreparationHostClient();
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.patchDraft(caseId, patch);
  return result.ok ? preparationJson(result.data) : preparationFailureJson(result, "host");
}
