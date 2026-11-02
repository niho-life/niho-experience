import "server-only";
import { createConnectedAccountLoginLink } from "@niho-experience/experience-payments";
import { hostSalesRepository } from "@/lib/experience/store-server";
import { accessTokenUsable } from "@/lib/host/session";
import { loadHostProviders, readHostSession } from "@/lib/host/server";
import { nihoIdOrNull } from "@/lib/host/providers";
import { ownerActor } from "./site-bookings-server";

/**
 * Creates an Express login link only after NIHO names the signed-in user as provider OWNER and
 * Experience confirms its OWNER membership plus one unambiguous payout account. Stripe account
 * IDs and the one-time URL stay on the server.
 */
export async function hostStripeLoginUrl(providerId: unknown): Promise<string | null> {
  const id = nihoIdOrNull(providerId);
  const platformStripeKey = process.env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY;
  const sales = hostSalesRepository();
  if (!id || !platformStripeKey || !sales) return null;

  const session = await readHostSession();
  if (!session || !accessTokenUsable(session, Date.now())) return null;
  const loaded = await loadHostProviders();
  if (loaded.status !== "ok") return null;
  const provider = loaded.providers.find((entry) => entry.id === id);
  if (provider?.memberRole !== "OWNER") return null;

  const accounts = await sales.listPayoutAccountsForHost(ownerActor(provider));
  if (accounts.length !== 1) return null;
  return createConnectedAccountLoginLink({ accountId: accounts[0]!, platformStripeKey });
}
