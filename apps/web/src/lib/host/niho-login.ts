import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { hostAccountIdentities, hostAccounts } from "@/lib/experience/store-server";
import { isOpaqueSecret, nowUtc, setAccountSessionCookie } from "./accounts";
import { deleteConnection, exchangeCode, nihoConnectUrl } from "./niho-auth";
import { loginStatesMatch, createLoginState, createPkceVerifier, pkceChallenge } from "./pkce";
import { nihoIdOrNull } from "./providers";
import { forgetHostPushConnection } from "./push/server";
import { HOST_AUTH_ERROR_PATH, HOST_HOME_PATH, hostInvitationPath, hostReturnPathOrNull, invitationIdOrNull, withProvider, withQuery, type LoginErrorReason } from "./routes";
import { clearLoginCookie, loginSealer, lookupNihoIdentity, nihoAuthDeps, seeOther, setLoginCookie, siteOrigin } from "./server";
import { ACCOUNT_SESSION_COOKIE, decodeLoginState, LOGIN_COOKIE, LOGIN_MAX_AGE_SECONDS, type HostLoginState } from "./session";

/*
 * 「NIHO アカウントでログイン」 (Epic #591, #594, EXPERIENCE_HOST_NIHO_LOGIN_ENABLED): NIHO only proves who the host is.
 *
 *   /host/auth/login → NIHO's confirmation page (PKCE challenge, state, the host audience)
 *   NIHO → /host/auth/callback?code&state
 *     1. exchange the code (the verifier is in the sealed 10-minute login cookie)
 *     2. Host v1 `identity` → the NIHO user ID
 *     3. the experience DB: the host account that NIHO user ID is bound to → an Experience session
 *     4. end the NIHO connection at once (`DELETE /api/auth/app-connections/{id}`), whatever the outcome
 *
 * No NIHO token leaves this function: not into a cookie, the database, a log or a URL. The session is the Experience one
 * (`__Host-niho_host_account_session`, Path=/, so /write sees it too). A NIHO account no host account is bound to gets
 * the 「ホストに登録されていません」 page and nothing of Experience's changes.
 */

const MAX_CODE_LENGTH = 2048;

/** Back to the page that tells why, keeping the invitation the sign-in was for so "try again" returns to it. */
function failed(reason: LoginErrorReason, login: HostLoginState | null = null): NextResponse {
  const response = seeOther(withQuery(HOST_AUTH_ERROR_PATH, { reason, invitationId: login?.invitationId ?? null }));
  clearLoginCookie(response);
  return response;
}

/**
 * Starts the sign-in: the PKCE verifier and state go into a sealed 10-minute cookie, the host to NIHO's confirmation page.
 * Where to return is the invitation (a product operator's, which the sign-in comes back to accept) or an allowlisted page
 * (hostReturnPathOrNull: /write, 設定 › 受取口座), never anything else.
 */
export function startNihoLogin(request: NextRequest): NextResponse {
  const invitationId = invitationIdOrNull(request.nextUrl.searchParams.get("invitationId"));
  const returnPath = hostReturnPathOrNull(request.nextUrl.searchParams.get("returnTo"));
  const providerId = nihoIdOrNull(request.nextUrl.searchParams.get("providerId"));
  const verifier = createPkceVerifier();
  const state = createLoginState();
  const response = seeOther(nihoConnectUrl(config.nihoWebOrigin, { challenge: pkceChallenge(verifier), state, origin: siteOrigin(), audience: "host" }));
  setLoginCookie(response, { verifier, state, providerId, preparationCaseId: null, ...(invitationId ? { invitationId } : {}), ...(returnPath ? { returnPath } : {}), expiresAt: Date.now() + LOGIN_MAX_AGE_SECONDS * 1000 });
  return response;
}

/** NIHO's return to `/host/auth/callback` (see the sequence above). Failures carry a fixed reason only. */
export async function completeNihoLogin(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const login = decodeLoginState(loginSealer(), request.cookies.get(LOGIN_COOKIE)?.value, Date.now());
  if (!login) return failed("expired");
  if (!loginStatesMatch(login.state, params.get("state"))) return failed("state", login);
  if (params.has("error")) return failed("denied", login);
  const code = params.get("code");
  if (!code || code.length > MAX_CODE_LENGTH) return failed("rejected", login);
  const identities = hostAccountIdentities();
  const accounts = hostAccounts();
  if (!identities || !accounts) return failed("unavailable", login);

  const deps = nihoAuthDeps();
  const exchanged = await exchangeCode(deps, { code, codeVerifier: login.verifier });
  if (!exchanged.ok) return failed(exchanged.reason, login);
  const { accessToken, connectionId } = exchanged.value;
  try {
    const identity = await lookupNihoIdentity(accessToken);
    if (!identity.ok) return failed(identity.reason, login);
    const now = Date.now();
    let opened;
    try {
      // NIHO's `auth_time` is not in the identity answer: the person has just signed in (or confirmed) at NIHO for this
      // connection, so the sign-in is now. The sensitive changes that ask for a recent one read this time (#595).
      opened = await identities.startSessionForNihoIdentity({ nihoUserId: identity.nihoUserId, authenticatedAtUtc: nowUtc(now), nowUtc: nowUtc(now) });
    } catch (error) {
      console.error(`[host-auth] NIHO sign-in not opened: ${error instanceof Error ? error.name : "unknown error"}`);
      return failed("unavailable", login);
    }
    if (opened.kind === "not-linked") return failed("unregistered", login);
    if (opened.kind === "account-suspended") return failed("suspended", login);

    // The session this browser held before ends, with its devices' push (another account on a shared device, or the same
    // host signing in again). Best effort: the new session is open either way.
    const previous = request.cookies.get(ACCOUNT_SESSION_COOKIE)?.value;
    if (isOpaqueSecret(previous) && previous !== opened.sessionToken) {
      try {
        const ended = await accounts.readSession({ sessionToken: previous, nowUtc: nowUtc(now) });
        await accounts.revokeSession({ sessionToken: previous, nowUtc: nowUtc(now) });
        if (ended) await forgetHostPushConnection(ended.sessionRef);
      } catch {
        // It ends on its own (14 idle days at most).
      }
    }

    const returnPath = hostReturnPathOrNull(login.returnPath);
    const response = seeOther(login.invitationId ? hostInvitationPath(login.invitationId) : returnPath ?? withProvider(HOST_HOME_PATH, login.providerId));
    clearLoginCookie(response);
    setAccountSessionCookie(response, opened.sessionToken, opened.absoluteExpiresAtUtc, now);
    return response;
  } finally {
    // The connection only proved who the person is: end it now (best effort; NIHO's own expiry is the backstop).
    await deleteConnection(deps, connectionId, accessToken, { reason: null });
  }
}
