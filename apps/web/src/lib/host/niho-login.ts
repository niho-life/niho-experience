import "server-only";
import { type NextRequest, type NextResponse } from "next/server";
import type { NihoSessionResult } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { hostAccountIdentities, hostAccounts, hostInvitations } from "@/lib/experience/store-server";
import { clearInviteBindingCookie, isOpaqueSecret, linkBindingHash, nowUtc, readExperienceHostSession, setAccountSessionCookie } from "./accounts";
import { NIHO_REAUTHENTICATION_MAX_AGE_SECONDS, deleteConnection, exchangeCode, nihoConnectUrl } from "./niho-auth";
import type { NihoIdentityOutcome } from "./niho-identity";
import { loginStatesMatch, createLoginState, createPkceVerifier, pkceChallenge } from "./pkce";
import { nihoIdOrNull } from "./providers";
import { forgetHostPushConnection } from "./push/server";
import { HOST_AUTH_ERROR_PATH, HOST_HOME_PATH, hostAccountSettingsPath, hostInvitationPath, hostReturnPathOrNull, invitationIdOrNull, withProvider, withQuery, type LoginErrorReason } from "./routes";
import { clearLoginCookie, loginSealer, lookupNihoIdentity, nihoAuthDeps, seeOther, setLoginCookie, siteOrigin } from "./server";
import { ACCOUNT_SESSION_COOKIE, decodeLoginState, INVITE_BINDING_COOKIE, LOGIN_COOKIE, LOGIN_MAX_AGE_SECONDS, type HostLoginState } from "./session";

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
 * - invitation (`purpose: "invite"`, #596): the host opened an invitation link from ops. The return binds the NIHO account to
 *   the invited host account in the same transaction that uses the invitation up (the invitation belongs to the browser that
 *   opened it, whose binding cookie must come back), then opens that host account's session as a sign-in does.
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
export function startNihoLink(providerId: string | null, hostAccountId: string): NextResponse {
  // The host account that asked is part of the sealed state: the return binds to it and to no other.
  return nihoRoundTrip({ providerId, returnPath: hostAccountSettingsPath(providerId), purpose: "link", hostAccountId }, true);
}

/** The host opened an invitation link in this browser: the same round trip, which on return binds the NIHO account to the invited host account. */
export function startNihoInvite(request: NextRequest): NextResponse {
  // The link's page set the browser's binding cookie when it opened the invitation; without it there is nothing to bind to.
  if (!isOpaqueSecret(request.cookies.get(INVITE_BINDING_COOKIE)?.value)) return failed("invite-invalid");
  return nihoRoundTrip({ providerId: null, purpose: "invite" }, false);
}

function nihoRoundTrip(intent: Pick<HostLoginState, "providerId" | "invitationId" | "returnPath" | "purpose" | "hostAccountId">, reauth: boolean): NextResponse {
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

/**
 * When the person signed in at NIHO, as the store takes it: NIHO's `authTime`, never later than `now` (clock skew), so that
 * the recent-sign-in rule reads what NIHO says.
 */
function signedInAt(authTimeMs: number, now: number): string {
  return nowUtc(Math.min(now, authTimeMs));
}

type Verified<T> = { ok: true; value: T } | { ok: false; reason: "rejected" | "unavailable" | "unverified" };

/**
 * The NIHO round trip's proof and nothing else: the code is exchanged, Host v1 `identity` names the NIHO user ID, `run` runs
 * with it and with when the person signed in at NIHO (`authTime`, epoch ms), and the connection ends whatever happened. No
 * token is passed on or kept.
 *
 * Fails closed: an exchange answer without a readable `authTime` (a NIHO without niho-coliving/niho-app#20305, or an answer
 * that is not NIHO's) runs nothing: no session, no binding, no invitation used up. Without NIHO's sign-in time the
 * recent-sign-in rule (and a step-up asked for through `max_age`, which the browser can drop from the URL) cannot be judged.
 */
async function withNihoIdentity<T>(code: string, verifier: string, run: (nihoUserId: string, authTimeMs: number) => Promise<T>): Promise<Verified<T>> {
  const deps = nihoAuthDeps();
  const exchanged = await exchangeCode(deps, { code, codeVerifier: verifier });
  if (!exchanged.ok) return exchanged;
  const { accessToken, connectionId, authTimeUtc } = exchanged.value;
  try {
    const authTimeMs = authTimeUtc === null ? Number.NaN : Date.parse(authTimeUtc);
    if (!Number.isFinite(authTimeMs)) return { ok: false, reason: "unverified" };
    const identity = await lookupNihoIdentity(accessToken);
    if (!identity.ok) return identity;
    return { ok: true, value: await run(identity.nihoUserId, authTimeMs) };
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
  if (link) return completeNihoLink(request, login, code);
  return login.purpose === "invite" ? completeInvite(request, login, code) : completeSignIn(request, login, code);
}

async function completeSignIn(request: NextRequest, login: HostLoginState, code: string): Promise<NextResponse> {
  const identities = hostAccountIdentities();
  const accounts = hostAccounts();
  if (!identities || !accounts) return failed("unavailable", login);

  const verified = await withNihoIdentity(code, login.verifier, async (nihoUserId, authTimeMs) => {
    const now = Date.now();
    try {
      // The session's `authenticated_at` is when the person signed in at NIHO (`authTime`), so the sensitive changes that
      // ask for a recent sign-in read NIHO's time, not the time of this return.
      return { now, opened: await identities.startSessionForNihoIdentity({ nihoUserId, authenticatedAtUtc: signedInAt(authTimeMs, now), nowUtc: nowUtc(now) }) };
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
  return signedIn(request, login, accounts, opened, now);
}

/**
 * The session is open: the one this browser held before ends (with its devices' push: another account on a shared device, or
 * the same host signing in again; best effort, the new session is open either way), and the host goes where the sign-in was for.
 */
async function signedIn(request: NextRequest, login: HostLoginState, accounts: NonNullable<ReturnType<typeof hostAccounts>>, opened: Extract<NihoSessionResult, { kind: "ok" }>, now: number): Promise<NextResponse> {
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

/**
 * The return of an invitation's sign-in (#596): the NIHO account that came back is bound to the host account the invitation
 * was made for, and the invitation is used up, in one transaction; then the host account's session opens. A NIHO account
 * bound elsewhere or a host account bound to another NIHO account is told (the invitation stays usable); an invitation that
 * is not open for this browser is `invite-invalid`. A session that fails to open after the binding leaves the binding: the
 * host signs in with the NIHO button as everyone does.
 */
async function completeInvite(request: NextRequest, login: HostLoginState, code: string): Promise<NextResponse> {
  const invitations = hostInvitations();
  const identities = hostAccountIdentities();
  const accounts = hostAccounts();
  if (!invitations || !identities || !accounts) return failed("unavailable", login);
  const binding = request.cookies.get(INVITE_BINDING_COOKIE)?.value;
  if (!isOpaqueSecret(binding)) return failed("invite-invalid");

  const verified = await withNihoIdentity(code, login.verifier, async (nihoUserId, authTimeMs) => {
    const now = Date.now();
    let accepted;
    try {
      accepted = await invitations.acceptInvitation({ browserBindingHash: linkBindingHash(binding), nihoUserId, nowUtc: nowUtc(now) });
    } catch (error) {
      // The transaction rolled back: the invitation is still open.
      console.error(`[host-auth] invitation not accepted: ${error instanceof Error ? error.name : "unknown error"}`);
      return null;
    }
    if (accepted.kind !== "accepted") return { accepted, opened: null, now };
    // From here the invitation is used up and the NIHO account is bound: a failure to open the session leaves the binding.
    try {
      return { accepted, opened: await identities.startSessionForNihoIdentity({ nihoUserId, authenticatedAtUtc: signedInAt(authTimeMs, now), nowUtc: nowUtc(now) }), now };
    } catch (error) {
      console.error(`[host-auth] invitation's session not opened: ${error instanceof Error ? error.name : "unknown error"}`);
      return { accepted, opened: null, now };
    }
  });
  // Before the invitation was used up (NIHO failed, the store failed): it is still usable, and the retry goes through it.
  if (!verified.ok || verified.value === null) return failed("invite-unavailable");
  const { accepted, opened, now } = verified.value;
  switch (accepted.kind) {
    case "invalid": return failed("invite-invalid");
    case "identity-in-use": return failed("invite-in-use");
    case "account-has-identity": return failed("invite-has-identity");
    case "host-account-not-active": return failed("suspended");
    case "accepted": break;
  }
  // Used up and bound, but the session did not open: the invitation is gone, so the retry is the ordinary NIHO login.
  if (opened?.kind !== "ok") return failed("unavailable");
  const response = await signedIn(request, login, accounts, opened, now);
  clearInviteBindingCookie(response);
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
  // Another tab signed in as someone else meanwhile (a shared browser): nothing is bound to an account that did not ask.
  if (!login.hostAccountId || session.hostAccountId !== login.hostAccountId) return linkBack(login, "switched");

  const verified = await withNihoIdentity(code, login.verifier, async (nihoUserId, authTimeMs) => {
    const now = Date.now();
    try {
      // The store refuses a NIHO sign-in older than the recent-sign-in window (`recent-authentication-required`).
      return await identities.linkNihoIdentity({ hostAccountId: session.hostAccountId, nihoUserId, proof: { kind: "SESSION", sessionRef: session.sessionRef, nihoAuthenticatedAtUtc: signedInAt(authTimeMs, now) }, nowUtc: nowUtc(now) });
    } catch (error) {
      console.error(`[host-auth] NIHO account not linked: ${error instanceof Error ? error.name : "unknown error"}`);
      return null;
    }
  });
  if (!verified.ok) return linkBack(login, verified.reason === "unverified" ? "unverified" : "unavailable");
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
