import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { signInWithCustomToken } from "@/lib/host/niho-auth";
import { loginStatesMatch } from "@/lib/host/pkce";
import {
  EDITOR_LOGIN_COOKIE,
  decodeEditorLogin,
  startEditorSession,
} from "@/lib/editor/session";
import { EDITOR_AUTH_ERROR_PATH, EDITOR_GUIDES_PATH } from "@/lib/editor/routes";
import {
  clearEditorLoginCookie,
  editorAuthClient,
  editorJson,
  editorLoginSealer,
  isEditorConsole,
  setEditorSessionCookie,
} from "@/lib/editor/server";

const CODE = /^[A-Za-z0-9_-]{43}$/;

function failed() {
  const response = new NextResponse(null, {
    status: 303,
    headers: { location: EDITOR_AUTH_ERROR_PATH, "cache-control": "private, no-store" },
  });
  // An unsolicited or invalid callback must not log out a valid editor session.
  clearEditorLoginCookie(response);
  return response;
}

/** Consume code/state/PKCE server-side and leave no auth values in the URL. */
export async function GET(request: NextRequest) {
  if (!isEditorConsole()) return editorJson({ error: "not_found" }, 404);
  const login = decodeEditorLogin(editorLoginSealer(), request.cookies.get(EDITOR_LOGIN_COOKIE)?.value, Date.now());
  const state = request.nextUrl.searchParams.get("state");
  if (!login || !loginStatesMatch(login.state, state) || request.nextUrl.searchParams.has("error")) return failed();
  const code = request.nextUrl.searchParams.get("code");
  if (!code || !CODE.test(code)) return failed();

  const client = editorAuthClient();
  const exchanged = await client.exchangeCode({ code, codeVerifier: login.verifier });
  if (!exchanged.ok) return failed();
  const signedIn = await signInWithCustomToken(
    { fetch, nihoOrigin: config.nihoWebOrigin, firebaseWebApiKey: config.nihoFirebaseWebApiKey },
    exchanged.data.customToken,
    Date.now(),
  );
  if (!signedIn.ok) return failed();
  const verified = await client.verifySession(signedIn.value.idToken);
  if (
    !verified.ok
    || !verified.data.account.active
    || verified.data.connection.id !== exchanged.data.connectionId
    || verified.data.connection.expiresAt > exchanged.data.connectionExpiresAt
  ) return failed();

  const now = Date.now();
  const session = startEditorSession({
    refreshToken: exchanged.data.refreshToken,
    idToken: signedIn.value.idToken,
    idTokenExpiresAt: signedIn.value.idTokenExpiresAt,
    connectionId: exchanged.data.connectionId,
    exchangedConnectionExpiresAt: exchanged.data.connectionExpiresAt,
    verifiedConnectionExpiresAt: verified.data.connection.expiresAt,
    actorId: verified.data.actor.id,
  }, now);
  if (!session) return failed();

  const response = new NextResponse(null, {
    status: 303,
    headers: { location: EDITOR_GUIDES_PATH, "cache-control": "private, no-store" },
  });
  clearEditorLoginCookie(response);
  try {
    setEditorSessionCookie(response, session, now);
  } catch {
    return failed();
  }
  return response;
}
