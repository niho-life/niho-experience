import "server-only";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import {
  createExperienceEditorAuthClient,
  type ExperienceEditorVerifiedSession,
} from "@niho-experience/api-client/editor-auth";
import { config } from "@/lib/config";
import { cookieSealer } from "@/lib/host/cookie-seal";
import { signInWithCustomToken } from "@/lib/host/niho-auth";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { ID_TOKEN_MIN_REMAINING_MS, REFRESH_WINDOW_MS } from "@/lib/host/timing";
import {
  EDITOR_LOGIN_COOKIE,
  EDITOR_LOGIN_MAX_AGE_SECONDS,
  EDITOR_LOGIN_PATH,
  EDITOR_SESSION_COOKIE,
  EDITOR_SESSION_PATH,
  decodeEditorSession,
  editorCookieOptions,
  editorSessionMaxAgeSeconds,
  encodeEditorLogin,
  encodeEditorSession,
  startEditorSession,
  type EditorLoginState,
  type EditorSession,
} from "./session";

export const isEditorConsole = () => config.apiMode === "http" && config.editorConsoleEnabled;

export function requireEditorConsole() {
  if (!isEditorConsole()) notFound();
}

export const editorSessionSealer = () => cookieSealer(config.editorSessionSecret, "editor-http-session");
export const editorLoginSealer = () => cookieSealer(config.editorSessionSecret, "editor-http-login");

export function editorAuthClient() {
  return createExperienceEditorAuthClient({ nihoWebOrigin: config.nihoWebOrigin, fetch });
}

export async function readEditorSession(): Promise<EditorSession | null> {
  if (!isEditorConsole()) return null;
  const jar = await cookies();
  return decodeEditorSession(editorSessionSealer(), jar.get(EDITOR_SESSION_COOKIE)?.value, Date.now());
}

export type EditorSessionLoad =
  | { status: "ok"; session: EditorSession; verified: ExperienceEditorVerifiedSession }
  | { status: "signed-out" }
  | { status: "refresh"; session: EditorSession }
  | { status: "rejected" }
  | { status: "error" };

/**
 * Call before every authenticated editor read or write. NIHO remains the
 * authority for both the connection and the account's current active state.
 */
export async function loadEditorSession(): Promise<EditorSessionLoad> {
  const session = await readEditorSession();
  if (!session) return { status: "signed-out" };
  const now = Date.now();
  if (session.idTokenExpiresAt - now <= ID_TOKEN_MIN_REMAINING_MS) return { status: "refresh", session };
  const verified = await editorAuthClient().verifySession(session.idToken);
  if (!verified.ok) return { status: verified.kind === "rejected" ? "rejected" : "error" };
  if (
    !verified.data.account.active
    || verified.data.actor.id !== session.actorId
    || verified.data.connection.id !== session.connectionId
    || verified.data.connection.expiresAt <= now
    || verified.data.connection.expiresAt > session.connectionExpiresAt
  ) return { status: "rejected" };
  return { status: "ok", session, verified: verified.data };
}

export type EditorRenewal =
  | { outcome: "refreshed"; session: EditorSession }
  | { outcome: "retryable"; session: EditorSession }
  | { outcome: "invalidated"; reason: "rejected" | "unavailable" };

/**
 * Rotate first, then verify account/connection again. If the rotation request
 * fails ambiguously, the old refresh token is never returned for reuse.
 */
export async function renewEditorSession(session: EditorSession): Promise<EditorRenewal> {
  const client = editorAuthClient();
  const refreshed = await client.refreshConnection(session.refreshToken);
  if (!refreshed.ok) return { outcome: "invalidated", reason: refreshed.kind };

  let rotated: EditorSession = {
    ...session,
    refreshToken: refreshed.data.refreshToken,
    connectionExpiresAt: Math.min(session.connectionExpiresAt, refreshed.data.connectionExpiresAt),
  };
  if (rotated.connectionExpiresAt <= Date.now()) return { outcome: "invalidated", reason: "rejected" };

  const signedIn = await signInWithCustomToken(
    { fetch, nihoOrigin: config.nihoWebOrigin, firebaseWebApiKey: config.nihoFirebaseWebApiKey },
    refreshed.data.customToken,
    Date.now(),
  );
  if (!signedIn.ok) {
    return signedIn.reason === "rejected"
      ? { outcome: "invalidated", reason: "rejected" }
      : { outcome: "retryable", session: rotated };
  }
  rotated = { ...rotated, idToken: signedIn.value.idToken, idTokenExpiresAt: signedIn.value.idTokenExpiresAt };

  const verified = await client.verifySession(rotated.idToken);
  if (!verified.ok) {
    return verified.kind === "rejected"
      ? { outcome: "invalidated", reason: "rejected" }
      : { outcome: "retryable", session: rotated };
  }
  if (
    !verified.data.account.active
    || verified.data.actor.id !== session.actorId
    || verified.data.connection.id !== session.connectionId
    || verified.data.connection.expiresAt > rotated.connectionExpiresAt
  ) return { outcome: "invalidated", reason: "rejected" };

  const renewed = startEditorSession({
    refreshToken: rotated.refreshToken,
    idToken: rotated.idToken,
    idTokenExpiresAt: rotated.idTokenExpiresAt,
    connectionId: rotated.connectionId,
    exchangedConnectionExpiresAt: rotated.connectionExpiresAt,
    verifiedConnectionExpiresAt: verified.data.connection.expiresAt,
    absoluteExpiresAt: session.expiresAt,
    actorId: verified.data.actor.id,
  }, Date.now());
  return renewed ? { outcome: "refreshed", session: renewed } : { outcome: "invalidated", reason: "rejected" };
}

export function setEditorSessionCookie(response: NextResponse, session: EditorSession, now: number) {
  response.cookies.set(
    EDITOR_SESSION_COOKIE,
    encodeEditorSession(editorSessionSealer(), session),
    editorCookieOptions(EDITOR_SESSION_PATH, editorSessionMaxAgeSeconds(session, now)),
  );
}

export function clearEditorSessionCookie(response: NextResponse) {
  response.cookies.set(EDITOR_SESSION_COOKIE, "", editorCookieOptions(EDITOR_SESSION_PATH, 0));
}

export function setEditorLoginCookie(response: NextResponse, login: EditorLoginState) {
  response.cookies.set(
    EDITOR_LOGIN_COOKIE,
    encodeEditorLogin(editorLoginSealer(), login),
    editorCookieOptions(EDITOR_LOGIN_PATH, EDITOR_LOGIN_MAX_AGE_SECONDS),
  );
}

export function clearEditorLoginCookie(response: NextResponse) {
  response.cookies.set(EDITOR_LOGIN_COOKIE, "", editorCookieOptions(EDITOR_LOGIN_PATH, 0));
}

export function editorRefreshDue(session: EditorSession, now: number): boolean {
  return session.idTokenExpiresAt - now < REFRESH_WINDOW_MS;
}

export function editorMutationAllowed(request: Request): boolean {
  return mutationFromSameOrigin(request.method, request.headers, config.editorOrigin);
}

export function editorJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
