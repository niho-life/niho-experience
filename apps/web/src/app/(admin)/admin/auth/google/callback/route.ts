import { NextResponse, type NextRequest } from "next/server";
import { adminActorIdForGoogleSubject } from "@niho-experience/experience-store";
import { exchangeGoogleSignInCode } from "@niho-experience/google-calendar";
import {
  ADMIN_GOOGLE_LOGIN_COOKIE,
  ADMIN_GOOGLE_SESSION_COOKIE,
  adminEmailAllowed,
  adminGoogleClient,
  clearAdminGoogleLoginCookie,
  decodeAdminGoogleLogin,
  isAdminSessionToken,
  nowUtc,
  setAdminGoogleSessionCookie,
  verifyAdminGoogleIdToken,
} from "@/lib/admin/google-login";
import { ADMIN_AUTH_ERROR_PATH, safeAdminReturnTo } from "@/lib/admin/routes";
import { adminJson, clearNihoAdminHttpSessionCookie, isAdminGoogleLogin } from "@/lib/admin/server";
import { adminSessions } from "@/lib/experience/store-server";
import { loginStatesMatch } from "@/lib/host/pkce";

/** Google's authorization codes: printable ASCII, bounded. */
const CODE = /^[\x21-\x7E]{1,2048}$/;

function seeOther(location: string) {
  return new NextResponse(null, { status: 303, headers: { location, "cache-control": "private, no-store" } });
}

/** Every refusal looks the same and leaves the browser on a query-free page; the sign-in's cookie goes. */
function failed() {
  const response = seeOther(ADMIN_AUTH_ERROR_PATH);
  clearAdminGoogleLoginCookie(response);
  return response;
}

/**
 * Admin のログイン (ADR 0003, docs/admin-auth.md): the code is exchanged server-side (PKCE), the ID token verified
 * (signature against Google's keys, audience, issuer, expiry, nonce, a verified address, `hd` = niho.life) and its
 * address checked against EXPERIENCE_ADMIN_ALLOWED_EMAILS. Only then a session opens in the experience DB; the cookie
 * holds its opaque token. Nothing from Google is kept. 404 unless EXPERIENCE_ADMIN_GOOGLE_LOGIN_ENABLED is on.
 */
export async function GET(request: NextRequest) {
  if (!isAdminGoogleLogin()) return adminJson({ error: "not_found" }, 404);
  const login = decodeAdminGoogleLogin(request.cookies.get(ADMIN_GOOGLE_LOGIN_COOKIE)?.value, Date.now());
  const query = request.nextUrl.searchParams;
  if (!login || query.has("error") || !loginStatesMatch(login.state, query.get("state"))) return failed();
  const code = query.get("code");
  if (!code || !CODE.test(code)) return failed();
  const client = adminGoogleClient();
  const store = adminSessions();
  if (!client || !store) return failed();

  let idToken: string;
  try {
    idToken = await exchangeGoogleSignInCode(client, code, login.verifier);
  } catch {
    return failed();
  }
  const verified = await verifyAdminGoogleIdToken(idToken, { clientId: client.clientId, nonce: login.nonce, now: Date.now() });
  if (!verified.ok || !adminEmailAllowed(verified.identity.email)) return failed();

  const previous = request.cookies.get(ADMIN_GOOGLE_SESSION_COOKIE)?.value;
  let opened;
  try {
    // A session this browser held before ends: a sign-in always starts a new one.
    if (isAdminSessionToken(previous)) await store.revokeSession({ sessionToken: previous, nowUtc: nowUtc() });
    opened = await store.openSession({
      adminActorId: adminActorIdForGoogleSubject(verified.identity.sub),
      email: verified.identity.email,
      nowUtc: nowUtc(),
    });
  } catch {
    return failed();
  }

  const response = seeOther(safeAdminReturnTo(login.returnTo));
  clearAdminGoogleLoginCookie(response);
  clearNihoAdminHttpSessionCookie(response);
  setAdminGoogleSessionCookie(response, opened.sessionToken, opened.absoluteExpiresAtUtc);
  return response;
}
