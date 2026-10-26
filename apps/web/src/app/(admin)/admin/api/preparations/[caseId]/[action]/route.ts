import { decodeExperiencePreparationLockedAcceptance, decodeExperiencePreparationUploadPolicyInput, isExperiencePreparationPathId } from "@niho-experience/api-client/experience-preparations-schema";
import { adminMutationAllowed } from "@/lib/admin/server";
import { isPreparationHttpEnabled, loadPreparationAdminClient, preparationFailureJson, preparationJson, readBoundedJson } from "@/lib/preparations/server";

type Context = { params: Promise<{ caseId: string; action: string }> };
const ACTIONS = ["preview-token", "upload-policy", "verify-representative", "materialize", "cancel"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(request: Request, context: Context) {
  const { caseId, action: rawAction } = await context.params;
  const action = ACTIONS.find((value) => value === rawAction) as Action | undefined;
  if (!isPreparationHttpEnabled() || !action || !isExperiencePreparationPathId(caseId) || new URL(request.url).search) return preparationJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return preparationJson({ error: "forbidden" }, 403);
  const loaded = await loadPreparationAdminClient();
  if (!loaded.ok) return loaded.response;

  if (action === "preview-token" || action === "cancel") {
    const raw = await request.text().catch(() => null);
    if (raw === null || raw.length > 0) return preparationJson({ error: "invalid_input" }, 400);
    const result = action === "preview-token" ? await loaded.client.issuePreviewToken(caseId) : await loaded.client.cancel(caseId);
    return result.ok ? preparationJson(result.data, action === "preview-token" ? 201 : 200) : preparationFailureJson(result, "admin");
  }

  const body = await readBoundedJson(request, 16 * 1024);
  if (!body.ok) return preparationJson({ error: "invalid_input" }, 400);
  if (action === "upload-policy") {
    const input = decodeExperiencePreparationUploadPolicyInput(body.value);
    if (!input) return preparationJson({ error: "invalid_input" }, 400);
    const result = await loaded.client.createUploadPolicy(caseId, input);
    return result.ok ? preparationJson(result.data, 201) : preparationFailureJson(result, "admin");
  }
  const input = decodeExperiencePreparationLockedAcceptance(body.value);
  if (!input) return preparationJson({ error: "invalid_input" }, 400);
  const current = await loaded.client.getCase(caseId);
  if (!current.ok) return preparationFailureJson(current, "admin");
  const adminCase = current.data.case;
  const acceptance = adminCase.currentAcceptance;
  if (
    !acceptance ||
    acceptance.revokedAt !== null ||
    adminCase.revision !== input.expectedRevision ||
    adminCase.snapshotHash !== input.snapshotHash ||
    acceptance.revision !== input.expectedRevision ||
    acceptance.snapshotHash !== input.snapshotHash ||
    acceptance.acceptedBy.userId !== input.acceptedByUserId
  ) return preparationJson({ error: "acceptance_changed" }, 409);
  const result = action === "verify-representative" ? await loaded.client.verifyRepresentative(caseId, input) : await loaded.client.materialize(caseId, input);
  return result.ok ? preparationJson(result.data) : preparationFailureJson(result, "admin");
}
