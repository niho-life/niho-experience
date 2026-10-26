import { isExperiencePreparationCorrection, isExperiencePreparationPathId } from "@niho-experience/api-client/experience-preparations-schema";
import type { ExperiencePreparationAcceptanceInput, ExperiencePreparationReview } from "@niho-experience/api-client/experience-preparations";
import { isPreparationHttpEnabled, loadPreparationHostClient, preparationFailureJson, preparationJson, preparationMutationAllowed, preparationReviewClient, readBoundedJson, readPreparationReviewGrant } from "@/lib/preparations/server";

type Context = { params: Promise<{ caseId: string; action: string }> };

export async function GET(request: Request, context: Context) {
  const { caseId, action } = await context.params;
  if (!isPreparationHttpEnabled() || action !== "readiness" || new URL(request.url).search || !isExperiencePreparationPathId(caseId)) return preparationJson({ error: "not_found" }, 404);
  const loaded = await loadPreparationHostClient();
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.readiness(caseId);
  return result.ok ? preparationJson(result.data) : preparationFailureJson(result, "host");
}

function sameTarget(left: unknown, right: ExperiencePreparationReview["proposal"]["target"]): boolean {
  if (typeof left !== "object" || left === null || Array.isArray(left) || Object.keys(left).length !== 2) return false;
  const value = left as Record<string, unknown>;
  return value.mode === right.mode && value.providerId === right.providerId;
}

function acceptanceFromReview(review: ExperiencePreparationReview, value: Record<string, unknown>, token: string): ExperiencePreparationAcceptanceInput | "stale" | null {
  const checks = ["contentAccepted", "salesTermsAccepted", "supportAuthorized", "representativeDeclared", "listingAuthorized", "providerConsentAccepted"];
  const proof = ["caseVersion", "snapshotHash", "agreementVersion", "providerConsentVersion", "listingConsentVersion", "target"];
  const allowed = [...checks, ...proof];
  if (Object.keys(value).length !== allowed.length || !Object.keys(value).every((key) => allowed.includes(key)) || checks.slice(0, 5).some((key) => value[key] !== true)) return null;
  if (review.consents.provider.required ? value.providerConsentAccepted !== true : value.providerConsentAccepted !== false) return null;
  const displayedProviderVersion = review.consents.provider.required ? review.consents.provider.version : null;
  if (
    value.caseVersion !== review.revision ||
    value.snapshotHash !== review.snapshotHash ||
    value.agreementVersion !== review.consents.preparation.version ||
    value.providerConsentVersion !== displayedProviderVersion ||
    value.listingConsentVersion !== review.consents.listing.version ||
    !sameTarget(value.target, review.proposal.target)
  ) return "stale";
  return {
    reviewToken: token,
    caseVersion: review.revision,
    snapshotHash: review.snapshotHash,
    agreementVersion: review.consents.preparation.version,
    providerConsent: review.consents.provider.required ? { version: review.consents.provider.version, accepted: true } : null,
    listingConsentVersion: review.consents.listing.version,
    target: review.proposal.target,
    contentAccepted: true,
    salesTermsAccepted: true,
    supportAuthorized: true,
    representativeDeclared: true,
    listingAuthorized: true,
  };
}

export async function POST(request: Request, context: Context) {
  const { caseId, action } = await context.params;
  if (!isPreparationHttpEnabled() || !["accept", "correction", "revoke-acceptance"].includes(action) || !isExperiencePreparationPathId(caseId)) return preparationJson({ error: "not_found" }, 404);
  if (!preparationMutationAllowed(request)) return preparationJson({ error: "forbidden" }, 403);
  const loaded = await loadPreparationHostClient();
  if (!loaded.ok) return loaded.response;
  if (action === "revoke-acceptance") {
    const raw = await request.text().catch(() => null);
    if (new URL(request.url).search || raw === null || raw.length > 0) return preparationJson({ error: "invalid_input" }, 400);
    const result = await loaded.client.revokeAcceptance(caseId);
    return result.ok ? preparationJson(result.data) : preparationFailureJson(result, "host");
  }
  const body = await readBoundedJson(request, 8 * 1024);
  if (!body.ok || typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) return preparationJson({ error: "invalid_input" }, 400);
  const value = body.value as Record<string, unknown>;
  if (action === "correction") {
    if (Object.keys(value).length !== 1 || !isExperiencePreparationCorrection(value.message)) return preparationJson({ error: "invalid_input" }, 400);
    const result = await loaded.client.requestCorrection(caseId, value.message);
    return result.ok ? preparationJson(result.data, 201) : preparationFailureJson(result, "host");
  }
  const grant = await readPreparationReviewGrant();
  if (!grant || grant.caseId !== caseId) return preparationJson({ error: "review_expired" }, 401);
  const reviewed = await preparationReviewClient().review(grant.token);
  if (!reviewed.ok) return preparationFailureJson(reviewed, "review");
  if (reviewed.data.caseId !== caseId) return preparationJson({ error: "forbidden" }, 403);
  const acceptance = acceptanceFromReview(reviewed.data, value, grant.token);
  if (acceptance === "stale") return preparationJson({ error: "review_changed" }, 409);
  if (!acceptance) return preparationJson({ error: "invalid_input" }, 400);
  const result = await loaded.client.accept(caseId, acceptance);
  return result.ok ? preparationJson(result.data) : preparationFailureJson(result, "host");
}
