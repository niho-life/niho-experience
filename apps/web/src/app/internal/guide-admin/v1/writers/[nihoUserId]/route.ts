import { StoreValidationError } from "@niho-experience/experience-store";
import {
  exactObject,
  guideAdminCommandHeaders,
  guideAdminJson,
  guideAdminRouteFailure,
  guideAdminTargetId,
  loadGuideAdmin,
  readGuideAdminMutation,
} from "@/lib/guide-admin/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ nihoUserId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const loaded = await loadGuideAdmin(request);
  if (!loaded.ok) return loaded.response;
  try {
    const nihoUserId = guideAdminTargetId((await context.params).nihoUserId);
    return guideAdminJson({ writer: await loaded.repository.getWriterGrant(nihoUserId) });
  } catch (error) {
    return guideAdminRouteFailure(error);
  }
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  const loaded = await loadGuideAdmin(request);
  if (!loaded.ok) return loaded.response;
  try {
    const nihoUserId = guideAdminTargetId((await context.params).nihoUserId);
    const command = guideAdminCommandHeaders(request);
    const body = exactObject(await readGuideAdminMutation(request), ["active", "sourceVersion", "sourceInvitationId"]);
    if (typeof body.active !== "boolean" || typeof body.sourceVersion !== "number" || typeof body.sourceInvitationId !== "string") {
      throw new StoreValidationError("Writer grant fields have invalid types.");
    }
    const result = await loaded.repository.putWriterGrant(command, nihoUserId, {
      active: body.active,
      sourceVersion: body.sourceVersion,
      sourceInvitationId: body.sourceInvitationId,
    });
    if (result.status === "CONFLICT") {
      return guideAdminJson({
        error: "conflict",
        reason: result.reason === "SOURCE_VERSION" ? "source_version" : "idempotency_key_reused",
      }, 409);
    }
    return guideAdminJson({ writer: result.writer });
  } catch (error) {
    return guideAdminRouteFailure(error);
  }
}
