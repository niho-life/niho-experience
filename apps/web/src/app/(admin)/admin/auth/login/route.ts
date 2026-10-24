import type { NextRequest } from "next/server";
import { experienceAdminConnectUrl } from "@niho-experience/api-client/admin-auth";
import { config } from "@/lib/config";
import { createLoginState, createPkceVerifier, pkceChallenge } from "@/lib/host/pkce";
import {
  adminJson,
  isAdminHttp,
  setAdminHttpLoginCookie,
} from "@/lib/admin/server";
import { ADMIN_HTTP_LOGIN_MAX_AGE_SECONDS } from "@/lib/admin/http-session";
import { safeAdminReturnTo } from "@/lib/admin/routes";
import { NextResponse } from "next/server";

export function GET(request: NextRequest) {
  if (!isAdminHttp()) return adminJson({ error: "not_found" }, 404);
  const verifier = createPkceVerifier();
  const state = createLoginState();
  const response = new NextResponse(null, {
    status: 303,
    headers: {
      location: experienceAdminConnectUrl(config.nihoWebOrigin, {
        challenge: pkceChallenge(verifier),
        state,
        redirectOrigin: config.adminOrigin,
      }),
      "cache-control": "private, no-store",
    },
  });
  setAdminHttpLoginCookie(response, {
    verifier,
    state,
    returnTo: safeAdminReturnTo(request.nextUrl.searchParams.get("returnTo")),
    expiresAt: Date.now() + ADMIN_HTTP_LOGIN_MAX_AGE_SECONDS * 1000,
  });
  return response;
}
