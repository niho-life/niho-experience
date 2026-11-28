import "server-only";
import { config } from "@/lib/config";
import { payoutConsentCurrent, readHostPayoutAccount, type HostPayoutAccountRead } from "@/lib/experience/host-payout-account";
import type { HostProvider } from "@/lib/host/providers";
import type { ExperienceHostSession } from "@/lib/host/session";
import { loadPayoutScreenState } from "@/lib/experience/host-connect-onboarding";
import { payoutOnboardingDeps } from "@/lib/experience/host-connect-onboarding-server";
import type { ExperiencePayoutLoad } from "./payout-account";

/** The payout account as 受取口座 shows it, from what readHostPayoutAccount read for the page's provider. */
export function experiencePayoutLoadOf(read: HostPayoutAccountRead, providerId: string, consentVersion: string): ExperiencePayoutLoad {
  if (read.kind === "setup-required") return read.providerId === providerId ? { status: "setup-required" } : { status: "error" };
  if (read.kind !== "read" && read.kind !== "stripe-unavailable") return { status: "error" };
  // The console shows the provider the account is OWNER of; another one is never described with this account.
  if (read.profile.providerId !== providerId) return { status: "error" };
  const base = { status: "owner" as const, providerName: read.profile.providerDisplayName, accountLast4: read.profile.stripeConnectAccountRef.slice(-4), consentVersion };
  if (read.kind === "stripe-unavailable") return { ...base, stripe: "unknown", problems: [], consent: { state: "unknown" } };
  const consent = read.consent === null ? { state: "none" as const }
    : payoutConsentCurrent(read.consent, read.profile, consentVersion) ? { state: "current" as const, consentedAtUtc: read.consent.consentedAtUtc }
    : { state: "outdated" as const };
  return {
    ...base,
    stripe: read.stripe.kind,
    problems: read.stripe.kind === "not_ready" ? read.stripe.problems : [],
    consent,
  };
}

/**
 * 受取口座 of the page's provider with an Experience host account (ADR 0003 slice 3): the OWNER's only; Stripe is asked on
 * every load (no NIHO call). Anyone else sees that it is the OWNER's to see.
 */
export async function loadExperiencePayout(
  session: Pick<ExperienceHostSession, "hostAccountId">,
  provider: Pick<HostProvider, "id" | "memberRole">,
  /** `readConnect: false` (売上, ホーム: they only need "not connected"): a host registering its own account is not read from Stripe, and nothing is kept. */
  options: { readonly readConnect?: boolean } = {},
): Promise<ExperiencePayoutLoad> {
  if (provider.memberRole !== "OWNER") return { status: "not-owner" };
  try {
    const read = await readHostPayoutAccount(session.hostAccountId, undefined, provider.id);
    // No Direct charge seller: with the onboarding flag on, the host registers its own payout account (Epic #700 stage 3a, #710).
    if (read.kind === "setup-required" && read.providerId === provider.id && config.hostConnectOnboardingEnabled) {
      if (options.readConnect === false) return { status: "connect", state: "NOT_STARTED" };
      const deps = payoutOnboardingDeps();
      if (!deps) return { status: "error" };
      const screen = await loadPayoutScreenState(provider.id, deps);
      return screen === "seller" ? { status: "setup-required" } : { status: "connect", state: screen.state };
    }
    return experiencePayoutLoadOf(read, provider.id, config.experiencePayoutAccountConsentVersion);
  } catch {
    return { status: "error" };
  }
}
