import type { FetchLike } from "../client.ts";

export const MOCK_EXPERIENCE_HOST_SERVICE_TOKEN = "synthetic-experience-service-token";

/** The contract mock is only for synthetic preview and tests; production always uses GoogleAuth's signed ID token. */
export function createMockExperienceHostFetch(options: {
  readonly nihoUserId?: string;
  readonly legacyProviderId?: string;
  readonly stripeAccountId?: string | null;
  readonly connectReady?: boolean;
  readonly reuseConsentAccepted?: boolean;
  readonly accessToken?: string;
  readonly serviceIdToken?: string;
} = {}): FetchLike {
  const nihoUserId = options.nihoUserId ?? "sample-niho-user";
  const legacyProviderId = options.legacyProviderId ?? "sample-provider-kitchen";
  const stripeAccountId = options.stripeAccountId === undefined ? "acct_synthetic12345678" : options.stripeAccountId;
  const connectReady = options.connectReady ?? true;
  const reuseConsentAccepted = options.reuseConsentAccepted ?? true;
  const accessToken = options.accessToken ?? "synthetic-niho-access-token";
  const serviceIdToken = options.serviceIdToken ?? MOCK_EXPERIENCE_HOST_SERVICE_TOKEN;
  const readinessReason = stripeAccountId === null ? "NOT_CONNECTED" : connectReady ? "READY" : "VERIFICATION_REQUIRED";
  return async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    if (init.method !== "GET" || headers.get("authorization") !== `Bearer ${accessToken}`
      || headers.get("x-niho-experience-service-id-token") !== serviceIdToken
      || init.credentials !== "omit" || init.cache !== "no-store" || init.redirect !== "error") {
      return Response.json({ error: { code: "FORBIDDEN" } }, { status: 403, headers: { "cache-control": "private, no-store" } });
    }
    if (url.pathname === "/api/experience-host/identity" && !url.search) {
      return Response.json({ nihoUserId, accountStatus: "ACTIVE" }, { headers: { "cache-control": "private, no-store" } });
    }
    const match = /^\/api\/experience-host\/legacy-providers\/([A-Za-z0-9_-]+)\/connect-account$/.exec(url.pathname);
    if (match && !url.search && match[1] === legacyProviderId) {
      return Response.json({
        legacyProviderId,
        stripeAccountId,
        readiness: { ready: stripeAccountId !== null && connectReady, reason: readinessReason },
        paymentReuseConsent: {
          accepted: reuseConsentAccepted,
          version: reuseConsentAccepted ? "synthetic-1" : null,
          consentedAt: reuseConsentAccepted ? "2026-11-04T00:00:00.000Z" : null,
        },
      }, { headers: { "cache-control": "private, no-store" } });
    }
    return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404, headers: { "cache-control": "private, no-store" } });
  };
}
