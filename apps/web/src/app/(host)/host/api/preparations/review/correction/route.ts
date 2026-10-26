import { isExperiencePreparationCorrection } from "@niho-experience/api-client/experience-preparations-schema";
import { isPreparationHttpEnabled, preparationFailureJson, preparationJson, preparationMutationAllowed, preparationReviewClient, readBoundedJson, readPreparationReviewGrant } from "@/lib/preparations/server";

export async function POST(request: Request) {
  if (!isPreparationHttpEnabled()) return preparationJson({ error: "not_found" }, 404);
  if (!preparationMutationAllowed(request)) return preparationJson({ error: "forbidden" }, 403);
  const grant = await readPreparationReviewGrant();
  if (!grant) return preparationJson({ error: "review_expired" }, 401);
  const body = await readBoundedJson(request, 8 * 1024);
  if (!body.ok || typeof body.value !== "object" || body.value === null || Array.isArray(body.value) || Object.keys(body.value).length !== 1) return preparationJson({ error: "invalid_input" }, 400);
  const message = (body.value as { message?: unknown }).message;
  if (!isExperiencePreparationCorrection(message)) return preparationJson({ error: "invalid_input" }, 400);
  const result = await preparationReviewClient().requestCorrection(grant.token, message);
  return result.ok ? preparationJson(result.data, 201) : preparationFailureJson(result, "review");
}
