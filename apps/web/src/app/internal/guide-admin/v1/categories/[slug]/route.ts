import { StoreValidationError } from "@niho-experience/experience-store";
import {
  exactObject,
  guideAdminCategorySlug,
  guideAdminCommandHeaders,
  guideAdminJson,
  guideAdminRouteFailure,
  loadGuideAdmin,
  readGuideAdminMutation,
} from "@/lib/guide-admin/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ slug: string }> };

export async function PUT(request: Request, context: Context): Promise<Response> {
  const loaded = await loadGuideAdmin(request);
  if (!loaded.ok) return loaded.response;
  try {
    const slug = guideAdminCategorySlug((await context.params).slug);
    const command = guideAdminCommandHeaders(request);
    const body = exactObject(await readGuideAdminMutation(request), ["labelEn", "labelJa", "displayOrder", "active", "expectedRevision"]);
    if (
      typeof body.labelEn !== "string"
      || typeof body.labelJa !== "string"
      || typeof body.displayOrder !== "number"
      || typeof body.active !== "boolean"
      || typeof body.expectedRevision !== "number"
    ) {
      throw new StoreValidationError("Category fields have invalid types.");
    }
    const result = await loaded.repository.putCategory(command, slug, {
      labelEn: body.labelEn,
      labelJa: body.labelJa,
      displayOrder: body.displayOrder,
      active: body.active,
      expectedRevision: body.expectedRevision,
    });
    if (result.status === "CONFLICT") {
      return guideAdminJson({
        error: "conflict",
        reason: result.reason === "EXPECTED_REVISION" ? "expected_revision" : "idempotency_key_reused",
      }, 409);
    }
    return guideAdminJson({ category: result.category });
  } catch (error) {
    return guideAdminRouteFailure(error);
  }
}
