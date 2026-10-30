import "server-only";
import { OAuth2Client, type TokenPayload } from "google-auth-library";

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/** Claims kept from a Google-signed OIDC ID token (for example Cloud Scheduler or a NIHO server). */
export interface GoogleServiceIdentityClaims {
  readonly iss: string;
  readonly aud: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly exp: number;
}

export type GoogleServiceTokenVerification =
  | { readonly ok: true; readonly claims: GoogleServiceIdentityClaims }
  | { readonly ok: false; readonly kind: "invalid" | "outage" };

export interface GoogleServiceTokenVerifier {
  verify(token: string, audience: string): Promise<GoogleServiceTokenVerification>;
}

export interface GoogleServiceIdentitySettings {
  readonly audience: string;
  readonly serviceAccountEmail: string;
}

/** `missing` and `invalid` are both unauthenticated; only `outage` means the verifier itself is unavailable. */
export type GoogleServiceIdentityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: "missing" | "invalid" | "outage" };

const googleClient = new OAuth2Client();

function tokenPayloadClaims(payload: TokenPayload): GoogleServiceIdentityClaims {
  return {
    iss: payload.iss,
    aud: payload.aud,
    ...(payload.email === undefined ? {} : { email: payload.email }),
    ...(payload.email_verified === undefined ? {} : { emailVerified: payload.email_verified }),
    exp: payload.exp,
  };
}

function isVerificationOutage(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; cause?: { code?: unknown }; response?: { status?: unknown } };
  const networkCodes = [
    "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "ENETDOWN", "ENETUNREACH", "EAI_AGAIN", "ETIMEDOUT",
  ];
  if (typeof record.code === "string" && networkCodes.includes(record.code)) return true;
  if (typeof record.cause?.code === "string" && networkCodes.includes(record.cause.code)) return true;
  const status = record.response?.status;
  // verifyIdToken validates malformed/expired/wrong-claim tokens locally. An HTTP
  // response here belongs to Google's signing-key retrieval and is an outage.
  return typeof status === "number";
}

export const googleServiceTokenVerifier: GoogleServiceTokenVerifier = {
  async verify(token, audience) {
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: token, audience });
      const payload = ticket.getPayload();
      return payload === undefined ? { ok: false, kind: "invalid" } : { ok: true, claims: tokenPayloadClaims(payload) };
    } catch (error) {
      return { ok: false, kind: isVerificationOutage(error) ? "outage" : "invalid" };
    }
  },
};

/**
 * Accepts only a Google-issued ID token for the exact audience and verified
 * service-account email. Cookies, session roles, and other bearer formats are
 * never consulted.
 */
export async function verifyGoogleServiceIdentity(
  request: Pick<Request, "headers">,
  settings: GoogleServiceIdentitySettings,
  verifier: GoogleServiceTokenVerifier = googleServiceTokenVerifier,
): Promise<GoogleServiceIdentityResult> {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  if (!match) return { ok: false, kind: "missing" };
  const verified = await verifier.verify(match[1]!, settings.audience);
  if (!verified.ok) return { ok: false, kind: verified.kind };
  const claims = verified.claims;
  if (
    !GOOGLE_ISSUERS.has(claims.iss)
    || claims.aud !== settings.audience
    || claims.emailVerified !== true
    || claims.email !== settings.serviceAccountEmail
    || !Number.isSafeInteger(claims.exp)
    || claims.exp <= Math.floor(Date.now() / 1000)
  ) {
    return { ok: false, kind: "invalid" };
  }
  return { ok: true };
}
