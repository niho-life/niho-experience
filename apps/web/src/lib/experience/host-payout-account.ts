import "server-only";
import { retrieveConnectedAccount, type ConnectedAccountCheck } from "@niho-experience/experience-payments";
import type { HostAccountSellerProfile, HostActor, PayoutAccountConsent } from "@niho-experience/experience-store";
import { experiencePublicationRepository, payoutAccountConsents } from "./store-server";

/*
 * 受取口座 for an Experience host account (ADR 0003 slice 3), read the one way the publication boundary and the host
 * screens share: the provider the account is the OWNER of and its seller registered for host accounts (experience DB),
 * the payout account's state straight from Stripe with the platform key, and the OWNER's consent (experience DB). NIHO is
 * never called. Nothing is cached: every read asks Stripe again, so an earlier success is never reused.
 */

export type HostPayoutAccountRead =
  /** Not the active OWNER of any provider. */
  | { readonly kind: "none" }
  /** The OWNER of more than one provider. */
  | { readonly kind: "ambiguous" }
  /** The provider has no seller registered for host accounts yet (Admin/ops register it). */
  | { readonly kind: "setup-required"; readonly providerId: string }
  /** The experience DB, its consent store or the Stripe key is not there. */
  | { readonly kind: "unavailable" }
  /** The seller is known, but Stripe or the consent could not be read now. */
  | { readonly kind: "stripe-unavailable"; readonly actor: HostActor; readonly profile: HostAccountSellerProfile; readonly hostAccountActive: boolean }
  | {
    readonly kind: "read";
    readonly actor: HostActor;
    readonly profile: HostAccountSellerProfile;
    readonly hostAccountActive: boolean;
    /** Stripe's answer for the profile's own account (retrieveConnectedAccount refuses another account's answer). */
    readonly stripe: ConnectedAccountCheck;
    /** The consent that counts now (store rules), whatever its version. */
    readonly consent: PayoutAccountConsent | null;
  };

/** Injected in tests; the defaults are the real store and Stripe. */
export interface HostPayoutAccountDeps {
  readonly repository: Pick<NonNullable<ReturnType<typeof experiencePublicationRepository>>, "currentHostAccountSellerProfile"> | null;
  readonly consents: Pick<NonNullable<ReturnType<typeof payoutAccountConsents>>, "current"> | null;
  readonly platformStripeKey: string | undefined;
  readonly retrieve: typeof retrieveConnectedAccount;
}

function defaultDeps(): HostPayoutAccountDeps {
  return {
    repository: experiencePublicationRepository(),
    consents: payoutAccountConsents(),
    platformStripeKey: process.env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY?.trim() || undefined,
    retrieve: retrieveConnectedAccount,
  };
}

/** The payout account of the provider `hostAccountId` is the OWNER of. Throws only for a programming error. */
export async function readHostPayoutAccount(hostAccountId: string, deps: HostPayoutAccountDeps = defaultDeps()): Promise<HostPayoutAccountRead> {
  const { repository, consents, platformStripeKey } = deps;
  if (!repository || !consents || !platformStripeKey) return { kind: "unavailable" };
  let resolved: Awaited<ReturnType<typeof repository.currentHostAccountSellerProfile>>;
  try { resolved = await repository.currentHostAccountSellerProfile(hostAccountId); }
  catch { return { kind: "unavailable" }; }
  if (resolved.kind !== "ready") return resolved;
  const { profile, hostAccountActive } = resolved;
  const actor: HostActor = { providerId: profile.providerId, nihoUserId: hostAccountId };
  try {
    const [stripe, consent] = await Promise.all([
      deps.retrieve({ accountId: profile.stripeConnectAccountRef, platformStripeKey }),
      consents.current(actor),
    ]);
    return { kind: "read", actor, profile, hostAccountActive, stripe, consent };
  } catch {
    return { kind: "stripe-unavailable", actor, profile, hostAccountActive };
  }
}

/** Whether the consent counts for publishing now: for the profile's account, at the version asked for now. */
export function payoutConsentCurrent(consent: PayoutAccountConsent | null, profile: Pick<HostAccountSellerProfile, "stripeConnectAccountRef">, requiredVersion: string): consent is PayoutAccountConsent {
  return consent !== null && requiredVersion !== ""
    && consent.consentVersion === requiredVersion
    && consent.stripeConnectAccountRef === profile.stripeConnectAccountRef;
}
