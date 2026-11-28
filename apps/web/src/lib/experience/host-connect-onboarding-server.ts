import "server-only";
import { config } from "@/lib/config";
import type { PayoutOnboardingDeps } from "./host-connect-onboarding";
import { connectAccounts } from "./store-server";

/** The real store and Stripe for the payout-account onboarding; null while its flag is off or something it needs is missing. */
export function payoutOnboardingDeps(): PayoutOnboardingDeps | null {
  const accounts = connectAccounts();
  const platformStripeKey = process.env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY?.trim();
  if (!accounts || !platformStripeKey) return null;
  return { accounts, platformStripeKey, siteOrigin: new URL(config.siteUrl).origin, now: () => new Date() };
}
