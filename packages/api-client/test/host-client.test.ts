import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createExperienceHostApiClient } from "../src/host/index.ts";
import { createMockExperienceHostFetch, MOCK_EXPERIENCE_HOST_SERVICE_TOKEN } from "../src/host/mock.ts";

const ORIGIN = "https://niho.example";
const ACCESS = "synthetic-niho-access-token";
const OPTIONS = { nihoWebOrigin: ORIGIN, accessToken: ACCESS, serviceIdToken: MOCK_EXPERIENCE_HOST_SERVICE_TOKEN };

describe("NIHO host common client v1.0.0", () => {
  it("calls only identity and current Connect projection with both credentials and no-store transport", async () => {
    const fetch = createMockExperienceHostFetch();
    const client = createExperienceHostApiClient({ ...OPTIONS, fetch });
    expect(await client.getIdentity()).toEqual({ ok: true, data: { nihoUserId: "sample-niho-user", accountStatus: "ACTIVE" } });
    expect(await client.getLegacyConnectAccount("sample-provider-kitchen")).toEqual({
      ok: true,
      data: {
        legacyProviderId: "sample-provider-kitchen", stripeAccountId: "acct_synthetic12345678",
        readiness: { ready: true, reason: "READY" },
        paymentReuseConsent: { accepted: true, version: "synthetic-1", consentedAt: "2026-11-04T00:00:00.000Z" },
      },
    });
  });

  it("rejects unexpected fields, stale provider projection and consent/readiness contradictions", async () => {
    const json = (value: unknown) => vi.fn(async () => Response.json(value));
    const badIdentity = createExperienceHostApiClient({ ...OPTIONS, fetch: json({ nihoUserId: "someone", accountStatus: "ACTIVE", ownerUserId: "someone" }) });
    expect(await badIdentity.getIdentity()).toMatchObject({ ok: false, kind: "unexpected_response", status: 200 });
    const wrongOwner = createExperienceHostApiClient({ ...OPTIONS, fetch: json({ legacyProviderId: "another-provider", stripeAccountId: "acct_synthetic12345678", readiness: { ready: true, reason: "READY" }, paymentReuseConsent: { accepted: true, version: "v1", consentedAt: "2026-11-04T00:00:00.000Z" } }) });
    expect(await wrongOwner.getLegacyConnectAccount("sample-provider-kitchen")).toMatchObject({ ok: false, kind: "unexpected_response" });
    const inconsistent = createExperienceHostApiClient({ ...OPTIONS, fetch: json({ legacyProviderId: "sample-provider-kitchen", stripeAccountId: null, readiness: { ready: true, reason: "READY" }, paymentReuseConsent: { accepted: true, version: "v1", consentedAt: null } }) });
    expect(await inconsistent.getLegacyConnectAccount("sample-provider-kitchen")).toMatchObject({ ok: false, kind: "unexpected_response" });
  });

  it("rejects unsafe IDs and query keys before a request is sent", async () => {
    const fetch = vi.fn(async () => Response.json({ bookings: [], nextCursor: null }));
    const client = createExperienceHostApiClient({ ...OPTIONS, fetch });
    expect(await client.getLegacyConnectAccount("../owner")).toMatchObject({ ok: false, kind: "error", status: 404 });
    expect(await client.listLegacyProviderBookings("provider-a", { cursor: "cursor", unused: "x" } as never)).toMatchObject({ ok: false, kind: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps old NIHO booking lookup and refund cancellation inside the v1.0 allowlist", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ url: input, ...(init ? { init } : {}) });
      const cancel = new URL(input).pathname.endsWith("/cancel");
      return Response.json(cancel ? { status: "CANCELLED", refundedYen: 12000 } : { bookings: [], nextCursor: null }, { status: 200 });
    });
    const client = createExperienceHostApiClient({ ...OPTIONS, fetch });
    expect(await client.listLegacyProviderBookings("legacy-provider", { pageId: "legacy-page", status: "CONFIRMED" })).toEqual({ ok: true, data: { bookings: [], nextCursor: null } });
    expect(await client.cancelLegacyProviderBooking("legacy-provider", "legacy-page", "request-1", { refund: "FULL", reason: "HOST_CANNOT_HOST", message: "合成の理由" })).toEqual({ ok: true, data: { status: "CANCELLED", refundedYen: 12000 } });
    expect(calls[0]?.url).toBe(`${ORIGIN}/api/experience-providers/legacy-provider/bookings?pageId=legacy-page&status=CONFIRMED`);
    expect(calls[1]?.url).toBe(`${ORIGIN}/api/experience-providers/legacy-provider/pages/legacy-page/bookings/request-1/cancel`);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ refund: "FULL", reason: "HOST_CANNOT_HOST", message: "合成の理由" });
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
      expect(headers.get("x-niho-experience-service-id-token")).toBe(MOCK_EXPERIENCE_HOST_SERVICE_TOKEN);
      expect(call.init).toMatchObject({ cache: "no-store", credentials: "omit", redirect: "error" });
    }
  });
});
