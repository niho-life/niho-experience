import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { nihoConnectUrl } from "@/lib/host/niho-auth";
import { startNihoLogin } from "@/lib/host/niho-login";
import { createLoginState, createPkceVerifier, pkceChallenge } from "@/lib/host/pkce";
import { nihoIdOrNull } from "@/lib/host/providers";
import { HOST_EMAIL_SIGN_IN_PATH, HOST_HOME_PATH, HOST_MOCK_LOGIN_PATH, hostInvitationPath, hostReturnPathOrNull, invitationIdOrNull, preparationCaseIdOrNull, withQuery } from "@/lib/host/routes";
import { hostNotFound, isHostMock, noStoreJson, readHostSession, seeOther, setLoginCookie, siteOrigin } from "@/lib/host/server";
import { LOGIN_MAX_AGE_SECONDS } from "@/lib/host/session";

/**
 * Starts "NIHO でログイン": PKCE verifier and state in a 10-minute sealed cookie, then NIHO's confirmation page.
 * `?surface=app` comes from the installed app's start page (#177); the session it ends in carries that mark.
 * With Experience host accounts (ADR 0003) every 「ログイン」 link lands here too, and goes on to the email form, or with the
 * NIHO account login (Epic #591) to NIHO, which only proves who the host is (niho-login.ts).
 */
export async function GET(request: NextRequest) {
  if (!config.hostConsoleEnabled) return hostNotFound();
  const invitationId = invitationIdOrNull(request.nextUrl.searchParams.get("invitationId"));
  const returnPath = hostReturnPathOrNull(request.nextUrl.searchParams.get("returnTo"));
  if (config.hostAccountsEnabled && config.hostNihoLoginEnabled) {
    // Already signed in (an old link, a second tab): straight on to where the sign-in was for, with no trip to NIHO.
    if (await readHostSession()) return seeOther(invitationId ? hostInvitationPath(invitationId) : returnPath ?? HOST_HOME_PATH);
    return startNihoLogin(request);
  }
  // The email form keeps an invitation as the page the opened link returns to (hostReturnPathOrNull).
  if (config.hostAccountsEnabled) return seeOther(withQuery(HOST_EMAIL_SIGN_IN_PATH, { next: invitationId ? hostInvitationPath(invitationId) : returnPath }));
  const providerId = nihoIdOrNull(request.nextUrl.searchParams.get("providerId"));
  const preparationCaseId = preparationCaseIdOrNull(request.nextUrl.searchParams.get("preparationCaseId"));
  const surface = request.nextUrl.searchParams.get("surface") === "app" ? "app" : undefined;
  if (preparationCaseId && invitationId) return noStoreJson({ error: "conflicting_login_intent" }, 400);

  if (isHostMock()) {
    // Preview: no NIHO round trip; a synthetic session is made locally.
    const params = new URLSearchParams();
    if (providerId) params.set("providerId", providerId);
    if (preparationCaseId) params.set("preparationCaseId", preparationCaseId);
    if (invitationId) params.set("invitationId", invitationId);
    if (returnPath) params.set("returnTo", returnPath);
    // `unregistered`: a synthetic NIHO account nobody registered (the NIHO account login's not-registered page).
    const mock = request.nextUrl.searchParams.get("mock");
    if (mock === "empty" || mock === "unregistered") params.set("mock", mock);
    if (surface) params.set("surface", surface);
    return seeOther(params.size ? `${HOST_MOCK_LOGIN_PATH}?${params}` : HOST_MOCK_LOGIN_PATH);
  }

  const verifier = createPkceVerifier();
  const state = createLoginState();
  const response = seeOther(nihoConnectUrl(config.nihoWebOrigin, { challenge: pkceChallenge(verifier), state, origin: siteOrigin() }));
  setLoginCookie(response, { verifier, state, providerId, preparationCaseId, ...(invitationId ? { invitationId } : {}), ...(returnPath ? { returnPath } : {}), ...(surface ? { surface } : {}), expiresAt: Date.now() + LOGIN_MAX_AGE_SECONDS * 1000 });
  return response;
}
