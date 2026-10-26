import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { exchangeCode, signInWithCustomToken } from "@/lib/host/niho-auth";
import { loginStatesMatch } from "@/lib/host/pkce";
import { HOST_AUTH_ERROR_PATH, HOST_HOME_PATH, withProvider, type LoginErrorReason } from "@/lib/host/routes";
import { clearLoginCookie, hostNotFound, loginSealer, nihoAuthDeps, seeOther, setSessionCookie } from "@/lib/host/server";
import { decodeLoginState, LOGIN_COOKIE, startSession } from "@/lib/host/session";

const MAX_CODE_LENGTH = 2048;

function failed(reason: LoginErrorReason) {
  const response = seeOther(`${HOST_AUTH_ERROR_PATH}?reason=${reason}`);
  clearLoginCookie(response);
  return response;
}

/**
 * NIHO returns here with `code` and `state`. The code, the tokens and the state
 * are never logged; failures only carry a fixed reason to the error page.
 */
export async function GET(request: NextRequest) {
  if (!config.hostConsoleEnabled) return hostNotFound();
  const params = request.nextUrl.searchParams;
  const login = decodeLoginState(loginSealer(), request.cookies.get(LOGIN_COOKIE)?.value, Date.now());
  if (!login) return failed("expired");
  if (!loginStatesMatch(login.state, params.get("state"))) return failed("state");
  if (params.has("error")) return failed("denied");
  const code = params.get("code");
  if (!code || code.length > MAX_CODE_LENGTH) return failed("rejected");

  const deps = nihoAuthDeps();
  const exchanged = await exchangeCode(deps, { code, codeVerifier: login.verifier });
  if (!exchanged.ok) return failed(exchanged.reason);
  // A fresh custom token that Firebase refuses is NIHO's or Firebase's problem, not the host's.
  const signedIn = await signInWithCustomToken(deps, exchanged.value.customToken, Date.now());
  if (!signedIn.ok) return failed("unavailable");

  const now = Date.now();
  const { nihoUserId, refreshToken, connectionId, connectionExpiresAt, displayName, iconUrl } = exchanged.value;
  const session = startSession({ nihoUserId, refreshToken, connectionId, connectionExpiresAt, displayName, iconUrl, ...signedIn.value }, now);
  const response = seeOther(withProvider(HOST_HOME_PATH, login.providerId));
  clearLoginCookie(response);
  try {
    setSessionCookie(response, session, now);
  } catch {
    return failed("unavailable");
  }
  return response;
}
