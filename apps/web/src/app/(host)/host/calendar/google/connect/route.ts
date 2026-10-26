import type { NextRequest } from "next/server";
import { googleAuthorizationUrl } from "@niho-experience/google-calendar";
import { config } from "@/lib/config";
import { googleRuntimeConfig } from "@/lib/experience/google-connection";
import { hostActor } from "@/lib/experience/host-actor";
import { encodeGoogleOAuthState, GOOGLE_OAUTH_COOKIE, GOOGLE_OAUTH_COOKIE_PATH, GOOGLE_OAUTH_MAX_AGE } from "@/lib/experience/google-oauth-state";
import { experienceStore } from "@/lib/experience/store-server";
import { createLoginState, createPkceVerifier, pkceChallenge } from "@/lib/host/pkce";
import { hostNotFound, isHostMock, noStoreJson, seeOther } from "@/lib/host/server";
import { hostCookieOptions } from "@/lib/host/session";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!config.hostConsoleEnabled || isHostMock()) return hostNotFound();
  const result = await hostActor(request.nextUrl.searchParams.get("providerId"));
  if ("response" in result) return result.response;
  const store = experienceStore();
  const google = googleRuntimeConfig();
  if (!store || !google) return noStoreJson({ error: "calendar_not_configured" }, 503);
  try {
    const membership = await store.verifyActiveMembership(result.actor);
    if (membership?.role !== "OWNER") return noStoreJson({ error: "forbidden" }, 403);
    const verifier = createPkceVerifier();
    const state = createLoginState();
    const response = seeOther(googleAuthorizationUrl(google.google, state, pkceChallenge(verifier)));
    response.cookies.set(GOOGLE_OAUTH_COOKIE, encodeGoogleOAuthState({ state, verifier, providerId: result.actor.providerId, nihoUserId: result.actor.nihoUserId, expiresAt: Date.now() + GOOGLE_OAUTH_MAX_AGE * 1000 }), hostCookieOptions(GOOGLE_OAUTH_COOKIE_PATH, GOOGLE_OAUTH_MAX_AGE));
    return response;
  } catch {
    return noStoreJson({ error: "calendar_unavailable" }, 503);
  }
}
