import "server-only";
import { type NextRequest, type NextResponse } from "next/server";
import { config } from "@/lib/config";
import { hostAccountIdentities, hostAccounts } from "@/lib/experience/store-server";
import { isOpaqueSecret, nowUtc, readExperienceHostSession, setAccountSessionCookie } from "./accounts";
import { NIHO_REAUTHENTICATION_MAX_AGE_SECONDS, deleteConnection, exchangeCode, nihoConnectUrl } from "./niho-auth";
import type { NihoIdentityOutcome } from "./niho-identity";
import { loginStatesMatch, createLoginState, createPkceVerifier, pkceChallenge } from "./pkce";
import { nihoIdOrNull } from "./providers";
import { forgetHostPushConnection } from "./push/server";
import { HOST_AUTH_ERROR_PATH, HOST_HOME_PATH, hostAccountSettingsPath, hostInvitationPath, hostReturnPathOrNull, invitationIdOrNull, withProvider, withQuery, type LoginErrorReason } from "./routes";
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
 *
 * Two more uses of the same round trip (#595):
 * - re-login (`reauth=1`): a sensitive change asked for a recent sign-in; NIHO is asked to sign the person in again
 *   (`max_age`) and the return opens a new session whose `authenticated_at` is now.
 * - link (`purpose: "link"`): a signed-in host binds the NIHO account they come back with to their host account in 設定.
 *   The return opens no session; it adds the binding (the store checks the host's recent session and NIHO's recent sign-in).
 */

const MAX_CODE_LENGTH = 2048;

/** Back to the page that tells why, keeping the invitation the sign-in was for so "try again" returns to it. */
function failed(reason: LoginErrorReason, login: HostLoginState | null = null): NextResponse {
  const response = seeOther(withQuery(HOST_AUTH_ERROR_PATH, { reason, invitationId: login?.invitationId ?? null }));
  clearLoginCookie(response);
  return response;
}

/** 設定 › ログイン情報 with what happened to the binding. */
function linkBack(login: HostLoginState | null, outcome: NihoIdentityOutcome): NextResponse {
  const response = seeOther(withQuery(hostAccountSettingsPath(login?.providerId ?? null), { niho: outcome }));
  clearLoginCookie(response);
  return response;
}

/**
 * Starts the sign-in: the PKCE verifier and state go into a sealed 10-minute cookie, the host to NIHO's confirmation page.
 * Where to return is the invitation (a product operator's, which the sign-in comes back to accept) or an allowlisted page
 * (hostReturnPathOrNull: /write, 設定), never anything else. `reauth=1` asks NIHO to sign the person in again.
 */
export function startNihoLogin(request: NextRequest): NextResponse {
  const invitationId = invitationIdOrNull(request.nextUrl.searchParams.get("invitationId"));
  const returnPath = hostReturnPathOrNull(request.nextUrl.searchParams.get("returnTo"));
  const providerId = nihoIdOrNull(request.nextUrl.searchParams.get("providerId"));
  const reauth = request.nextUrl.searchParams.get("reauth") === "1";
  return nihoRoundTrip({ providerId, ...(invitationId ? { invitationId } : {}), ...(returnPath ? { returnPath } : {}) }, reauth);
}

/** A signed-in host's 「結び付ける」: the same round trip, which on return binds the NIHO account instead of opening a session. */
export function startNihoLink(providerId: string | null): NextResponse {
  return nihoRoundTrip({ providerId, returnPath: hostAccountSettingsPath(providerId), purpose: "link" }, true);
}

function nihoRoundTrip(intent: Pick<HostLoginState, "providerId" | "invitationId" | "returnPath" | "purpose">, reauth: boolean): NextResponse {
  const verifier = createPkceVerifier();
  const state = createLoginState();
  const response = seeOther(nihoConnectUrl(config.nihoWebOrigin, {
    challenge: pkceChallenge(verifier),
    state,
    origin: siteOrigin(),
    audience: "host",
    // A sign-in the host does not have to repeat is not asked again; a step-up always is (the window is NIHO_REAUTHENTICATION_MAX_AGE_SECONDS).
    ...(reauth ? { maxAgeSeconds: NIHO_REAUTHENTICATION_MAX_AGE_SECONDS } : {}),
  }));
  setLoginCookie(response, { verifier, state, preparationCaseId: null, ...intent, expiresAt: Date.now() + LOGIN_MAX_AGE_SECONDS * 1000 });
  return response;
}

type Verified<T> = { ok: true; value: T } | { ok: false; reason: "rejected" | "unavailable" };

/**
 * The NIHO round trip's proof and nothing else: the code is exchanged, Host v1 `identity` names the NIHO user ID, `run` runs
 * with it, and the connection ends whatever happened. No token is passed on or kept.
 */
async function withNihoIdentity<T>(code: string, verifier: string, run: (nihoUserId: string) => Promise<T>): Promise<Verified<T>> {
  const deps = nihoAuthDeps();
  const exchanged = await exchangeCode(deps, { code, codeVerifier: verifier });
  if (!exchanged.ok) return exchanged;
  const { accessToken, connectionId } = exchanged.value;
  try {
    const identity = await lookupNihoIdentity(accessToken);
    if (!identity.ok) return identity;
    return { ok: true, value: await run(identity.nihoUserId) };
  } finally {
    // The connection only proved who the person is: end it now (best effort; NIHO's own expiry is the backstop).
    await deleteConnection(deps, connectionId, accessToken, { reason: null });
  }
}

/** NIHO's return to `/host/auth/callback` (see the sequence above). Failures carry a fixed reason only. */
export async function completeNihoLogin(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const login = decodeLoginState(loginSealer(), request.cookies.get(LOGIN_COOKIE)?.value, Date.now());
  if (!login) return failed("expired");
  const link = login.purpose === "link";
  if (!loginStatesMatch(login.state, params.get("state"))) return link ? linkBack(login, "unavailable") : failed("state", login);
  if (params.has("error")) return link ? linkBack(login, "denied") : failed("denied", login);
  const code = params.get("code");
  if (!code || code.length > MAX_CODE_LENGTH) return link ? linkBack(login, "unavailable") : failed("rejected", login);
  return link ? completeNihoLink(request, login, code) : completeSignIn(request, login, code);
}

async function completeSignIn(request: NextRequest, login: HostLoginState, code: string): Promise<NextResponse> {
  const identities = hostAccountIdentities();
  const accounts = hostAccounts();
  if (!identities || !accounts) return failed("unavailable", login);

  const verified = await withNihoIdentity(code, login.verifier, async (nihoUserId) => {
    const now = Date.now();
    try {
      // NIHO's `auth_time` is not in the identity answer: the person has just signed in (or confirmed) at NIHO for this
      // connection, so the sign-in is now. A step-up asked NIHO to sign them in again (`max_age`, a few minutes), which
      // bounds how far back the real sign-in can be. The sensitive changes that ask for a recent one read this time.
      return { now, opened: await identities.startSessionForNihoIdentity({ nihoUserId, authenticatedAtUtc: nowUtc(now), nowUtc: nowUtc(now) }) };
    } catch (error) {
      console.error(`[host-auth] NIHO sign-in not opened: ${error instanceof Error ? error.name : "unknown error"}`);
      return null;
    }
  });
  if (!verified.ok) return failed(verified.reason, login);
  if (verified.value === null) return failed("unavailable", login);
  const { now, opened } = verified.value;
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
}

/** The return of a host's 「結び付ける」: binds the NIHO account to the host account of the session that is open. */
async function completeNihoLink(request: NextRequest, login: HostLoginState, code: string): Promise<NextResponse> {
  const identities = hostAccountIdentities();
  if (!identities) return linkBack(login, "unavailable");
  let session: Awaited<ReturnType<typeof readExperienceHostSession>>;
  try { session = await readExperienceHostSession(request.cookies.get(ACCOUNT_SESSION_COOKIE)?.value); }
  catch { return linkBack(login, "unavailable"); }
  // The session ended while the host was at NIHO: sign in again, then bind from 設定.
  if (!session) return failed("expired");

  const verified = await withNihoIdentity(code, login.verifier, async (nihoUserId) => {
    const now = nowUtc();
    try {
      return await identities.linkNihoIdentity({ hostAccountId: session.hostAccountId, nihoUserId, proof: { kind: "SESSION", sessionRef: session.sessionRef, nihoAuthenticatedAtUtc: now }, nowUtc: now });
    } catch (error) {
      console.error(`[host-auth] NIHO account not linked: ${error instanceof Error ? error.name : "unknown error"}`);
      return null;
    }
  });
  if (!verified.ok) return linkBack(login, "unavailable");
  const result = verified.value;
  if (result === null) return linkBack(login, "unavailable");
  switch (result.kind) {
    case "linked": return linkBack(login, "linked");
    case "already-linked": return linkBack(login, "already-linked");
    case "identity-in-use": return linkBack(login, "identity-in-use");
    case "account-has-identity": return linkBack(login, "account-has-identity");
    case "recent-authentication-required": return linkBack(login, "reauth");
    case "host-account-not-active": return linkBack(login, "unavailable");
  }
}
