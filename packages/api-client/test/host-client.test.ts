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
    const fetch = vi.fn(async () => Response.json({ legacyProviderId: "sample-provider-kitchen", stripeAccountId: null, readiness: { ready: false, reason: "NOT_CONNECTED" }, paymentReuseConsent: { accepted: false, version: null, consentedAt: null } }));
    const client = createExperienceHostApiClient({ ...OPTIONS, fetch });
    expect(await client.getLegacyConnectAccount("../owner")).toMatchObject({ ok: false, kind: "error", status: 404 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
