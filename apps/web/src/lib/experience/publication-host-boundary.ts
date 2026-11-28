import "server-only";
import type { HostActor, ExperienceHostSellerProfile, ProviderPublicationReadinessInput } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { clearSessionCookie, noStoreJson, readHostSession, selectedHostApiClient } from "@/lib/host/server";
import { accessTokenUsable, type ExperienceHostSession } from "@/lib/host/session";
import { payoutConsentCurrent, readHostPayoutAccount } from "@/lib/experience/host-payout-account";
import { experiencePublicationRepository } from "@/lib/experience/store-server";
import { resolveProviderContext, type ProviderRole } from "@/lib/experience/provider-context";

type Operation = "READ" | "EDIT" | "OWNER";
const error = (code: string, status: number) => noStoreJson({ error: { code } }, status);
/** How long a readiness snapshot stands (the store allows ten minutes at most). */
const READINESS_VALIDITY_MS = 5 * 60 * 1000;

/**
 * Which roles each operation needs. Today every host experience API needs the OWNER (#703 changes no permission); the
 * store checks the role again. The table is the one place a later stage widens an operation to EDITOR or COHOST.
 */
const OPERATION_ROLES: Readonly<Record<Operation, readonly ProviderRole[]>> = {
  READ: ["OWNER"],
  EDIT: ["OWNER"],
  OWNER: ["OWNER"],
};

/**
 * What an operation needs beyond membership (docs/host-publication.md):
 * - `none`: the provider and role only. No seller, no Stripe, no readiness snapshot.
 * - `seller`: also the provider's registered seller (SELLER_SETUP_REQUIRED without one). No Stripe.
 * - `optional`: the `readiness` side when the provider has a seller profile (today's behaviour, Stripe included), and
 *   none of it when it has no seller profile yet (`provider: null, readiness: null`, no Stripe, no snapshot write, no
 *   SELLER_SETUP_REQUIRED). Drafting does not need a seller (#704); the product has none until one is registered.
 * - `readiness`: also 受取口座 from Stripe and the payment consent, as a fresh readiness snapshot (the SalesContext).
 */
export type SalesNeed = "none" | "optional" | "seller" | "readiness";

type SellerProfile = ExperienceHostSellerProfile;
type Readiness = ProviderPublicationReadinessInput;

/** Provider and role: what every operation gets. */
export interface HostBoundaryBase {
  readonly actor: HostActor;
  readonly role: ProviderRole;
}

/** The sale side of a provider: its seller and the current snapshot of 受取口座 and consent. */
export interface SalesContext {
  readonly provider: SellerProfile;
  readonly readiness: Readiness;
}

export type PublicationHostContext<N extends SalesNeed = "readiness"> = HostBoundaryBase
  & (N extends "readiness" ? SalesContext
    : N extends "seller" ? { readonly provider: SellerProfile; readonly readiness: Readiness | null }
      : { readonly provider: SellerProfile | null; readonly readiness: Readiness | null });
// `optional` has the same shape as `none`: a context whose sale side may be absent.

export type PublicationHostBoundaryResult<N extends SalesNeed = "readiness"> =
  | { readonly ok: true; readonly value: PublicationHostContext<N> }
  | { readonly ok: false; readonly response: Response };

export interface PublicationHostBoundaryOptions {
  /** The `?providerId=` hint of the request. Checked against the account's memberships, never trusted. */
  readonly providerId?: string | null;
}

function endedSession(): Response {
  const response = error("SESSION_ENDED", 401);
  clearSessionCookie(response);
  return response;
}

type Repository = NonNullable<ReturnType<typeof experiencePublicationRepository>>;

/**
 * An Experience host account (ADR 0003 slice 3): the person is the session's host account and NIHO is never called. The
 * provider is resolved first, membership only (resolveProviderContext). Only an operation that needs the sale goes on:
 * its seller is the one registered for host accounts, the payout account's readiness comes from Stripe directly and the
 * payment consent from the OWNER's Experience consent at the configured version. The snapshot stands five minutes, as on
 * the NIHO path. A Stripe or consent read that fails answers READINESS_UNAVAILABLE and first records a closed snapshot
 * (Connect not ready, no consent), so an earlier success is never used again, not even by an Admin proxy publication;
 * an account Stripe does not show to the platform is CONNECT_NOT_READY at publication.
 */
async function experienceAccountBoundary(
  session: ExperienceHostSession,
  repository: Pick<Repository, "refreshReadiness" | "currentHostAccountSellerProfile" | "providerHasSellerProfile">,
  operation: Operation,
  sales: SalesNeed,
  requestedProviderId: string | null,
): Promise<PublicationHostBoundaryResult<"none">> {
  const resolved = await resolveProviderContext(session, requestedProviderId, OPERATION_ROLES[operation]);
  if (!resolved.ok) return resolved;
  const { actor, role } = resolved.value;
  if (sales === "none") return { ok: true, value: { actor, role, provider: null, readiness: null } };
  if (sales === "optional") {
    // No seller profile yet: a draft can be made and edited, and nothing about payouts is read or written.
    let hasSeller: boolean;
    try { hasSeller = await repository.providerHasSellerProfile(actor.providerId); }
    catch { return { ok: false, response: error("READINESS_UNAVAILABLE", 502) }; }
    if (!hasSeller) return { ok: true, value: { actor, role, provider: null, readiness: null } };
  }

  if (sales === "seller") {
    let found: Awaited<ReturnType<typeof repository.currentHostAccountSellerProfile>>;
    try { found = await repository.currentHostAccountSellerProfile(session.hostAccountId, actor.providerId); }
    catch { return { ok: false, response: error("READINESS_UNAVAILABLE", 502) }; }
    if (found.kind === "none") return { ok: false, response: error("FORBIDDEN", 403) };
    if (found.kind === "ambiguous") return { ok: false, response: error("SELLER_PROFILE_AMBIGUOUS", 409) };
    if (found.kind === "setup-required") return { ok: false, response: error("SELLER_SETUP_REQUIRED", 409) };
    return { ok: true, value: { actor, role, provider: found.profile, readiness: null } };
  }

  const read = await readHostPayoutAccount(session.hostAccountId, undefined, actor.providerId);
  if (read.kind === "none") return { ok: false, response: error("FORBIDDEN", 403) };
  if (read.kind === "ambiguous") return { ok: false, response: error("SELLER_PROFILE_AMBIGUOUS", 409) };
  if (read.kind === "setup-required") return { ok: false, response: error("SELLER_SETUP_REQUIRED", 409) };
  if (read.kind === "unavailable") return { ok: false, response: error("READINESS_UNAVAILABLE", 502) };
  const { profile } = read;
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
    try { await repository.refreshReadiness(read.actor, closed); } catch { /* The request fails closed either way. */ }
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
  return { ok: true, value: { actor: read.actor, role, provider: profile, readiness } };
}

/**
 * Establish the current person from NIHO v1, then resolve Experience membership and the
 * operator-provisioned Connect mapping locally. Neither identity nor seller selection is
 * inferred from a legacy NIHO provider directory or its nihoUserId field. With Experience
 * host accounts the person comes from their session instead (experienceAccountBoundary).
 */
export function publicationHostBoundary(operation: Operation, options?: PublicationHostBoundaryOptions & { readonly sales?: "readiness" }): Promise<PublicationHostBoundaryResult<"readiness">>;
export function publicationHostBoundary(operation: Operation, options: PublicationHostBoundaryOptions & { readonly sales: "seller" }): Promise<PublicationHostBoundaryResult<"seller">>;
export function publicationHostBoundary(operation: Operation, options: PublicationHostBoundaryOptions & { readonly sales: "none" | "optional" }): Promise<PublicationHostBoundaryResult<"none">>;
export async function publicationHostBoundary(
  operation: Operation,
  options: PublicationHostBoundaryOptions & { readonly sales?: SalesNeed } = {},
): Promise<PublicationHostBoundaryResult<"none">> {
  const sales: SalesNeed = options.sales ?? "readiness";
  const requestedProviderId = options.providerId ?? null;
  if (!config.experienceHostPublicationApiEnabled) return { ok: false, response: error("NOT_FOUND", 404) };
  let session: Awaited<ReturnType<typeof readHostSession>>;
  try { session = await readHostSession(); }
  catch { return { ok: false, response: error("READINESS_UNAVAILABLE", 502) }; }
  if (!session) return { ok: false, response: endedSession() };
  if (!accessTokenUsable(session, Date.now())) return { ok: false, response: error("SESSION_REFRESH_REQUIRED", 401) };

  const repository = experiencePublicationRepository();
  if (!repository) return { ok: false, response: error("READINESS_UNAVAILABLE", 502) };
  if (session.kind === "experience") return experienceAccountBoundary(session, repository, operation, sales, requestedProviderId);

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
    // The hint names this one provider or none (the NIHO person is the OWNER of exactly this seller).
    if (requestedProviderId !== null && requestedProviderId !== provider.providerId && requestedProviderId !== provider.legacyProviderId) {
      return { ok: false, response: error("FORBIDDEN", 403) };
    }

    // The explicit NIHO account reference must agree with the authenticated person. A mapping
    // created for a different seller is never repaired by substituting another ID.
    if (provider.sellerNihoAccountRef !== identity.data.nihoUserId) {
      return { ok: false, response: error("SELLER_IDENTITY_MISMATCH", 403) };
    }

    const actor: HostActor = { providerId: provider.providerId, nihoUserId: identity.data.nihoUserId };
    // An operation that needs no sale (the host bio, #709) is membership only, as on the Experience account path: no
    // payout account lookup at NIHO, so an unreachable or unready account never blocks it.
    if (sales === "none") return { ok: true, value: { actor, role: "OWNER", provider: null, readiness: null } };

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
    // Every other operation on the NIHO path resolves the whole sale side (behaviour unchanged).
    return { ok: true, value: { actor, role: "OWNER", provider, readiness } };
  } catch {
    return { ok: false, response: error("READINESS_UNAVAILABLE", 502) };
  }
}

export function publicationHostMutationAllowed(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  const expected = new URL(config.siteUrl).origin;
  return request.headers.get("origin") === expected && request.headers.get("sec-fetch-site") === "same-origin";
}
