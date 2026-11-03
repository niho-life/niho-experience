import "server-only";
import {
  ExperiencePublicationBlockedError, ExperiencePublicationRepository,
  StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError,
  projectPublicExperiencePublicationManuscript,
  type ExperiencePublicationDraftInput, type ExperiencePublicationState, type ProductRecord,
} from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { nihoIdOrNull } from "@/lib/host/providers";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { readProviderOperationsJson } from "@/lib/host/provider-operations-server";
import { loadHostProviders, noStoreJson, readHostSession, siteOrigin } from "@/lib/host/server";
import { accessTokenUsable } from "@/lib/host/session";
import { experiencePool, experienceStore } from "./store-server";

export type PublicationContext = { params: Promise<{ providerId: string; productId: string }> };
type Action = "read" | "save" | "publish" | "stop" | "preview";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: RecordValue, allowed: readonly string[]) => Object.keys(value).length === allowed.length && allowed.every((key) => Object.hasOwn(value, key));
const version = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** Only an approved server deployment may select the current legal consent text. */
function consentVersion(): string | null {
  const value = process.env.EXPERIENCE_PUBLICATION_CONSENT_VERSION;
  return value && /^[A-Za-z0-9._-]{1,160}$/.test(value) ? value : null;
}

/**
 * The pinned NIHO host DTO does not attest account usability or the product's
 * legal seller/account association. Its old provider review and Connect `ready`
 * flags cannot stand in for that contract. Never reuse stored readiness here.
 */
function readinessBlockers(): readonly string[] {
  return ["READINESS_CONTRACT_UNAVAILABLE", "PUBLIC_MEDIA_CONTRACT_UNAVAILABLE", ...(consentVersion() ? [] : ["CONSENT_CONTRACT_UNAVAILABLE"])];
}

function draftDto(draft: ProductRecord) {
  return {
    slug: draft.slug, publicTitle: draft.publicTitle, content: draft.content,
    currency: draft.currency, unitAmount: draft.unitAmount,
    cancellationTermsRef: draft.cancellationTermsRef, version: draft.version,
    updatedAtUtc: draft.updatedAtUtc,
  };
}

function stateDto(state: ExperiencePublicationState | null) {
  return state === null ? null : {
    hasPublication: state.currentPublicationId !== null,
    selfStoppedAtUtc: state.selfStoppedAtUtc,
    operationsSuspended: state.operationsSuspendedAtUtc !== null,
    ownerResumeRequired: state.ownerResumeRequired,
    firstPublishedAtUtc: state.firstPublishedAtUtc,
    version: state.version, updatedAtUtc: state.updatedAtUtc,
  };
}

function failure(error: unknown): Response {
  if (error instanceof StoreAccessDeniedError) return noStoreJson({ error: "forbidden" }, 403);
  if (error instanceof StoreNotFoundError) return noStoreJson({ error: "not_found" }, 404);
  if (error instanceof StoreConflictError) return noStoreJson({ error: "conflict" }, 409);
  if (error instanceof ExperiencePublicationBlockedError) return noStoreJson({ error: "publication_blocked", blockers: error.blockers }, 409);
  if (error instanceof StoreValidationError) return noStoreJson({ error: "invalid_input" }, 400);
  return noStoreJson({ error: "publication_unavailable" }, 503);
}

/** Experience-owned BFF; distinct from the still-deployed legacy NIHO page routes. */
export async function publicationRequest(request: Request, context: PublicationContext, action: Action): Promise<Response> {
  if (!config.hostConsoleEnabled || config.apiMode !== "http" || process.env.EXPERIENCE_HOST_PUBLICATION_API_ENABLED !== "true") {
    return noStoreJson({ error: "not_found" }, 404);
  }
  const { providerId, productId } = await context.params;
  if (!nihoIdOrNull(providerId) || !nihoIdOrNull(productId) || new URL(request.url).search) return noStoreJson({ error: "invalid_input" }, 400);
  if (!mutationFromSameOrigin(request.method, request.headers, siteOrigin())
      || (request.headers.has("origin") && request.headers.get("origin") !== siteOrigin())
      || ["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "")) {
    return noStoreJson({ error: "forbidden" }, 403);
  }
  try {
    const session = await readHostSession();
    if (!session) return noStoreJson({ error: "unauthenticated" }, 401);
    if (!accessTokenUsable(session, Date.now())) return noStoreJson({ error: "session_refresh_required" }, 401);
    const providers = await loadHostProviders();
    if (["rejected", "refresh", "signed-out"].includes(providers.status)) return noStoreJson({ error: "unauthenticated" }, 401);
    if (providers.status !== "ok") return noStoreJson({ error: "identity_unavailable" }, 503);
    const provider = providers.providers.find((entry) => entry.id === providerId);
    // The sole owner-ID fallback is valid for this exact, fresh OWNER provider.
    // Non-owners cannot borrow this ID, even if the DB still has an OWNER row.
    if (!provider || provider.memberRole !== "OWNER") return noStoreJson({ error: "forbidden" }, 403);
    const nihoUserId = nihoIdOrNull(provider.ownerUserId);
    if (!nihoUserId) return noStoreJson({ error: "identity_unavailable" }, 503);
    const actor = { providerId, nihoUserId, calendarRoleCeiling: "OWNER" as const };
    const store = experienceStore();
    const pool = experiencePool();
    if (!store || !pool) return noStoreJson({ error: "publication_not_configured" }, 503);
    const membership = await store.verifyActiveMembership(actor);
    if (!membership?.active || membership.role !== "OWNER" || membership.providerId !== providerId || membership.nihoUserId !== nihoUserId) {
      return noStoreJson({ error: "forbidden" }, 403);
    }
    const repository = new ExperiencePublicationRepository(pool);
    if (action === "read" || action === "preview") {
      const draft = await store.getProduct(actor, productId);
      if (action === "preview") {
        const manuscript = projectPublicExperiencePublicationManuscript(draft.content);
        if (!manuscript) return noStoreJson({ error: "preview_unavailable" }, 409);
        return noStoreJson({ preview: { slug: draft.slug, publicTitle: draft.publicTitle, ...manuscript, currency: draft.currency, unitAmount: draft.unitAmount } });
      }
      const state = await repository.getState(actor, productId);
      return noStoreJson({ draft: draftDto(draft), publication: stateDto(state), requiredConsentVersion: consentVersion(), blockers: readinessBlockers() });
    }
    const parsed = await readProviderOperationsJson(request, 256 * 1024);
    if (!parsed.ok || !record(parsed.value)) return noStoreJson({ error: "invalid_input" }, 400);
    const body = parsed.value;
    if (action === "save") {
      const draft = body.draft;
      if (!keys(body, ["expectedVersion", "draft"]) || !version(body.expectedVersion) || !record(draft)
          || !keys(draft, ["slug", "publicTitle", "content", "currency", "unitAmount", "cancellationTermsRef"])
          || !["slug", "publicTitle", "currency", "cancellationTermsRef"].every((key) => typeof draft[key] === "string")
          || typeof draft.unitAmount !== "number" || !record(draft.content)) return noStoreJson({ error: "invalid_input" }, 400);
      const input = { ...draft, id: productId } as unknown as ExperiencePublicationDraftInput;
      // Media permission and reviewed translation have no accepted local validator
      // yet. Save the draft while retaining the immutable prior public version.
      const result = await repository.saveDraft(actor, input, body.expectedVersion, { manuscriptReady: false, photosReady: false });
      return noStoreJson({ draft: draftDto(result.draft), publicationUpdated: result.publicationUpdated, blockers: [...new Set([...result.blockers, ...readinessBlockers()])] });
    }
    if (action === "stop") {
      if (!keys(body, ["expectedStateVersion"]) || !version(body.expectedStateVersion)) return noStoreJson({ error: "invalid_input" }, 400);
      return noStoreJson({ publication: stateDto(await repository.stop(actor, productId, body.expectedStateVersion)) });
    }
    if (!keys(body, ["expectedDraftVersion", "expectedStateVersion", "consentAccepted"])
        || !version(body.expectedDraftVersion) || !(body.expectedStateVersion === null || version(body.expectedStateVersion))) {
      return noStoreJson({ error: "invalid_input" }, 400);
    }
    if (body.consentAccepted !== true) return noStoreJson({ error: "publication_blocked", blockers: ["CONSENT_REQUIRED"] }, 409);
    const draft = await store.getProduct(actor, productId);
    const state = await repository.getState(actor, productId);
    if (draft.version !== body.expectedDraftVersion || (state?.version ?? null) !== body.expectedStateVersion) return noStoreJson({ error: "conflict" }, 409);
    // Both first publication and republish stay closed until NIHO's limited
    // readiness contract can be fetched fresh and recorded server-side.
    return noStoreJson({ error: "publication_blocked", blockers: readinessBlockers() }, 409);
  } catch (error) { return failure(error); }
}
