import type { NextRequest } from "next/server";
import { HOST_ACCOUNT_LIMITS, StoreAccessDeniedError, StoreConflictError, StoreValidationError } from "@niho-experience/experience-store";
import type { PayoutConsentOutcome } from "@/host/payout-account";
import { config } from "@/lib/config";
import { experiencePublicationRepository, payoutAccountConsents } from "@/lib/experience/store-server";
import { nowUtc, readExperienceHostSession, readSmallForm } from "@/lib/host/accounts";
import { reauthenticationHref } from "@/lib/host/niho-identity-server";
import { nihoIdOrNull } from "@/lib/host/providers";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { HOST_EMAIL_SIGN_IN_PATH, hostPayoutSettingsPath, withQuery } from "@/lib/host/routes";
import { hostNotFound, noStoreJson, seeOther, siteOrigin } from "@/lib/host/server";
import { ACCOUNT_SESSION_COOKIE, recentlyAuthenticated } from "@/lib/host/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Five short fields. */
const MAX_FORM_BYTES = 2048;
const FIELDS = ["providerId", "action", "accountLast4", "consentVersion", "accepted"] as const;

const back = (providerId: string, payout: PayoutConsentOutcome) => seeOther(withQuery(hostPayoutSettingsPath(providerId), { payout }));

/**
 * 受取口座の利用同意 (ADR 0003 slice 3, docs/host-accounts.md): the forms of 設定 › 受取口座 post here, with Experience host
 * accounts only. `action=consent` records the OWNER's consent, at the configured version, that the provider's registered
 * Stripe account (never one from the browser; `accountLast4` only confirms it is the one shown) receives its Experience
 * sales; `action=withdraw` withdraws it, which stops the provider's listings. Same-origin posts only. A session that did
 * not sign in with a link within 30 minutes goes to sign in again (`reauth=1`) and the link comes back to 受取口座. The
 * answer is a 303 back to 受取口座 with `?payout=` saying what happened; nothing about the account is logged.
 */
export async function POST(request: NextRequest) {
  if (!config.hostConsoleEnabled || !config.hostAccountsEnabled) return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  const form = await readSmallForm(request, FIELDS, ["providerId", "action", "accountLast4"], MAX_FORM_BYTES);
  if (!form.ok) return noStoreJson({ error: form.status === 413 ? "payload_too_large" : form.status === 415 ? "unsupported_media_type" : "invalid_input" }, form.status);
  const providerId = nihoIdOrNull(form.values.get("providerId"));
  const action = form.values.get("action");
  if (!providerId || (action !== "consent" && action !== "withdraw")) return noStoreJson({ error: "invalid_input" }, 400);
  if (action === "withdraw" && (form.values.has("consentVersion") || form.values.has("accepted"))) return noStoreJson({ error: "invalid_input" }, 400);

  let session: Awaited<ReturnType<typeof readExperienceHostSession>>;
  try { session = await readExperienceHostSession(request.cookies.get(ACCOUNT_SESSION_COOKIE)?.value); }
  catch { return back(providerId, "unavailable"); }
  // Signed out, or the last sign-in is older than 30 minutes: sign in again and come back to 受取口座. A host who signs in
  // with a bound NIHO account does it at NIHO (the recent sign-in is read from NIHO's); everyone else by the emailed link.
  const signInAgain = withQuery(HOST_EMAIL_SIGN_IN_PATH, { reauth: "1", next: hostPayoutSettingsPath(providerId) });
  if (!session) return seeOther(signInAgain);
  if (!recentlyAuthenticated(session, Date.now(), HOST_ACCOUNT_LIMITS.recentAuthenticationMinutes)) {
    return seeOther(await reauthenticationHref(session.hostAccountId, hostPayoutSettingsPath(providerId)).catch(() => signInAgain));
  }

  const repository = experiencePublicationRepository();
  const consents = payoutAccountConsents();
  if (!repository || !consents) return back(providerId, "unavailable");
  let resolved: Awaited<ReturnType<typeof repository.currentHostAccountSellerProfile>>;
  try { resolved = await repository.currentHostAccountSellerProfile(session.hostAccountId); }
  catch { return back(providerId, "unavailable"); }
  if (resolved.kind === "setup-required" && resolved.providerId === providerId) return back(providerId, "changed");
  if (resolved.kind !== "ready" || resolved.profile.providerId !== providerId) return back(providerId, "forbidden");
  const { profile } = resolved;
  if (form.values.get("accountLast4") !== profile.stripeConnectAccountRef.slice(-4)) return back(providerId, "changed");
  const actor = { providerId, nihoUserId: session.hostAccountId };

  try {
    if (action === "consent") {
      const version = config.experiencePayoutAccountConsentVersion;
      if (!version || form.values.get("consentVersion") !== version) return back(providerId, "changed");
      if (form.values.get("accepted") !== "yes") return back(providerId, "unchecked");
      await consents.record(actor, { stripeConnectAccountRef: profile.stripeConnectAccountRef, consentVersion: version, nowUtc: nowUtc() });
      return back(providerId, "consented");
    }
    await consents.revoke(actor, { nowUtc: nowUtc() });
    return back(providerId, "withdrawn");
  } catch (error) {
    if (error instanceof StoreAccessDeniedError) return back(providerId, "forbidden");
    if (error instanceof StoreConflictError || error instanceof StoreValidationError) return back(providerId, "changed");
    console.error(`[host-payout] payout consent not changed: ${error instanceof Error ? error.name : "unknown error"}`);
    return back(providerId, "unavailable");
  }
}
