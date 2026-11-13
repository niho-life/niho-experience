import type { NextRequest } from "next/server";
import { HOST_ACCOUNT_LIMITS } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { hostAccountIdentities } from "@/lib/experience/store-server";
import { nowUtc, readExperienceHostSession, readSmallForm } from "@/lib/host/accounts";
import { EMAIL_SIGN_IN_AVAILABLE, type NihoIdentityOutcome } from "@/lib/host/niho-identity";
import { loadNihoIdentityStatus, reauthenticationHref } from "@/lib/host/niho-identity-server";
import { startNihoLink } from "@/lib/host/niho-login";
import { nihoIdOrNull } from "@/lib/host/providers";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { HOST_EMAIL_SIGN_IN_PATH, hostAccountSettingsPath, withQuery } from "@/lib/host/routes";
import { hostNotFound, noStoreJson, seeOther, siteOrigin } from "@/lib/host/server";
import { ACCOUNT_SESSION_COOKIE, recentlyAuthenticated } from "@/lib/host/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Two short fields. */
const MAX_FORM_BYTES = 512;

/**
 * 設定 › ログイン情報 (Epic #591, #595): the forms there post here, with the NIHO account login on. `action=link` sends the
 * signed-in host to NIHO to bind the NIHO account they come back with (niho-login.ts); `action=unlink` unbinds it, unless
 * nothing else would let the host in. Same-origin posts only. A session whose sign-in is older than 30 minutes goes to sign
 * in again first (NIHO's own login for a bound account, the emailed link for the rest) and returns to 設定. The answer is a
 * 303 to 設定 › ログイン情報 with `?niho=` saying what happened; no NIHO user ID is in it, a log or an error.
 */
export async function POST(request: NextRequest) {
  if (!config.hostConsoleEnabled || !config.hostAccountsEnabled || !config.hostNihoLoginEnabled) return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  const form = await readSmallForm(request, ["action", "providerId"], ["action"], MAX_FORM_BYTES);
  if (!form.ok) return noStoreJson({ error: form.status === 413 ? "payload_too_large" : form.status === 415 ? "unsupported_media_type" : "invalid_input" }, form.status);
  const action = form.values.get("action");
  const rawProviderId = form.values.get("providerId");
  const providerId = rawProviderId ? nihoIdOrNull(rawProviderId) : null;
  if ((action !== "link" && action !== "unlink") || (rawProviderId && !providerId)) return noStoreJson({ error: "invalid_input" }, 400);

  const settings = hostAccountSettingsPath(providerId);
  const back = (outcome: NihoIdentityOutcome) => seeOther(withQuery(settings, { niho: outcome }));
  let session: Awaited<ReturnType<typeof readExperienceHostSession>>;
  try { session = await readExperienceHostSession(request.cookies.get(ACCOUNT_SESSION_COOKIE)?.value); }
  catch { return back("unavailable"); }
  // Signed out (the session ended): the entrance, then back here by hand.
  if (!session) return seeOther(HOST_EMAIL_SIGN_IN_PATH);
  const identities = hostAccountIdentities();
  if (!identities) return back("unavailable");
  const stale = !recentlyAuthenticated(session, Date.now(), HOST_ACCOUNT_LIMITS.recentAuthenticationMinutes);

  if (action === "link") {
    const bound = await loadNihoIdentityStatus(session.hostAccountId, identities);
    if (bound === "error") return back("unavailable");
    if (bound !== null) return back("already-linked");
    // The host proves it is them first (the emailed link: nothing is bound yet), then NIHO proves the NIHO account.
    if (stale) return seeOther(await reauthenticationHref(session.hostAccountId, settings, identities));
    return startNihoLink(providerId, session.hostAccountId);
  }

  try {
    const result = await identities.unlinkNihoIdentity({
      hostAccountId: session.hostAccountId,
      proof: { kind: "SESSION", sessionRef: session.sessionRef, emailSignInAvailable: EMAIL_SIGN_IN_AVAILABLE },
      nowUtc: nowUtc(),
    });
    switch (result.kind) {
      case "unlinked": return back("unlinked");
      case "not-linked": return back("not-linked");
      case "last-sign-in-method": return back("last-method");
      case "recent-authentication-required": return seeOther(await reauthenticationHref(session.hostAccountId, settings, identities));
    }
  } catch (error) {
    console.error(`[host-auth] NIHO account not unlinked: ${error instanceof Error ? error.name : "unknown error"}`);
    return back("unavailable");
  }
}
