import "server-only";
import { OAuth2Client, type TokenPayload } from "google-auth-library";

/**
 * Service-to-service calls into the internal routes (guide administration, the host push job): a
 * Google-signed OIDC ID token for one service account and one audience, never a cookie or session.
 */
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export interface GoogleIdentityClaims {
  readonly iss: string;
  readonly aud: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly exp: number;
}

export type GoogleTokenVerification =
  | { readonly ok: true; readonly claims: GoogleIdentityClaims }
  | { readonly ok: false; readonly kind: "invalid" | "outage" };

export interface GoogleTokenVerifier {
  verify(token: string, audience: string): Promise<GoogleTokenVerification>;
}

export interface GoogleServiceIdentitySettings {
  readonly audience: string;
  readonly serviceAccountEmail: string;
}

const googleClient = new OAuth2Client();

function tokenPayloadClaims(payload: TokenPayload): GoogleIdentityClaims {
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

export const googleIdTokenVerifier: GoogleTokenVerifier = {
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

/** JSON for an internal route: never cached, sniffed or indexed. */
export function internalServiceJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/**
 * The bearer token is the configured service account's, for this audience, from Google, and not
 * expired. `outage` when Google's signing keys cannot be fetched (the caller answers 503).
 */
export async function verifyGoogleServiceIdentity(
  request: Pick<Request, "headers">,
  settings: GoogleServiceIdentitySettings,
  verifier: GoogleTokenVerifier = googleIdTokenVerifier,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly kind: "invalid" | "outage" }> {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  if (!match) return { ok: false, kind: "invalid" };
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

/** The 401 or 503 an internal route answers for a failed identity check. */
export function serviceIdentityFailure(kind: "invalid" | "outage"): Response {
  return kind === "outage"
    ? internalServiceJson({ error: "identity_verification_unavailable" }, 503)
    : internalServiceJson({ error: "invalid_identity" }, 401);
}
