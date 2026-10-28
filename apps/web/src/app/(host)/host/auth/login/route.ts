import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { nihoConnectUrl } from "@/lib/host/niho-auth";
import { createLoginState, createPkceVerifier, pkceChallenge } from "@/lib/host/pkce";
import { nihoIdOrNull } from "@/lib/host/providers";
import { HOST_MOCK_LOGIN_PATH, preparationCaseIdOrNull } from "@/lib/host/routes";
import { hostNotFound, isHostMock, seeOther, setLoginCookie, siteOrigin } from "@/lib/host/server";
import { LOGIN_MAX_AGE_SECONDS } from "@/lib/host/session";

/**
 * Starts "NIHO でログイン": PKCE verifier and state in a 10-minute sealed cookie, then NIHO's confirmation page.
 * `?surface=app` comes from the installed app's start page (#177); the session it ends in carries that mark.
 */
export function GET(request: NextRequest) {
  if (!config.hostConsoleEnabled) return hostNotFound();
  const providerId = nihoIdOrNull(request.nextUrl.searchParams.get("providerId"));
  const preparationCaseId = preparationCaseIdOrNull(request.nextUrl.searchParams.get("preparationCaseId"));
  const surface = request.nextUrl.searchParams.get("surface") === "app" ? "app" : undefined;

  if (isHostMock()) {
    // Preview: no NIHO round trip; a synthetic session is made locally.
    const params = new URLSearchParams();
    if (providerId) params.set("providerId", providerId);
    if (preparationCaseId) params.set("preparationCaseId", preparationCaseId);
    if (request.nextUrl.searchParams.get("mock") === "empty") params.set("mock", "empty");
    if (surface) params.set("surface", surface);
    return seeOther(params.size ? `${HOST_MOCK_LOGIN_PATH}?${params}` : HOST_MOCK_LOGIN_PATH);
  }

  const verifier = createPkceVerifier();
  const state = createLoginState();
  const response = seeOther(nihoConnectUrl(config.nihoWebOrigin, { challenge: pkceChallenge(verifier), state, origin: siteOrigin() }));
  setLoginCookie(response, { verifier, state, providerId, preparationCaseId, ...(surface ? { surface } : {}), expiresAt: Date.now() + LOGIN_MAX_AGE_SECONDS * 1000 });
  return response;
}
