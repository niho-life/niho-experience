import "server-only";
import type { NextRequest } from "next/server";
import { HOST_ACCOUNT_LIMITS } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { readExperienceHostSession } from "@/lib/host/accounts";
import { reauthenticationHref } from "@/lib/host/niho-identity-server";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { HOST_EMAIL_SIGN_IN_PATH, hostPayoutSettingsPath, withQuery } from "@/lib/host/routes";
import { hostNotFound, noStoreJson, seeOther, siteOrigin } from "@/lib/host/server";
import { ACCOUNT_SESSION_COOKIE, recentlyAuthenticated } from "@/lib/host/session";
import { payoutOnboardingDeps } from "./host-connect-onboarding-server";
import { refreshPayoutOnboardingLink, startPayoutOnboarding, type PayoutOnboardingResult } from "./host-connect-onboarding";
import { requestedProviderId, resolveProviderContext } from "./provider-context";

/*
 * 設定 › 受取口座 の登録 (Epic #700 stage 3a, #710, docs/host-payouts.md). Two routes, both 404 until
 * EXPERIENCE_HOST_CONNECT_ONBOARDING_ENABLED (which needs the host accounts), both for the OWNER of the provider named by
 * `?providerId=` (a hint that is checked against the account's memberships on every call). The Account Link is a bearer URL: it
 * leaves only as a no-store 303, never as JSON, a page value or a log line.
 */

const enabled = () => config.hostConsoleEnabled && config.hostAccountsEnabled && config.hostConnectOnboardingEnabled;
const INVALID = { code: "INVALID_INPUT", status: 400 } as const;

function leave(result: PayoutOnboardingResult, providerId: string): Response {
  if (result.kind === "failed") return seeOther(withQuery(hostPayoutSettingsPath(providerId), { payout: result.outcome }));
  return new Response(null, {
    status: 303,
    headers: { location: result.url, "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" },
  });
}

/**
 * Registers (or continues) the provider's payout account and sends the OWNER to Stripe's pages. Same-origin posts only, from a
 * sign-in within the last 30 minutes (an older one is sent to sign in again and comes back to 受取口座), by the OWNER only, and
 * not for a provider that has a Direct charge seller.
 */
export async function postPayoutOnboarding(request: NextRequest): Promise<Response> {
  if (!enabled()) return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  const requested = requestedProviderId(request, INVALID);
  if (!requested.ok) return requested.response;
  let session: Awaited<ReturnType<typeof readExperienceHostSession>>;
  try { session = await readExperienceHostSession(request.cookies.get(ACCOUNT_SESSION_COOKIE)?.value); }
  catch { return noStoreJson({ error: { code: "UNAVAILABLE" } }, 503); }
  const signInAgain = withQuery(HOST_EMAIL_SIGN_IN_PATH, { reauth: "1", next: hostPayoutSettingsPath(requested.providerId) });
  if (!session) return seeOther(signInAgain);
  if (!recentlyAuthenticated(session, Date.now(), HOST_ACCOUNT_LIMITS.recentAuthenticationMinutes)) {
    return seeOther(await reauthenticationHref(session.hostAccountId, hostPayoutSettingsPath(requested.providerId)).catch(() => signInAgain));
  }
  const context = await resolveProviderContext(session, requested.providerId, ["OWNER"]);
  if (!context.ok) return context.response;
  const deps = payoutOnboardingDeps();
  if (!deps) return noStoreJson({ error: { code: "UNAVAILABLE" } }, 503);
  return leave(await startPayoutOnboarding(context.value.actor, deps), context.value.actor.providerId);
}

/** Stripe's refresh_url (the link expired or was opened twice): a new Link, for the OWNER signed in within 30 minutes only. */
export async function getPayoutOnboardingRefresh(request: NextRequest): Promise<Response> {
  if (!enabled()) return hostNotFound();
  const requested = requestedProviderId(request, INVALID);
  if (!requested.ok) return requested.response;
  let session: Awaited<ReturnType<typeof readExperienceHostSession>>;
  try { session = await readExperienceHostSession(request.cookies.get(ACCOUNT_SESSION_COOKIE)?.value); }
  catch { return noStoreJson({ error: { code: "UNAVAILABLE" } }, 503); }
  const signInAgain = withQuery(HOST_EMAIL_SIGN_IN_PATH, { reauth: "1", next: hostPayoutSettingsPath(requested.providerId) });
  if (!session) return seeOther(signInAgain);
  // As the POST and stripe-login: a new Link is a bearer credential, so a sign-in older than 30 minutes signs in again first.
  if (!recentlyAuthenticated(session, Date.now(), HOST_ACCOUNT_LIMITS.recentAuthenticationMinutes)) {
    return seeOther(await reauthenticationHref(session.hostAccountId, hostPayoutSettingsPath(requested.providerId)).catch(() => signInAgain));
  }
  const context = await resolveProviderContext(session, requested.providerId, ["OWNER"]);
  if (!context.ok) return context.response;
  const deps = payoutOnboardingDeps();
  if (!deps) return noStoreJson({ error: { code: "UNAVAILABLE" } }, 503);
  return leave(await refreshPayoutOnboardingLink(context.value.actor.providerId, deps), context.value.actor.providerId);
}
