import { isExperiencePreparationSchema } from "@niho-experience/api-client/experience-preparations-schema";
import type { NextResponse } from "next/server";
import { clearPreparationReviewGrant, isPreparationHttpEnabled, preparationFailureJson, preparationJson, preparationMutationAllowed, preparationReviewClient, readBoundedJson, readPreparationReviewGrant, setPreparationReviewGrant } from "@/lib/preparations/server";

function cleared(response: NextResponse): NextResponse {
  clearPreparationReviewGrant(response);
  return response;
}

export async function POST(request: Request) {
  if (!isPreparationHttpEnabled()) return preparationJson({ error: "not_found" }, 404);
  if (!preparationMutationAllowed(request)) return preparationJson({ error: "forbidden" }, 403);
  const body = await readBoundedJson(request, 1024);
  if (!body.ok || typeof body.value !== "object" || body.value === null || Array.isArray(body.value) || Object.keys(body.value).length !== 1 || !isExperiencePreparationSchema<{ token: string }>("ReviewToken", (body.value as { token?: unknown }).token)) return cleared(preparationJson({ error: "invalid_input" }, 400));
  const token = (body.value as { token: string }).token;
  const result = await preparationReviewClient().review(token);
  if (!result.ok) return cleared(preparationFailureJson(result, "review"));
  const expiresAt = Date.parse(result.data.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return cleared(preparationJson({ error: "not_found" }, 404));
  const response = preparationJson(result.data);
  setPreparationReviewGrant(response, { token, caseId: result.data.caseId, expiresAt });
  return response;
}

export async function GET(request: Request) {
  if (!isPreparationHttpEnabled() || new URL(request.url).search) return preparationJson({ error: "not_found" }, 404);
  const grant = await readPreparationReviewGrant();
  if (!grant) return preparationJson({ error: "review_expired" }, 401);
  const result = await preparationReviewClient().review(grant.token);
  if (!result.ok) {
    const response = preparationFailureJson(result, "review");
    return result.kind === "not_found" || result.kind === "rejected" ? cleared(response) : response;
  }
  if (result.data.caseId !== grant.caseId) return cleared(preparationJson({ error: "unavailable" }, 503));
  return preparationJson(result.data);
}
