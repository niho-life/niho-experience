import "server-only";
import type { NextRequest } from "next/server";
import { HOST_ACCOUNT_LIMITS } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { nowUtc, readExperienceHostSession, readSmallForm } from "@/lib/host/accounts";
import { reauthenticationHref } from "@/lib/host/niho-identity-server";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { HOST_EMAIL_SIGN_IN_PATH, hostPayoutSettingsPath, withQuery } from "@/lib/host/routes";
import { hostNotFound, noStoreJson, seeOther, siteOrigin } from "@/lib/host/server";
import { ACCOUNT_SESSION_COOKIE, recentlyAuthenticated } from "@/lib/host/session";
import { payoutOnboardingDeps } from "./host-connect-onboarding-server";
import { refreshDirectOnboardingLink, registerDirectSeller, startDirectOnboarding, type DirectOnboardingResult } from "./host-direct-account";
import { requestedProviderId, resolveProviderContext } from "./provider-context";
import { directSellers } from "./store-server";

/*
 * 自分の Stripe アカウントをつなぐ (Epic #700 stage 3c-1, #726, docs/host-payouts.md「3c」). Three routes, all 404 until
 * EXPERIENCE_HOST_STANDARD_ONBOARDING_ENABLED (which needs the host accounts), all for the OWNER of the provider named by `?providerId=`
 * (a hint checked against the account's memberships on every call), from a sign-in within the last 30 minutes. The Account Link is a
 * bearer URL: it leaves only as a no-store 303, never as JSON, a page value or a log line.
 */

const enabled = () => config.hostConsoleEnabled && config.hostAccountsEnabled && config.hostStandardOnboardingEnabled;
const INVALID = { code: "INVALID_INPUT", status: 400 } as const;
const MAX_FORM_BYTES = 2048;
const SELLER_FIELDS = ["accountLast4", "consentVersion", "accepted"] as const;

function leave(result: DirectOnboardingResult, providerId: string): Response {
  if (result.kind === "failed") return seeOther(withQuery(hostPayoutSettingsPath(providerId), { payout: result.outcome }));
  return new Response(null, {
    status: 303,
    headers: { location: result.url, "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" },
  });
}

type Prepared =
  | { readonly ok: true; readonly actor: { readonly providerId: string; readonly nihoUserId: string }; readonly providerId: string }
  | { readonly ok: false; readonly response: Response };

/** The shared gate: the provider hint, the host session, a sign-in within 30 minutes (else sign in again and come back), the OWNER. */
async function prepare(request: NextRequest): Promise<Prepared> {
  const requested = requestedProviderId(request, INVALID);
  if (!requested.ok) return requested;
  let session: Awaited<ReturnType<typeof readExperienceHostSession>>;
  try { session = await readExperienceHostSession(request.cookies.get(ACCOUNT_SESSION_COOKIE)?.value); }
  catch { return { ok: false, response: noStoreJson({ error: { code: "UNAVAILABLE" } }, 503) }; }
  const signInAgain = withQuery(HOST_EMAIL_SIGN_IN_PATH, { reauth: "1", next: hostPayoutSettingsPath(requested.providerId) });
  if (!session) return { ok: false, response: seeOther(signInAgain) };
  if (!recentlyAuthenticated(session, Date.now(), HOST_ACCOUNT_LIMITS.recentAuthenticationMinutes)) {
    return { ok: false, response: seeOther(await reauthenticationHref(session.hostAccountId, hostPayoutSettingsPath(requested.providerId)).catch(() => signInAgain)) };
  }
  const context = await resolveProviderContext(session, requested.providerId, ["OWNER"]);
  if (!context.ok) return context;
  return { ok: true, actor: context.value.actor, providerId: context.value.actor.providerId };
}

/** Registers (or continues) the host's own account and sends the OWNER to Stripe's pages. Same-origin posts only. */
export async function postDirectOnboarding(request: NextRequest): Promise<Response> {
  if (!enabled()) return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  const prepared = await prepare(request);
  if (!prepared.ok) return prepared.response;
  const deps = payoutOnboardingDeps();
  if (!deps) return noStoreJson({ error: { code: "UNAVAILABLE" } }, 503);
  return leave(await startDirectOnboarding(prepared.actor, deps), prepared.providerId);
}

/** Stripe's refresh_url (the link expired or was opened twice): a new Link. */
export async function getDirectOnboardingRefresh(request: NextRequest): Promise<Response> {
  if (!enabled()) return hostNotFound();
  const prepared = await prepare(request);
  if (!prepared.ok) return prepared.response;
  const deps = payoutOnboardingDeps();
  if (!deps) return noStoreJson({ error: { code: "UNAVAILABLE" } }, 503);
  return leave(await refreshDirectOnboardingLink(prepared.providerId, deps), prepared.providerId);
}

/**
 * The OWNER's consent once the account is READY: Stripe is read again, then the seller profile and the payout-account consent are
 * written together. The consent text's version must be the configured one; `accountLast4` only confirms the account shown.
 */
export async function postDirectSeller(request: NextRequest): Promise<Response> {
  if (!enabled()) return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  const form = await readSmallForm(request, SELLER_FIELDS, ["accountLast4", "consentVersion"], MAX_FORM_BYTES);
  if (!form.ok) return noStoreJson({ error: form.status === 413 ? "payload_too_large" : form.status === 415 ? "unsupported_media_type" : "invalid_input" }, form.status);
  const prepared = await prepare(request);
  if (!prepared.ok) return prepared.response;
  const back = (payout: string) => seeOther(withQuery(hostPayoutSettingsPath(prepared.providerId), { payout }));
  const version = config.experiencePayoutAccountConsentVersion;
  if (!version || form.values.get("consentVersion") !== version) return back("directChanged");
  if (form.values.get("accepted") !== "yes") return back("directUnchecked");
  const deps = payoutOnboardingDeps();
  const sellers = directSellers();
  if (!deps || !sellers) return noStoreJson({ error: { code: "UNAVAILABLE" } }, 503);
  const result = await registerDirectSeller(prepared.actor, { ...deps, sellers, now: () => new Date(nowUtc()) }, { accountLast4: form.values.get("accountLast4")!, consentVersion: version });
  return back(result.kind === "registered" ? "directRegistered" : result.outcome);
}
