import "server-only";
import type { HostActor, ExperienceHostSellerProfile, ProviderPublicationReadinessInput } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { clearSessionCookie, noStoreJson, readHostSession, selectedHostApiClient } from "@/lib/host/server";
import { accessTokenUsable, type ExperienceHostSession } from "@/lib/host/session";
import { payoutConsentCurrent, readHostPayoutAccount } from "@/lib/experience/host-payout-account";
import { experiencePublicationRepository } from "@/lib/experience/store-server";

type Operation = "READ" | "EDIT" | "OWNER";
const error = (code: string, status: number) => noStoreJson({ error: { code } }, status);
/** How long a readiness snapshot stands (the store allows ten minutes at most). */
const READINESS_VALIDITY_MS = 5 * 60 * 1000;

export interface PublicationHostContext {
  readonly actor: HostActor;
  readonly provider: ExperienceHostSellerProfile;
  readonly readiness: ProviderPublicationReadinessInput;
}

export type PublicationHostBoundaryResult =
  | { readonly ok: true; readonly value: PublicationHostContext }
  | { readonly ok: false; readonly response: Response };

function endedSession(): Response {
  const response = error("SESSION_ENDED", 401);
  clearSessionCookie(response);
  return response;
}

type Repository = NonNullable<ReturnType<typeof experiencePublicationRepository>>;

/**
 * An Experience host account (ADR 0003 slice 3): the person is the session's host account and NIHO is never called. The
 * seller is the one provider the account is the active OWNER of, with its seller registered for host accounts; the
 * payout account's readiness comes from Stripe directly and the payment consent from the OWNER's Experience consent at
 * the configured version. The snapshot stands five minutes, as on the NIHO path. A Stripe or consent read that fails
 * answers READINESS_UNAVAILABLE and first records a closed snapshot (Connect not ready, no consent), so an earlier
 * success is never used again, not even by an Admin proxy publication; an account Stripe does not show to the platform
 * is CONNECT_NOT_READY at publication.
 */
async function experienceAccountBoundary(session: ExperienceHostSession, repository: Pick<Repository, "refreshReadiness">): Promise<PublicationHostBoundaryResult> {
  const read = await readHostPayoutAccount(session.hostAccountId);
  if (read.kind === "none") return { ok: false, response: error("FORBIDDEN", 403) };
  if (read.kind === "ambiguous") return { ok: false, response: error("SELLER_PROFILE_AMBIGUOUS", 409) };
  if (read.kind === "setup-required") return { ok: false, response: error("SELLER_SETUP_REQUIRED", 409) };
  if (read.kind === "unavailable") return { ok: false, response: error("READINESS_UNAVAILABLE", 502) };
  const { actor, profile } = read;
  const now = Date.now();
  const closed: ProviderPublicationReadinessInput = {
    accountUsable: read.hostAccountActive,
    connectReady: false,
    paymentReuseConsentAccepted: false,
    paymentReuseConsentVersion: null,
    paymentReuseConsentedAtUtc: null,
    sellerDisplayReady: profile.sellerDisplayName.trim().length > 0,
    sellerNihoAccountRef: profile.sellerNihoAccountRef,
    stripeConnectAccountRef: profile.stripeConnectAccountRef,
    sellerDisplayName: profile.sellerDisplayName.trim(),
    requiredConsentVersion: config.experiencePublicationConsentVersion,
    observedAtUtc: new Date(now).toISOString(),
    validUntilUtc: new Date(now + READINESS_VALIDITY_MS).toISOString(),
  };
  if (read.kind === "stripe-unavailable") {
    try { await repository.refreshReadiness(actor, closed); } catch { /* The request fails closed either way. */ }
    return { ok: false, response: error("READINESS_UNAVAILABLE", 502) };
  }
  const consent = payoutConsentCurrent(read.consent, profile, config.experiencePayoutAccountConsentVersion) ? read.consent : null;
  const readiness: ProviderPublicationReadinessInput = {
    ...closed,
    connectReady: read.stripe.kind === "ready",
    paymentReuseConsentAccepted: consent !== null,
    paymentReuseConsentVersion: consent?.consentVersion ?? null,
    paymentReuseConsentedAtUtc: consent?.consentedAtUtc ?? null,
  };
  return { ok: true, value: { actor, provider: profile, readiness } };
}

/**
 * Establish the current person from NIHO v1, then resolve Experience membership and the
 * operator-provisioned Connect mapping locally. Neither identity nor seller selection is
 * inferred from a legacy NIHO provider directory or its nihoUserId field. With Experience
 * host accounts the person comes from their session instead (experienceAccountBoundary).
 */
export async function publicationHostBoundary(_operation: Operation): Promise<PublicationHostBoundaryResult> {
  if (!config.experienceHostPublicationApiEnabled) return { ok: false, response: error("NOT_FOUND", 404) };
  let session: Awaited<ReturnType<typeof readHostSession>>;
  try { session = await readHostSession(); }
  catch { return { ok: false, response: error("READINESS_UNAVAILABLE", 502) }; }
  if (!session) return { ok: false, response: endedSession() };
  if (!accessTokenUsable(session, Date.now())) return { ok: false, response: error("SESSION_REFRESH_REQUIRED", 401) };

  const repository = experiencePublicationRepository();
  if (!repository) return { ok: false, response: error("READINESS_UNAVAILABLE", 502) };
  if (session.kind === "experience") return experienceAccountBoundary(session, repository);

  try {
    const client = await selectedHostApiClient(session);
    const identity = await client.getIdentity();
    if (!identity.ok) {
      if (identity.kind === "error" && identity.status === 401) return { ok: false, response: endedSession() };
      if (identity.kind === "error" && identity.status === 403) return { ok: false, response: error("FORBIDDEN", 403) };
      return { ok: false, response: error("READINESS_UNAVAILABLE", 502) };
    }

    let resolved: Awaited<ReturnType<typeof repository.currentOwnerSellerProfile>>;
    try { resolved = await repository.currentOwnerSellerProfile(identity.data.nihoUserId); }
    catch { return { ok: false, response: error("READINESS_UNAVAILABLE", 502) }; }
    if (resolved.kind === "none") {
      // A pre-provisioned profile is bound to the seller's exact NIHO identity. This first login
      // grants only that local Experience OWNER membership; it does not infer NIHO roles or IDs.
      try {
        const linked = await repository.ensureMappedOwnerMembership(identity.data.nihoUserId);
        if (linked.kind === "no-mapping") return { ok: false, response: error("FORBIDDEN", 403) };
        if (linked.kind === "ambiguous") return { ok: false, response: error("SELLER_PROFILE_AMBIGUOUS", 409) };
        if (linked.kind === "membership-conflict") return { ok: false, response: error("FORBIDDEN", 403) };
        resolved = await repository.currentOwnerSellerProfile(identity.data.nihoUserId);
      } catch { return { ok: false, response: error("READINESS_UNAVAILABLE", 502) }; }
    }
    if (resolved.kind === "none") return { ok: false, response: error("FORBIDDEN", 403) };
    if (resolved.kind === "ambiguous") return { ok: false, response: error("SELLER_PROFILE_AMBIGUOUS", 409) };
    if (resolved.kind === "setup-required") return { ok: false, response: error("SELLER_SETUP_REQUIRED", 409) };
    const provider = resolved.profile;

    // The explicit NIHO account reference must agree with the authenticated person. A mapping
    // created for a different seller is never repaired by substituting another ID.
    if (provider.sellerNihoAccountRef !== identity.data.nihoUserId) {
      return { ok: false, response: error("SELLER_IDENTITY_MISMATCH", 403) };
    }

    const connect = await client.getLegacyConnectAccount(provider.legacyProviderId);
    if (!connect.ok) {
      if (connect.kind === "error" && connect.status === 401) return { ok: false, response: endedSession() };
      if (connect.kind === "error" && (connect.status === 403 || connect.status === 404)) return { ok: false, response: error("FORBIDDEN", 403) };
      return { ok: false, response: error("READINESS_UNAVAILABLE", 502) };
    }

    const consent = connect.data.paymentReuseConsent;
    const sameAccount = connect.data.stripeAccountId === provider.stripeConnectAccountRef;
    const consentedAtUtc = consent.consentedAt === null ? null : new Date(consent.consentedAt).toISOString();
    const readiness: ProviderPublicationReadinessInput = {
      accountUsable: identity.data.accountStatus === "ACTIVE",
      connectReady: sameAccount && connect.data.readiness.ready,
      paymentReuseConsentAccepted: consent.accepted,
      paymentReuseConsentVersion: consent.version,
      paymentReuseConsentedAtUtc: consentedAtUtc,
      sellerDisplayReady: provider.sellerDisplayName.trim().length > 0,
      sellerNihoAccountRef: provider.sellerNihoAccountRef,
      // Keep the configured account in the failed-closed snapshot when NIHO's current projection
      // is absent or differs, so a prior successful result cannot remain available for five minutes.
      stripeConnectAccountRef: provider.stripeConnectAccountRef,
      sellerDisplayName: provider.sellerDisplayName.trim(),
      requiredConsentVersion: config.experiencePublicationConsentVersion,
      observedAtUtc: new Date().toISOString(),
      validUntilUtc: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };
    const actor: HostActor = { providerId: provider.providerId, nihoUserId: identity.data.nihoUserId };
    return { ok: true, value: { actor, provider, readiness } };
  } catch {
    return { ok: false, response: error("READINESS_UNAVAILABLE", 502) };
  }
}

export function publicationHostMutationAllowed(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  const expected = new URL(config.siteUrl).origin;
  return request.headers.get("origin") === expected && request.headers.get("sec-fetch-site") === "same-origin";
}
