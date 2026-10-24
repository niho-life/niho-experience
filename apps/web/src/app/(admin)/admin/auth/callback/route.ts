import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { signInWithCustomToken } from "@/lib/host/niho-auth";
import { loginStatesMatch } from "@/lib/host/pkce";
import {
  adminAuthClient,
  adminJson,
  adminHttpLoginSealer,
  clearAdminHttpLoginCookie,
  clearAdminHttpSessionCookie,
  isAdminHttp,
  setAdminHttpSessionCookie,
} from "@/lib/admin/server";
import { ADMIN_HTTP_LOGIN_COOKIE, decodeAdminHttpLogin, startAdminHttpSession } from "@/lib/admin/http-session";
import { ADMIN_AUTH_ERROR_PATH, safeAdminReturnTo } from "@/lib/admin/routes";

const CODE = /^[A-Za-z0-9_-]{43}$/;

function failed() {
  const response = new NextResponse(null, { status: 303, headers: { location: ADMIN_AUTH_ERROR_PATH, "cache-control": "private, no-store" } });
  clearAdminHttpLoginCookie(response);
  clearAdminHttpSessionCookie(response);
  return response;
}

/** Callback values are consumed server-side and always leave the browser on a query-free Admin URL. */
export async function GET(request: NextRequest) {
  if (!isAdminHttp()) return adminJson({ error: "not_found" }, 404);
  const login = decodeAdminHttpLogin(adminHttpLoginSealer(), request.cookies.get(ADMIN_HTTP_LOGIN_COOKIE)?.value, Date.now());
  const state = request.nextUrl.searchParams.get("state");
  if (!login || !loginStatesMatch(login.state, state) || request.nextUrl.searchParams.has("error")) return failed();
  const code = request.nextUrl.searchParams.get("code");
  if (!code || !CODE.test(code)) return failed();

  const client = adminAuthClient();
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
    || verified.data.connection.id !== exchanged.data.connectionId
    || verified.data.connection.expiresAt > exchanged.data.connectionExpiresAt
  ) return failed();

  const now = Date.now();
  const session = startAdminHttpSession({
    refreshToken: exchanged.data.refreshToken,
    idToken: signedIn.value.idToken,
    idTokenExpiresAt: signedIn.value.idTokenExpiresAt,
    connectionId: exchanged.data.connectionId,
    exchangedConnectionExpiresAt: exchanged.data.connectionExpiresAt,
    verifiedConnectionExpiresAt: verified.data.connection.expiresAt,
    actorId: verified.data.actor.id,
    actorName: verified.data.actor.displayName,
  }, now);
  if (!session) return failed();

  const response = new NextResponse(null, { status: 303, headers: { location: safeAdminReturnTo(login.returnTo), "cache-control": "private, no-store" } });
  clearAdminHttpLoginCookie(response);
  try {
    setAdminHttpSessionCookie(response, session, now);
  } catch {
    return failed();
  }
  return response;
}
