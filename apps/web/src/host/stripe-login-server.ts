import "server-only";
import { createConnectedAccountLoginLink } from "@niho-experience/experience-payments";
import { HOST_ACCOUNT_LIMITS } from "@niho-experience/experience-store";
import { connectAccounts, hostSalesRepository, sellerIsDirect } from "@/lib/experience/store-server";
import { config } from "@/lib/config";
import { loadNihoIdentityStatus } from "@/lib/host/niho-identity-server";
import { hostNihoReauthPath, hostPayoutSettingsPath } from "@/lib/host/routes";
import { accessTokenUsable, recentlyAuthenticated } from "@/lib/host/session";
import { loadHostProviders, readHostSession } from "@/lib/host/server";
import { nihoIdOrNull } from "@/lib/host/providers";
import { STRIPE_FULL_DASHBOARD_URL, type StripeLoginKind } from "./payout";
import { ownerActor } from "./site-bookings-server";

/**
 * Creates an Express login link only after NIHO names the signed-in user as provider OWNER and
 * Experience confirms its OWNER membership plus one unambiguous payout account. Stripe account
 * IDs and the one-time URL stay on the server. An Experience host account (ADR 0003) must have signed in with a link
 * within the last 30 minutes; otherwise, as for any refusal, the route sends the host to Stripe's own sign-in.
 */
export async function hostStripeLoginUrl(providerId: unknown, kind?: StripeLoginKind): Promise<string | null> {
  const id = nihoIdOrNull(providerId);
  if (!id) return null;

  const session = await readHostSession();
  if (!session || !accessTokenUsable(session, Date.now())) return null;
  if (session.kind === "experience" && !recentlyAuthenticated(session, Date.now(), HOST_ACCOUNT_LIMITS.recentAuthenticationMinutes)) return null;
  const loaded = await loadHostProviders();
  if (loaded.status !== "ok") return null;
  const provider = loaded.providers.find((entry) => entry.id === id);
  if (provider?.memberRole !== "OWNER") return null;

  // The host's OWN Stripe account (3c-1) is a full-dashboard account the host signs in to itself: never an Express login link, whatever
  // flags are on. Decided by the seller profile before anything else. `kind: "payout"` (the Express block) skips this and opens the payout account.
  if (kind !== "payout" && await sellerIsDirect(provider.id)) return STRIPE_FULL_DASHBOARD_URL;
  if (kind === "direct") return null;

  const platformStripeKey = process.env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY;
  const sales = hostSalesRepository();
  if (!platformStripeKey || !sales) return null;

  // Which account opens is the server's choice, by purpose: the Direct charge seller's account first (as before; not for the Express block), otherwise the
  // payout account the host registered itself (Epic #700 stage 3a, #710; only with its flag on). Never an ID from the browser.
  const accounts = kind === "payout" ? [] : await sales.listPayoutAccountsForHost(ownerActor(provider));
  if (accounts.length === 1) return createConnectedAccountLoginLink({ accountId: accounts[0]!, platformStripeKey });
  if (accounts.length > 1) return null;
  const connect = connectAccounts();
  const payout = connect ? await connect.currentPayout(provider.id) : null;
  if (!payout?.account.stripeAccountRef || payout.account.purpose !== "PAYOUT") return null;
  return createConnectedAccountLoginLink({ accountId: payout.account.stripeAccountRef, platformStripeKey });
}

/**
 * For a host who signs in with a bound NIHO account (Epic #591) and whose last sign-in is older than 30 minutes: where to
 * sign in again at NIHO before the dashboard opens, back to 受取口座 (the host presses the button again). null for everyone
 * else, who is sent where they were before: Stripe's own sign-in.
 */
export async function hostStripeReauthHref(providerId: string): Promise<string | null> {
  if (!config.hostNihoLoginEnabled) return null;
  const session = await readHostSession();
  if (!session || session.kind !== "experience" || recentlyAuthenticated(session, Date.now(), HOST_ACCOUNT_LIMITS.recentAuthenticationMinutes)) return null;
  const bound = await loadNihoIdentityStatus(session.hostAccountId);
  return bound !== null && bound !== "error" ? hostNihoReauthPath(hostPayoutSettingsPath(providerId)) : null;
}
