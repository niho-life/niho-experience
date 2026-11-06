/**
 * Google sign-in (OpenID Connect, authorization code + PKCE) on the Calendar OAuth client, for Experience's own Admin
 * login (ADR 0003 decision 4). Only `openid email` is asked for; of the token answer only the ID token is returned (the
 * caller verifies it), and nothing from it is kept.
 */
import { boundedJson, GoogleCalendarError, googleRequest as request, nonEmpty } from "./http.ts";

export const GOOGLE_SIGN_IN_SCOPES = ["openid", "email"] as const;

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const MAX_ID_TOKEN_LENGTH = 8_192;

export interface GoogleSignInClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
}

export interface GoogleSignInRequest {
  /** Echoed back to the callback; the caller keeps it (and the rest) in a short-lived sealed HttpOnly cookie. */
  state: string;
  /** Echoed back inside the ID token. */
  nonce: string;
  /** S256 challenge of the verifier the caller keeps. */
  codeChallenge: string;
  /** Google Workspace domain hint (`hd`); the caller still checks the token's `hd` claim. */
  hostedDomain: string;
}

/** The URL that sends the browser to Google's sign-in, asking for `openid email` only (no offline access). */
export function googleSignInUrl(client: Pick<GoogleSignInClient, "clientId" | "redirectUri">, input: GoogleSignInRequest): string {
  if (!input.state || !input.nonce || !input.codeChallenge || !input.hostedDomain) throw new TypeError("OAuth state, nonce, PKCE challenge and hosted domain are required");
  const url = new URL(GOOGLE_AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: GOOGLE_SIGN_IN_SCOPES.join(" "),
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    hd: input.hostedDomain,
    prompt: "select_account",
  }).toString();
  return url.href;
}

/**
 * Exchanges a sign-in code for its ID token, unverified: the caller verifies its signature and claims. The access token
 * in the same answer is dropped. GoogleCalendarError for a refused code (REVOKED), an outage (UNAVAILABLE) or a
 * malformed answer (INVALID_RESPONSE).
 */
export async function exchangeGoogleSignInCode(client: GoogleSignInClient, code: string, codeVerifier: string): Promise<string> {
  const response = await request(client, GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: client.redirectUri,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GoogleCalendarError(response.status >= 400 && response.status < 500 ? "REVOKED" : "UNAVAILABLE");
  }
  const body = await boundedJson(response);
  if (!nonEmpty(body.id_token) || body.id_token.length > MAX_ID_TOKEN_LENGTH) throw new GoogleCalendarError("INVALID_RESPONSE");
  return body.id_token;
}
