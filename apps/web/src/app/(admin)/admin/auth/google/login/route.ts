import { NextResponse, type NextRequest } from "next/server";
import { googleSignInUrl } from "@niho-experience/google-calendar";
import { adminGoogleClient, ADMIN_GOOGLE_LOGIN_MAX_AGE_SECONDS, setAdminGoogleLoginCookie } from "@/lib/admin/google-login";
import { safeAdminReturnTo } from "@/lib/admin/routes";
import { adminJson, isAdminGoogleLogin } from "@/lib/admin/server";
import { createLoginState, createPkceVerifier, pkceChallenge } from "@/lib/host/pkce";
import { ADMIN_GOOGLE_HOSTED_DOMAIN } from "@/lib/resolve-config";

/**
 * Admin のログイン (ADR 0003, docs/admin-auth.md): sends the browser to Google's sign-in (`openid email`, PKCE S256, state,
 * nonce, `hd=niho.life` as a hint). The verifier, state and nonce wait in a sealed HttpOnly cookie on the Google auth
 * paths for 10 minutes. 404 unless EXPERIENCE_ADMIN_GOOGLE_LOGIN_ENABLED is on.
 */
export function GET(request: NextRequest) {
  if (!isAdminGoogleLogin()) return adminJson({ error: "not_found" }, 404);
  const client = adminGoogleClient();
  if (!client) return adminJson({ error: "unavailable" }, 503);
  const verifier = createPkceVerifier();
  const state = createLoginState();
  const nonce = createLoginState();
  const response = new NextResponse(null, {
    status: 303,
    headers: {
      location: googleSignInUrl(client, { state, nonce, codeChallenge: pkceChallenge(verifier), hostedDomain: ADMIN_GOOGLE_HOSTED_DOMAIN }),
      "cache-control": "private, no-store",
    },
  });
  setAdminGoogleLoginCookie(response, {
    verifier,
    state,
    nonce,
    returnTo: safeAdminReturnTo(request.nextUrl.searchParams.get("returnTo")),
    expiresAt: Date.now() + ADMIN_GOOGLE_LOGIN_MAX_AGE_SECONDS * 1000,
  });
  return response;
}
