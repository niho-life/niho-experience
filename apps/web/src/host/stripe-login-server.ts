import "server-only";
import { createConnectedAccountLoginLink } from "@niho-experience/experience-payments";
import { HOST_ACCOUNT_LIMITS } from "@niho-experience/experience-store";
import { hostSalesRepository } from "@/lib/experience/store-server";
import { accessTokenUsable, recentlyAuthenticated } from "@/lib/host/session";
import { loadHostProviders, readHostSession } from "@/lib/host/server";
import { nihoIdOrNull } from "@/lib/host/providers";
import { ownerActor } from "./site-bookings-server";

/**
 * Creates an Express login link only after NIHO names the signed-in user as provider OWNER and
 * Experience confirms its OWNER membership plus one unambiguous payout account. Stripe account
 * IDs and the one-time URL stay on the server. An Experience host account (ADR 0003) must have signed in with a link
 * within the last 30 minutes; otherwise, as for any refusal, the route sends the host to Stripe's own sign-in.
 */
export async function hostStripeLoginUrl(providerId: unknown): Promise<string | null> {
  const id = nihoIdOrNull(providerId);
  const platformStripeKey = process.env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY;
  const sales = hostSalesRepository();
  if (!id || !platformStripeKey || !sales) return null;

  const session = await readHostSession();
  if (!session || !accessTokenUsable(session, Date.now())) return null;
  if (session.kind === "experience" && !recentlyAuthenticated(session, Date.now(), HOST_ACCOUNT_LIMITS.recentAuthenticationMinutes)) return null;
  const loaded = await loadHostProviders();
  if (loaded.status !== "ok") return null;
  const provider = loaded.providers.find((entry) => entry.id === id);
  if (provider?.memberRole !== "OWNER") return null;

  const accounts = await sales.listPayoutAccountsForHost(ownerActor(provider));
  if (accounts.length !== 1) return null;
  return createConnectedAccountLoginLink({ accountId: accounts[0]!, platformStripeKey });
}
