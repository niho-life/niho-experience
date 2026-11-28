import "server-only";
import { config } from "@/lib/config";
import { payoutConsentCurrent, readHostPayoutAccount, type HostPayoutAccountRead } from "@/lib/experience/host-payout-account";
import type { HostProvider } from "@/lib/host/providers";
import type { ExperienceHostSession } from "@/lib/host/session";
import { loadPayoutScreenState } from "@/lib/experience/host-connect-onboarding";
import { payoutOnboardingDeps } from "@/lib/experience/host-connect-onboarding-server";
import { loadDirectScreenState } from "@/lib/experience/host-direct-account";
import { providerSellerDisclosureRepository } from "@/lib/experience/store-server";
import type { ConnectPayoutState, DirectPayoutSection, ExperiencePayoutLoad } from "./payout-account";

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
  provider: Pick<HostProvider, "id" | "memberRole"> & { readonly displayName?: string },
  /** `readConnect: false` (売上, ホーム: they only need "not connected"): a host registering its own account is not read from Stripe, and nothing is kept. */
  options: { readonly readConnect?: boolean } = {},
): Promise<ExperiencePayoutLoad> {
  if (provider.memberRole !== "OWNER") return { status: "not-owner" };
  try {
    const read = await readHostPayoutAccount(session.hostAccountId, undefined, provider.id);
    const payoutOn = config.hostConnectOnboardingEnabled;
    const directOn = config.hostStandardOnboardingEnabled;
    // No Direct charge seller: with a registration flag on, the host registers its own account (3a: the payout account for 代理受領; 3c-1: its own Stripe account).
    if (read.kind === "setup-required" && read.providerId === provider.id && (payoutOn || directOn)) {
      const consentVersion = config.experiencePayoutAccountConsentVersion;
      const section = (state: ConnectPayoutState): DirectPayoutSection => ({ state, providerName: provider.displayName ?? "", accountLast4: null, consentVersion, disclosure: "missing" });
      if (options.readConnect === false) return { status: "connect", payout: payoutOn ? "NOT_STARTED" : null, direct: directOn ? section("NOT_STARTED") : null };
      const deps = payoutOnboardingDeps();
      if (!deps) return { status: "error" };
      let payout: ConnectPayoutState | null = null;
      if (payoutOn) {
        const screen = await loadPayoutScreenState(provider.id, deps);
        if (screen === "seller") return { status: "setup-required" };
        payout = screen.state;
      } else if (await deps.accounts.sellerExists(provider.id)) {
        return { status: "setup-required" };
      }
      let direct: DirectPayoutSection | null = null;
      if (directOn) {
        const screen = await loadDirectScreenState(provider.id, deps);
        direct = { ...section(screen.state), accountLast4: screen.accountRef?.slice(-4) ?? null };
        if (screen.state === "READY") direct = { ...direct, disclosure: await nativeDisclosureExists(session.hostAccountId, provider.id) ? "ready" : "missing" };
      }
      return { status: "connect", payout, direct };
    }
    const load = experiencePayoutLoadOf(read, provider.id, config.experiencePayoutAccountConsentVersion);
    if (load.status !== "owner" || options.readConnect === false) return load;
    return { ...load, ...(await ownerExtras(read, provider.id)) };
  } catch {
    return { status: "error" };
  }
}

/** Whether the provider has a public NATIVE seller disclosure to sell under (what the consent step needs before it creates the seller). */
async function nativeDisclosureExists(hostAccountId: string, providerId: string): Promise<boolean> {
  const disclosures = providerSellerDisclosureRepository();
  if (!disclosures) return false;
  const state = await disclosures.getForOwner({ providerId, nihoUserId: hostAccountId }, { agentSales: true }).catch(() => null);
  return state?.disclosure?.method === "NATIVE";
}

/**
 * For a host that has a seller profile: whether the account is its OWN Stripe account (「Stripe で見る」 opens its dashboard), and the
 * Express payout account's block while it has a row or agreed to agent sales (NIHO still sends it what it took, 3b).
 */
async function ownerExtras(read: HostPayoutAccountRead, providerId: string): Promise<{ payout?: ConnectPayoutState; standard?: boolean }> {
  const deps = payoutOnboardingDeps();
  if (!deps || read.kind !== "read" && read.kind !== "stripe-unavailable") return {};
  const extras: { payout?: ConnectPayoutState; standard?: boolean } = {};
  const own = await deps.accounts.findByAccountRef(read.profile.stripeConnectAccountRef);
  if (own && own.account.purpose === "DIRECT" && own.account.providerId === providerId && own.account.retiredAtUtc === null) extras.standard = true;
  if (config.hostConnectOnboardingEnabled) {
    const block = await deps.accounts.payoutBlock(providerId);
    if (block?.current) {
      const screen = await loadPayoutScreenState(providerId, deps);
      if (screen !== "seller") extras.payout = screen.state;
    } else if (block) {
      extras.payout = "NOT_STARTED";
    }
  }
  return extras;
}
