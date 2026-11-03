import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {
    hostConsoleEnabled: true,
    apiMode: "http",
    experiencePublicationsEnabled: true,
    experiencePublicationConsentVersion: "listing-v1",
  },
  boundary: vi.fn(),
  mutationAllowed: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/host/server", () => ({
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: {
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
  } }),
}));
vi.mock("./publication-host-boundary", () => ({
  publicationHostBoundary: mocks.boundary,
  publicationHostMutationAllowed: mocks.mutationAllowed,
}));

import { GET, PATCH } from "@/app/(host)/host/api/publication/providers/[providerId]/products/[productId]/route";
import { POST as publish } from "@/app/(host)/host/api/publication/providers/[providerId]/products/[productId]/publish/route";
import { POST as stop } from "@/app/(host)/host/api/publication/providers/[providerId]/products/[productId]/stop/route";
import { GET as preview } from "@/app/(host)/host/api/publication/providers/[providerId]/products/[productId]/preview/route";
import { GET as readSaleTerms, PATCH as saveSaleTerms } from "@/app/(host)/host/api/publication/providers/[providerId]/products/[productId]/sale-terms/route";

const context = { params: Promise.resolve({ providerId: "provider-1", productId: "product-1" }) };
const draft = {
  slug: "sample-experience",
  publicTitle: "Sample experience",
  content: { description: "Synthetic description", meetingPointDisclosure: "AFTER_BOOKING" },
  currency: "JPY",
  unitAmount: 8_000,
  cancellationTermsRef: "terms-v1",
};
const saleTerms = {
  childPricing: null,
  minimumParticipants: 1,
  minimumChargeableParticipants: 1,
  privateBooking: false,
  maxPartySize: 6,
  cancellationPolicy: "CUSTOM",
  cancellationWindowMinutesBeforeStart: 90,
  cancellationRefundBasisPoints: 3_750,
  minimumAttendance: null,
  bookingQuestions: [],
  conditionsVersion: null,
};

function request(method = "GET", body?: unknown, options: { query?: string; headers?: Record<string, string>; rawBody?: string } = {}) {
  const headers = {
    origin: "https://experience.example",
    "sec-fetch-site": "same-origin",
    ...(body === undefined && options.rawBody === undefined ? {} : { "content-type": "application/json" }),
    ...options.headers,
  };
  return new Request(`https://experience.example/host/api/publication/providers/provider-1/products/product-1${options.query ?? ""}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : options.rawBody !== undefined ? { body: options.rawBody } : {}),
  });
}

describe("Experience publication host API contract", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("EXPERIENCE_HOST_PUBLICATION_API_ENABLED", "true");
    Object.assign(mocks.config, {
      hostConsoleEnabled: true,
      apiMode: "http",
      experiencePublicationsEnabled: true,
      experiencePublicationConsentVersion: "listing-v1",
    });
    mocks.mutationAllowed.mockReturnValue(true);
    mocks.boundary.mockImplementation(async () => Response.json(
      { error: { code: "AUTH_CONTRACT_UNAVAILABLE" } },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    ));
  });

  it("routes draft, preview, sale terms, publish and stop through the operation boundary", async () => {
    const readResponse = await GET(request(), context);
    expect(readResponse.status).toBe(503);
    expect(await readResponse.json()).toEqual({ error: { code: "AUTH_CONTRACT_UNAVAILABLE" } });
    expect(mocks.boundary).toHaveBeenLastCalledWith("provider-1", "READ");

    await preview(request(), context);
    expect(mocks.boundary).toHaveBeenLastCalledWith("provider-1", "READ");
    await readSaleTerms(request(), context);
    expect(mocks.boundary).toHaveBeenLastCalledWith("provider-1", "READ");

    await PATCH(request("PATCH", {
      expectedDraftVersion: 2,
      expectedStateVersion: 3,
      draft,
    }), context);
    expect(mocks.boundary).toHaveBeenLastCalledWith("provider-1", "EDIT");

    await saveSaleTerms(request("PATCH", {
      expectedDraftVersion: 2,
      expectedStateVersion: 3,
      expectedSaleTermsVersion: 1,
      saleTerms,
    }), context);
    expect(mocks.boundary).toHaveBeenLastCalledWith("provider-1", "EDIT");

    await publish(request("POST", {
      expectedDraftVersion: 2,
      expectedStateVersion: 3,
      consentVersion: "listing-v1",
      accepted: true,
    }), context);
    expect(mocks.boundary).toHaveBeenLastCalledWith("provider-1", "OWNER");

    await stop(request("POST", { expectedStateVersion: 3 }), context);
    expect(mocks.boundary).toHaveBeenLastCalledWith("provider-1", "OWNER");
    expect(mocks.boundary).toHaveBeenCalledTimes(7);
  });

  it("does not enable routes unless all server flags are on", async () => {
    vi.stubEnv("EXPERIENCE_HOST_PUBLICATION_API_ENABLED", "");
    expect((await GET(request(), context)).status).toBe(404);
    vi.stubEnv("EXPERIENCE_HOST_PUBLICATION_API_ENABLED", "true");
    mocks.config.experiencePublicationsEnabled = false;
    expect((await GET(request(), context)).status).toBe(404);
    mocks.config.experiencePublicationsEnabled = true;
    mocks.config.apiMode = "mock";
    expect((await GET(request(), context)).status).toBe(404);
    expect(mocks.boundary).not.toHaveBeenCalled();
  });

  it("rejects query strings, malformed identifiers, wrong content type, malformed JSON and oversized JSON", async () => {
    expect((await GET(request("GET", undefined, { query: "?userId=owner-1" }), context)).status).toBe(404);
    const invalidContext = { params: Promise.resolve({ providerId: "../provider", productId: "product-1" }) };
    expect((await GET(request(), invalidContext)).status).toBe(404);
    expect((await PATCH(request("PATCH", {}, { headers: { "content-type": "text/plain" } }), context)).status).toBe(400);
    expect((await PATCH(request("PATCH", undefined, { rawBody: "{" }), context)).status).toBe(400);
    expect((await PATCH(request("PATCH", undefined, { rawBody: `{"value":"${"x".repeat(256 * 1024)}"}` }), context)).status).toBe(413);
    expect(mocks.boundary).not.toHaveBeenCalled();
  });

  it("rejects cross-origin mutations before reaching the identity boundary", async () => {
    mocks.mutationAllowed.mockReturnValue(false);
    const response = await PATCH(request("PATCH", {
      expectedDraftVersion: 1,
      expectedStateVersion: null,
      draft,
    }), context);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "FORBIDDEN" } });
    expect(mocks.boundary).not.toHaveBeenCalled();
  });

  it.each([
    ["draft extra identity field", () => PATCH(request("PATCH", {
      expectedDraftVersion: 1, expectedStateVersion: null, draft: { ...draft, ownerUserId: "synthetic-user" },
    }), context)],
    ["missing CAS version", () => PATCH(request("PATCH", { expectedDraftVersion: 1, draft }), context)],
    ["unknown root field", () => PATCH(request("PATCH", {
      expectedDraftVersion: 1, expectedStateVersion: null, draft, ownerUserId: "synthetic-user",
    }), context)],
    ["unknown sale terms field", () => saveSaleTerms(request("PATCH", {
      expectedDraftVersion: 1, expectedStateVersion: null, expectedSaleTermsVersion: null,
      saleTerms: { ...saleTerms, stripeConnectAccountRef: "acct_synthetic" },
    }), context)],
    ["incomplete cancellation pair", () => saveSaleTerms(request("PATCH", {
      expectedDraftVersion: 1, expectedStateVersion: null, expectedSaleTermsVersion: null,
      saleTerms: { ...saleTerms, cancellationRefundBasisPoints: undefined },
    }), context)],
    ["custom cancellation requires an explicit pair", () => saveSaleTerms(request("PATCH", {
      expectedDraftVersion: 1, expectedStateVersion: null, expectedSaleTermsVersion: null,
      saleTerms: { ...saleTerms, cancellationWindowMinutesBeforeStart: undefined, cancellationRefundBasisPoints: undefined },
    }), context)],
    ["invalid sale terms values", () => saveSaleTerms(request("PATCH", {
      expectedDraftVersion: 1, expectedStateVersion: null, expectedSaleTermsVersion: null,
      saleTerms: { ...saleTerms, minimumParticipants: 7 },
    }), context)],
    ["stop accepts only state CAS", () => stop(request("POST", { expectedStateVersion: 3, operationsSuspended: false }), context)],
    ["publish accepts only consent and versions", () => publish(request("POST", {
      expectedDraftVersion: 2, expectedStateVersion: 3, consentVersion: "listing-v1", accepted: true,
      readiness: true,
    }), context)],
  ])("rejects invalid mutation body: %s", async (_name, send) => {
    expect((await send()).status).toBe(400);
    expect(mocks.boundary).not.toHaveBeenCalled();
  });

  it("requires current explicit publication consent", async () => {
    const payload = { expectedDraftVersion: 2, expectedStateVersion: 3, consentVersion: "listing-v1", accepted: true };
    const declined = await publish(request("POST", { ...payload, accepted: false }), context);
    expect(declined.status).toBe(422);
    expect(await declined.json()).toEqual({ error: { code: "PUBLICATION_BLOCKED", blockers: ["CONSENT_REQUIRED"] } });

    const stale = await publish(request("POST", { ...payload, consentVersion: "listing-v0" }), context);
    expect(stale.status).toBe(422);
    expect(await stale.json()).toEqual({ error: { code: "PUBLICATION_BLOCKED", blockers: ["CONSENT_OUTDATED"] } });
    expect(mocks.boundary).not.toHaveBeenCalled();
  });
});
