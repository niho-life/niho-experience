import "server-only";
import { type NextRequest, type NextResponse } from "next/server";
import type { NihoSessionResult } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { hostAccountIdentities, hostAccounts, hostInvitations, hostTeamInvitations, travelerAccounts } from "@/lib/experience/store-server";
import { clearInviteBindingCookie, clearTeamInviteBindingCookie, isOpaqueSecret, linkBindingHash, nowUtc, readExperienceHostSession, setAccountSessionCookie } from "./accounts";
import { NIHO_REAUTHENTICATION_MAX_AGE_SECONDS, deleteConnection, exchangeCode, nihoConnectUrl, type NihoConnectAudience, type NihoConnectMethod, type NihoConnectPrompt } from "./niho-auth";
import { exchangeNihoIdentity, nihoIdentityAuthorizationUrl, nihoIdentityRedirectUri } from "./niho-identity-login";
import type { NihoIdentityOutcome } from "./niho-identity";
import { loginStatesMatch, createLoginState, createPkceVerifier, pkceChallenge } from "./pkce";
import { nihoIdOrNull } from "./providers";
import { forgetHostPushConnection } from "./push/server";
import { clearReturningHostCookie, setReturningHostCookie } from "./returning-host";
import { HOST_AUTH_ERROR_PATH, HOST_HOME_PATH, HOST_START_PATH, hostAccountSettingsPath, hostInvitationPath, hostReturnPathOrNull, invitationIdOrNull, withProvider, withQuery, type LoginErrorReason } from "./routes";
import { clearLoginCookie, hostNotFound, loginSealer, lookupNihoIdentity, nihoAuthDeps, seeOther, setLoginCookie, setRegistrationCookie, siteOrigin } from "./server";
import { TRAVELER_HOME_PATH, TRAVELER_SIGN_IN_PATH, type TravelerLoginError } from "@/lib/traveler/paths";
import { TRAVELER_LOGIN_HINT_COOKIE, TRAVELER_SESSION_COOKIE } from "@/lib/traveler/session";
import { clearTravelerLoginHint, isTravelerSessionToken, setTravelerLoginHint, setTravelerSessionCookie } from "@/lib/traveler/server";
import { ACCOUNT_SESSION_COOKIE, decodeLoginState, INVITE_BINDING_COOKIE, LOGIN_COOKIE, LOGIN_MAX_AGE_SECONDS, REGISTRATION_MAX_AGE_SECONDS, TEAM_INVITE_BINDING_COOKIE, type HostLoginState } from "./session";

/*
 * 「NIHO アカウントでログイン」 (Epic #591, #594, EXPERIENCE_HOST_NIHO_LOGIN_ENABLED): NIHO only proves who the host is.
 *
 *   /host/auth/login → NIHO's confirmation page (PKCE challenge, state, the host audience)
 *   NIHO → /host/auth/callback?code&state
 *     1. exchange the code on the server using the verifier in the sealed 10-minute login cookie
 *     2. verify the ID token against NIHO's JWKS and the sealed nonce
 *     3. open an Experience session for the account bound to the verified NIHO user ID
 *
 * No NIHO token leaves this function: not into a cookie, the database, a log or a URL. The session is the Experience one
 * (`__Host-niho_host_account_session`, Path=/, so /write sees it too). A NIHO account no host account is bound to gets
 * the 「ホストに登録されていません」 page and nothing of Experience's changes.
 *
 * Two more uses of the same round trip (#595):
 * - account switch (`switch=1`, #632): 「別の方法でやり直す」 asks NIHO for its confirmation, where the account is switched
 *   (`prompt=select_account`), even when NIHO would pass a host it knows straight back. Behind EXPERIENCE_NIHO_LOGIN_PROMPT_ENABLED.
 * - re-login (`reauth=1`): a sensitive change asked for a recent sign-in; NIHO is asked to sign the person in again
 *   (`max_age`) and the return opens a new session whose `authenticated_at` is now.
 * - link (`purpose: "link"`): a signed-in host binds the NIHO account they come back with to their host account in 設定.
 *   The return opens no session; it adds the binding (the store checks the host's recent session and NIHO's recent sign-in).
 * - invitation (`purpose: "invite"`, #596): the host opened an invitation link from ops. The return binds the NIHO account to
 *   the invited host account in the same transaction that uses the invitation up (the invitation belongs to the browser that
 *   opened it, whose binding cookie must come back), then opens that host account's session as a sign-in does.
 * - team invitation (`purpose: "team-invite"`, #636): a person opened an invitation of a provider's OWNER. The return finds or
 *   makes their host account, adds it to the team as COHOST and uses the invitation up in one transaction (the invitation
 *   belongs to the browser that opened it), then opens that account's session at the provider's home.
 * - registration (`intent=register`, `purpose: "register"`, #708, EXPERIENCE_HOST_SELF_REGISTRATION_ENABLED): the same sign-in. A NIHO
 *   account no host account is bound to (with the flag on, from any host sign-in, not only this intent) is not turned away:
 *   what NIHO proved goes into a sealed 30-minute cookie and the host goes on to /host/start. Nothing is created until the form is sent.
 * - traveler (`purpose: "traveler"`, #597): a traveler logs in or signs up with Google, Apple or LINE (`audience=guest`, a
 *   `method`): NIHO goes straight to that provider and makes the NIHO account on the way. The return opens the traveler's
 *   own account and session (another table and cookie than a host's), never a host account's, and failures go to the
 *   traveler's English entrance, not the host console's pages.
 */

const MAX_CODE_LENGTH = 2048;

/** Back to the page that tells why, keeping the invitation the sign-in was for so "try again" returns to it. */
function failed(reason: LoginErrorReason, login: HostLoginState | null = null): NextResponse {
  const response = seeOther(withQuery(HOST_AUTH_ERROR_PATH, { reason, invitationId: login?.invitationId ?? null }));
  clearLoginCookie(response);
  // The next visit shows the entrance instead of going to NIHO by itself again (#632).
  clearReturningHostCookie(response);
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
  // 「ホストとして登録」 (#708): the sign-in is the same; the intent only says where a NIHO account with no host account goes. Without the flag it means nothing.
  const register = config.hostSelfRegistrationEnabled && request.nextUrl.searchParams.get("intent") === "register";
  return nihoRoundTrip({ providerId, ...(invitationId ? { invitationId } : {}), ...(returnPath ? { returnPath } : {}), ...(register ? { purpose: "register" as const } : {}) }, reauth, hostTarget(request));
}

/** The host's audience, with NIHO's account choice asked for when 「別の方法でやり直す」 sent the host here (#632). */
function hostTarget(request: NextRequest): { audience: NihoConnectAudience; prompt?: NihoConnectPrompt } {
  const switchAccount = config.nihoLoginPromptEnabled && request.nextUrl.searchParams.get("switch") === "1";
  return { audience: "host", ...(switchAccount ? { prompt: "select_account" as const } : {}) };
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
  return nihoRoundTrip({ providerId: null, purpose: "invite" }, false, hostTarget(request));
}

/** A person opened a team invitation link in this browser (#636): the same round trip, which on return joins them to the team. */
export function startNihoTeamInvite(request: NextRequest): NextResponse {
  if (!isOpaqueSecret(request.cookies.get(TEAM_INVITE_BINDING_COOKIE)?.value)) return failed("team-invite-invalid");
  return nihoRoundTrip({ providerId: null, purpose: "team-invite" }, false, hostTarget(request));
}

/**
 * A traveler's way in (#597): to NIHO with `audience=guest` and, for a method they pressed, straight to that provider. No method
 * is the existing NIHO account's way in (NIHO's own login screen). The traveler's pages are English and never name NIHO.
 */
export function startTravelerLogin(method: NihoConnectMethod | null): NextResponse {
  const response = nihoRoundTrip({ providerId: null, purpose: "traveler" }, false, { audience: "guest", ...(method ? { method } : {}) });
  setTravelerLoginHint(response);
  return response;
}

function nihoRoundTrip(intent: Pick<HostLoginState, "providerId" | "invitationId" | "returnPath" | "purpose" | "hostAccountId">, reauth: boolean, target: { audience: NihoConnectAudience; method?: NihoConnectMethod; prompt?: NihoConnectPrompt } = { audience: "host" }): NextResponse {
  const verifier = createPkceVerifier();
  const state = createLoginState();
  const maxAgeSeconds = reauth ? NIHO_REAUTHENTICATION_MAX_AGE_SECONDS : undefined;
  const nihoIdentity = config.nihoIdentityLoginEnabled ? { nonce: createLoginState(), maxAgeSeconds } : undefined;
  const start = {
    challenge: pkceChallenge(verifier),
    state,
    ...target,
  };
  const response = seeOther(nihoIdentity
    ? nihoIdentityAuthorizationUrl(config.nihoWebOrigin, { ...start, ...nihoIdentity, redirectUri: nihoIdentityRedirectUri(siteOrigin()) })
    : nihoConnectUrl(config.nihoWebOrigin, {
      ...start, origin: siteOrigin(), ...(reauth ? { maxAgeSeconds: NIHO_REAUTHENTICATION_MAX_AGE_SECONDS } : {}),
    }));
  setLoginCookie(response, {
    verifier, state, preparationCaseId: null, ...intent, ...(nihoIdentity ? { nihoIdentity } : {}),
    expiresAt: Date.now() + LOGIN_MAX_AGE_SECONDS * 1000,
  });
  return response;
}

/**
 * When the person signed in at NIHO, as the store takes it: NIHO's `authTime`, never later than `now` (clock skew), so that
 * the recent-sign-in rule reads what NIHO says.
 */
function signedInAt(authTimeMs: number, now: number): string {
  return nowUtc(Math.min(now, authTimeMs));
}

/**
 * What NIHO says about the person besides who they are: the name the app-connect exchange returns (null from the identity login,
 * whose ID token has none). Used for the registration form's first value only; it is never logged, counted or kept beyond the cookie.
 */
interface NihoProfile {
  readonly displayName: string | null;
}

type Verified<T> = { ok: true; value: T } | { ok: false; reason: "rejected" | "unavailable" | "unverified" };

/**
 * Only the verified stable user ID and sign-in time reach the Experience session and binding code.
 * The feature flag selects the protocol for the entire round trip, including after a rejected exchange.
 */
async function withNihoIdentity<T>(code: string, login: HostLoginState, run: (nihoUserId: string, authTimeMs: number, profile: NihoProfile) => Promise<T>): Promise<Verified<T>> {
  const deps = nihoAuthDeps();
  if (config.nihoIdentityLoginEnabled) {
    if (!login.nihoIdentity) return { ok: false, reason: "unverified" };
    const verified = await exchangeNihoIdentity(deps, {
      ...login.nihoIdentity, code, verifier: login.verifier, redirectUri: nihoIdentityRedirectUri(siteOrigin()),
    });
    if (!verified.ok) return verified;
    return { ok: true, value: await run(verified.value.nihoUserId, verified.value.authTimeMs, { displayName: null }) };
  }
  if (login.nihoIdentity) return { ok: false, reason: "unverified" };
  const exchanged = await exchangeCode(deps, { code, codeVerifier: login.verifier });
  if (!exchanged.ok) return exchanged;
  const { accessToken, connectionId, authTimeUtc, displayName } = exchanged.value;
  try {
    const authTimeMs = authTimeUtc === null ? Number.NaN : Date.parse(authTimeUtc);
    if (!Number.isFinite(authTimeMs)) return { ok: false, reason: "unverified" };
    const identity = await lookupNihoIdentity(accessToken);
    if (!identity.ok) return identity;
    return { ok: true, value: await run(identity.nihoUserId, authTimeMs, { displayName: displayName || null }) };
  } finally {
    // The connection only proved who the person is: end it now (best effort; NIHO's own expiry is the backstop).
    await deleteConnection(deps, connectionId, accessToken, { reason: null });
  }
}

function onlyQueryValue(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  return values.length === 1 ? values[0] ?? null : null;
}

/** Back to the traveler's entrance with what went wrong, in words that name no NIHO account. */
function travelerFailed(reason: TravelerLoginError): NextResponse {
  const response = seeOther(withQuery(TRAVELER_SIGN_IN_PATH, { error: reason }));
  clearLoginCookie(response);
  clearTravelerLoginHint(response);
  return response;
}

/**
 * NIHO's return to `/host/auth/callback` (see the sequence above). Failures carry a fixed reason only. `host`: the host
 * console's NIHO login is on; a return for a host purpose is a 404 without it (a traveler's return still goes through).
 */
export async function completeNihoLogin(request: NextRequest, options: { host: boolean } = { host: true }): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const login = decodeLoginState(loginSealer(), request.cookies.get(LOGIN_COOKIE)?.value, Date.now());
  if (!login) return config.travelerAccountsEnabled && request.cookies.has(TRAVELER_LOGIN_HINT_COOKIE) ? travelerFailed("expired") : failed("expired");
  if (login.purpose === "traveler") return config.travelerAccountsEnabled ? completeTravelerSignIn(request, login) : hostNotFound();
  if (!options.host) return hostNotFound();
  const link = login.purpose === "link";
  if (!loginStatesMatch(login.state, onlyQueryValue(params, "state"))) return link ? linkBack(login, "unavailable") : failed("state", login);
  if (params.has("error")) return link ? linkBack(login, "denied") : failed("denied", login);
  const code = onlyQueryValue(params, "code");
  if (!code || code.length > MAX_CODE_LENGTH) return link ? linkBack(login, "unavailable") : failed("rejected", login);
  if (link) return completeNihoLink(request, login, code);
  if (login.purpose === "team-invite") return config.hostTeamInvitationsEnabled ? completeTeamInvite(request, login, code) : failed("team-invite-unavailable");
  return login.purpose === "invite" ? completeInvite(request, login, code) : completeSignIn(request, login, code);
}

async function completeSignIn(request: NextRequest, login: HostLoginState, code: string): Promise<NextResponse> {
  const identities = hostAccountIdentities();
  const accounts = hostAccounts();
  if (!identities || !accounts) return failed("unavailable", login);

  const verified = await withNihoIdentity(code, login, async (nihoUserId, authTimeMs, profile) => {
    const now = Date.now();
    // What a NIHO account with no host account takes to the registration (#708); only used when the flag is on and nothing is bound.
    const registration = { nihoUserId, authTimeMs, displayName: profile.displayName };
    try {
      // The session's `authenticated_at` is when the person signed in at NIHO (`authTime`), so the sensitive changes that
      // ask for a recent sign-in read NIHO's time, not the time of this return.
      let opened = await identities.startSessionForNihoIdentity({ nihoUserId, authenticatedAtUtc: signedInAt(authTimeMs, now), nowUtc: nowUtc(now) });
      const writerReturn = config.nihoWriterEnabled && hostReturnPathOrNull(login.returnPath)?.startsWith("/write") === true;
      if (opened.kind === "not-linked" && writerReturn) {
        let authority;
        try {
          const { checkNihoArticleAuthority } = await import("@/lib/article-authority/server");
          authority = await checkNihoArticleAuthority(nihoUserId, []);
        }
        catch { return { now, opened, registration, writerFailure: "writer-unavailable" as const }; }
        if (!authority.writer) return { now, opened, registration, writerFailure: "writer-revoked" as const };
        opened = await identities.startWriterSessionForNihoIdentity({ nihoUserId, authenticatedAtUtc: signedInAt(authTimeMs, now), nowUtc: nowUtc(now) });
      }
      return { now, opened, registration };
    } catch (error) {
      console.error(`[host-auth] NIHO sign-in not opened: ${error instanceof Error ? error.name : "unknown error"}`);
      return null;
    }
  });
  if (!verified.ok) return failed(verified.reason, login);
  if (verified.value === null) return failed("unavailable", login);
  if ("writerFailure" in verified.value && verified.value.writerFailure) return failed(verified.value.writerFailure, login);
  const { now, opened, registration } = verified.value;
  if (opened.kind === "not-linked") return config.hostSelfRegistrationEnabled ? startRegistration(registration, now) : failed("unregistered", login);
  if (opened.kind === "account-suspended") return failed("suspended", login);
  return signedIn(request, login, accounts, opened, now);
}

/**
 * 「ホストとして登録」 (#708): NIHO verified the person and no host account is bound to them. Nothing is created; what NIHO proved
 * (the user ID, when they signed in there, the name it gave) goes into a sealed 30-minute cookie and the host goes on to the
 * registration screen. No session is opened and the returning-host mark is not set: only the registration makes them a host.
 */
function startRegistration(registration: { nihoUserId: string; authTimeMs: number; displayName: string | null }, now: number): NextResponse {
  const response = seeOther(HOST_START_PATH);
  clearLoginCookie(response);
  setRegistrationCookie(response, {
    nihoUserId: registration.nihoUserId,
    // Never later than the return: the store reads it as the time of the sign-in.
    authTimeMs: Math.min(now, registration.authTimeMs),
    displayName: registration.displayName,
    expiresAt: now + REGISTRATION_MAX_AGE_SECONDS * 1000,
  });
  return response;
}

/**
 * The session is open: the one this browser held before ends (with its devices' push: another account on a shared device, or
 * the same host signing in again; best effort, the new session is open either way), and the host goes where the sign-in was for.
 */
async function signedIn(request: NextRequest, login: HostLoginState, accounts: NonNullable<ReturnType<typeof hostAccounts>>, opened: Extract<NihoSessionResult, { kind: "ok" }>, now: number): Promise<NextResponse> {
  await endPreviousSession(request, accounts, opened, now);
  const returnPath = hostReturnPathOrNull(login.returnPath);
  const response = seeOther(login.invitationId ? hostInvitationPath(login.invitationId) : returnPath ?? withProvider(HOST_HOME_PATH, login.providerId));
  clearLoginCookie(response);
  setSignedInCookies(response, opened, now);
  return response;
}

/** The session this browser held before ends, with its devices' push (another account on a shared device, or the same host again; best effort). */
export async function endPreviousSession(request: NextRequest, accounts: NonNullable<ReturnType<typeof hostAccounts>>, opened: Pick<Extract<NihoSessionResult, { kind: "ok" }>, "sessionToken">, now: number): Promise<void> {
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
}

/** The new session's cookie, and the returning-host mark. */
export function setSignedInCookies(response: NextResponse, opened: Pick<Extract<NihoSessionResult, { kind: "ok" }>, "sessionToken" | "absoluteExpiresAtUtc">, now: number): void {
  setAccountSessionCookie(response, opened.sessionToken, opened.absoluteExpiresAtUtc, now);
  // When this session runs out, the console signs the host in again by itself (#632). Writers get the mark too: their
  // console pages use the same Experience host account session.
  setReturningHostCookie(response);
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

  const verified = await withNihoIdentity(code, login, async (nihoUserId, authTimeMs) => {
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

/**
 * The return of a team invitation's sign-in (#636): the NIHO account that came back is joined to the provider's team as COHOST
 * (its host account is found or made by the store) and the invitation is used up, in one transaction; then that host account's
 * session opens and the person lands at the provider's home. A refusal changes nothing and the invitation stays usable. A
 * session that fails to open after joining leaves the membership: the person signs in with the NIHO button as everyone does.
 */
async function completeTeamInvite(request: NextRequest, login: HostLoginState, code: string): Promise<NextResponse> {
  const invitations = hostTeamInvitations();
  const identities = hostAccountIdentities();
  const accounts = hostAccounts();
  if (!invitations || !identities || !accounts) return failed("team-invite-unavailable");
  const binding = request.cookies.get(TEAM_INVITE_BINDING_COOKIE)?.value;
  if (!isOpaqueSecret(binding)) return failed("team-invite-invalid");

  const verified = await withNihoIdentity(code, login, async (nihoUserId, authTimeMs) => {
    const now = Date.now();
    let accepted;
    try {
      accepted = await invitations.accept({ browserBindingHash: linkBindingHash(binding), nihoUserId, nowUtc: nowUtc(now) });
    } catch (error) {
      // The transaction rolled back: the invitation is still open.
      console.error(`[host-auth] team invitation not accepted: ${error instanceof Error ? error.name : "unknown error"}`);
      return null;
    }
    if (accepted.kind !== "accepted") return { accepted, opened: null, now };
    try {
      return { accepted, opened: await identities.startSessionForNihoIdentity({ nihoUserId, authenticatedAtUtc: signedInAt(authTimeMs, now), nowUtc: nowUtc(now) }), now };
    } catch (error) {
      console.error(`[host-auth] team invitation's session not opened: ${error instanceof Error ? error.name : "unknown error"}`);
      return { accepted, opened: null, now };
    }
  });
  if (!verified.ok || verified.value === null) return failed("team-invite-unavailable");
  const { accepted, opened, now } = verified.value;
  switch (accepted.kind) {
    case "invalid": return failed("team-invite-invalid");
    case "host-account-not-active": return failed("suspended");
    case "email-account-has-identity": return failed("team-invite-mismatch");
    case "accepted": break;
  }
  // Joined, but the session did not open: the invitation is used up, so the retry is the ordinary NIHO login.
  if (opened?.kind !== "ok") return failed("unavailable");
  const response = await signedIn(request, { ...login, providerId: accepted.providerId }, accounts, opened, now);
  clearTeamInviteBindingCookie(response);
  return response;
}

/**
 * The return of a traveler's log in (#597): the account of the NIHO user ID that came back (made now when it is the first
 * time) and a session of it, in the traveler's own cookie. NIHO's sign-in time is the session's `authenticated_at` and an unverified return opens nothing.
 */
async function completeTravelerSignIn(request: NextRequest, login: HostLoginState): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  if (!loginStatesMatch(login.state, onlyQueryValue(params, "state"))) return travelerFailed("unavailable");
  if (params.has("error")) return travelerFailed("denied");
  const code = onlyQueryValue(params, "code");
  if (!code || code.length > MAX_CODE_LENGTH) return travelerFailed("unavailable");
  const travelers = travelerAccounts();
  if (!travelers) return travelerFailed("unavailable");

  const verified = await withNihoIdentity(code, login, async (nihoUserId, authTimeMs) => {
    const now = Date.now();
    try {
      return { now, result: await travelers.signInWithNihoIdentity({ nihoUserId, authenticatedAtUtc: signedInAt(authTimeMs, now), nowUtc: nowUtc(now) }) };
    } catch (error) {
      console.error(`[traveler-auth] sign-in not opened: ${error instanceof Error ? error.name : "unknown error"}`);
      return null;
    }
  });
  if (!verified.ok) return travelerFailed(verified.reason === "rejected" ? "expired" : "unavailable");
  if (verified.value === null) return travelerFailed("unavailable");
  const { now, result } = verified.value;
  if (result.kind === "account-suspended") return travelerFailed("suspended");

  // The session this browser held before ends (another traveler on a shared device, or the same one logging in again).
  const previous = request.cookies.get(TRAVELER_SESSION_COOKIE)?.value;
  if (isTravelerSessionToken(previous) && previous !== result.sessionToken) {
    try { await travelers.revokeSession({ sessionToken: previous, nowUtc: nowUtc(now) }); }
    catch { /* It ends on its own (14 idle days at most). */ }
  }
  const response = seeOther(TRAVELER_HOME_PATH);
  clearLoginCookie(response);
  clearTravelerLoginHint(response);
  setTravelerSessionCookie(response, result.sessionToken, result.absoluteExpiresAtUtc, now);
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

  const verified = await withNihoIdentity(code, login, async (nihoUserId, authTimeMs) => {
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
