import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";

const mocks = vi.hoisted(() => ({
  config: { hostConsoleEnabled: true, apiMode: "http" }, session: vi.fn(), usable: vi.fn(), providers: vi.fn(),
  membership: vi.fn(), product: vi.fn(), state: vi.fn(), save: vi.fn(), stop: vi.fn(), publish: vi.fn(), pool: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/host/session", () => ({ accessTokenUsable: mocks.usable }));
vi.mock("@/lib/host/server", () => ({
  readHostSession: mocks.session, loadHostProviders: mocks.providers, siteOrigin: () => "https://experience.example",
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: {
    "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow",
  } }),
}));
vi.mock("@/lib/experience/store-server", () => ({
  experiencePool: mocks.pool,
  experienceStore: () => ({ verifyActiveMembership: mocks.membership, getProduct: mocks.product }),
}));
vi.mock("@niho-experience/experience-store", async (original) => ({
  ...await original<typeof import("@niho-experience/experience-store")>(),
  ExperiencePublicationRepository: class {
    getState = mocks.state; saveDraft = mocks.save; stop = mocks.stop; publish = mocks.publish;
  },
}));

import { GET, PATCH } from "@/app/(host)/host/api/publication/providers/[providerId]/products/[productId]/route";
import { POST as publish } from "@/app/(host)/host/api/publication/providers/[providerId]/products/[productId]/publish/route";
import { POST as stop } from "@/app/(host)/host/api/publication/providers/[providerId]/products/[productId]/stop/route";
import { GET as preview } from "@/app/(host)/host/api/publication/providers/[providerId]/products/[productId]/preview/route";

const context = { params: Promise.resolve({ providerId: "provider-1", productId: "product-1" }) };
const actor = { providerId: "provider-1", nihoUserId: "owner-1", calendarRoleCeiling: "OWNER" };
const draft = {
  slug: "sample", publicTitle: "Sample", currency: "JPY", unitAmount: 1000, cancellationTermsRef: "terms-v1",
  content: {
    lead: "Lead", description: "Description", facts: { language: "English", meetingAddress: "SECRET_ADDRESS" },
    highlights: [], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [],
    meetingOverview: "Kamakura area", meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: {
      name: "SECRET_MEETING_NAME", address: "SECRET_ADDRESS", access: "SECRET_ACCESS", mapUrl: "SECRET_MAP",
    }, entranceInstructions: "SECRET_ENTRANCE", sellerNihoAccountRef: "CONTENT_ACCOUNT_REF",
  },
};
const product = {
  ...draft, id: "product-1", providerId: "provider-1", status: "PUBLISHED", version: 2, updatedAtUtc: "2026-11-03T00:00:00.000Z",
  sellerNihoAccountRef: "SECRET_ACCOUNT", stripeConnectAccountRef: "SECRET_CONNECT", sellerDisplayName: "Seller",
};
const state = {
  providerId: "provider-1", productId: "product-1", currentPublicationId: 12345,
  selfStoppedAtUtc: null, operationsSuspendedAtUtc: "2026-11-03T00:00:00.000Z", operationsSuspensionCode: "SECRET_OPS_CODE",
  ownerResumeRequired: true, firstPublishedAtUtc: "2026-11-02T00:00:00.000Z", version: 3, updatedAtUtc: "2026-11-03T00:00:00.000Z",
};
const command = { expectedDraftVersion: 2, expectedStateVersion: 3, consentAccepted: true };
function request(method = "GET", body?: unknown, headers?: Record<string, string>, query = "") {
  return new Request(`https://experience.example/host/api/publication/providers/provider-1/products/product-1${query}`, {
    method, headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("Experience publication owner BFF", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  beforeEach(() => {
    vi.clearAllMocks(); vi.unstubAllEnvs();
    vi.stubEnv("EXPERIENCE_HOST_PUBLICATION_API_ENABLED", "true");
    vi.stubEnv("EXPERIENCE_PUBLICATION_CONSENT_VERSION", "approved-test-v1");
    mocks.config.hostConsoleEnabled = true; mocks.config.apiMode = "http";
    mocks.session.mockResolvedValue({ accessToken: "SECRET_TOKEN" }); mocks.usable.mockReturnValue(true);
    mocks.providers.mockResolvedValue({ status: "ok", providers: [{ id: "provider-1", ownerUserId: "owner-1", memberRole: "OWNER" }] });
    mocks.pool.mockReturnValue({}); mocks.membership.mockResolvedValue({ ...actor, role: "OWNER", active: true });
    mocks.product.mockResolvedValue(product); mocks.state.mockResolvedValue(state);
    mocks.save.mockResolvedValue({ draft: { ...product, version: 3 }, publicationUpdated: false, blockers: ["PHOTOS_REQUIRED"] });
    mocks.stop.mockResolvedValue({ ...state, selfStoppedAtUtc: "2026-11-03T01:00:00.000Z", version: 4 });
  });

  it("reads draft/state for the exact fresh OWNER with private headers and no server refs", async () => {
    const response = await GET(request(), context); const body = await response.json();
    expect(response.status).toBe(200); expect(mocks.membership).toHaveBeenCalledWith(actor);
    expect(mocks.product).toHaveBeenCalledWith(actor, "product-1");
    expect(body.publication).toMatchObject({ hasPublication: true, operationsSuspended: true, ownerResumeRequired: true, version: 3 });
    expect(body.requiredConsentVersion).toBe("approved-test-v1");
    for (const secret of ["SECRET_TOKEN", "SECRET_ACCOUNT", "SECRET_CONNECT", "SECRET_OPS_CODE", "owner-1", "12345"]) expect(JSON.stringify(body)).not.toContain(secret);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it.each(["EDITOR", "COHOST", "VIEWER", null])("rejects NIHO role %s before borrowing the owner's DB identity", async (memberRole) => {
    mocks.providers.mockResolvedValue({ status: "ok", providers: [{ id: "provider-1", ownerUserId: "owner-1", memberRole }] });
    expect((await GET(request(), context)).status).toBe(403); expect(mocks.membership).not.toHaveBeenCalled();
  });

  it.each([null, { ...actor, role: "EDITOR", active: true }, { ...actor, role: "OWNER", active: false }, { ...actor, nihoUserId: "different-owner", role: "OWNER", active: true }])("rejects absent, stale, demoted or mismatched DB owner", async (membership) => {
    mocks.membership.mockResolvedValue(membership);
    expect((await GET(request(), context)).status).toBe(403); expect(mocks.product).not.toHaveBeenCalled();
  });

  it("does not accept another provider or a missing owner ID", async () => {
    mocks.providers.mockResolvedValue({ status: "ok", providers: [{ id: "different", ownerUserId: "owner-1", memberRole: "OWNER" }] });
    expect((await GET(request(), context)).status).toBe(403);
    mocks.providers.mockResolvedValue({ status: "ok", providers: [{ id: "provider-1", ownerUserId: null, memberRole: "OWNER" }] });
    expect((await GET(request(), context)).status).toBe(503);
  });

  it.each(["rejected", "signed-out", "refresh", "error"])("fails closed on NIHO %s", async (status) => {
    mocks.providers.mockResolvedValue({ status });
    expect((await GET(request(), context)).status).toBe(status === "error" ? 503 : 401);
    expect(mocks.membership).not.toHaveBeenCalled();
  });

  it("rejects expired and missing sealed sessions without consulting providers", async () => {
    mocks.usable.mockReturnValue(false); expect((await GET(request(), context)).status).toBe(401);
    mocks.session.mockResolvedValue(null); expect((await GET(request(), context)).status).toBe(401);
    expect(mocks.providers).not.toHaveBeenCalled();
  });

  it("keeps the route-specific flag default OFF and unavailable in mock mode", async () => {
    vi.stubEnv("EXPERIENCE_HOST_PUBLICATION_API_ENABLED", ""); expect((await GET(request(), context)).status).toBe(404);
    vi.stubEnv("EXPERIENCE_HOST_PUBLICATION_API_ENABLED", "true"); mocks.config.apiMode = "mock";
    expect((await GET(request(), context)).status).toBe(404); expect(mocks.session).not.toHaveBeenCalled();
  });

  it("rejects query identity and cross-origin/same-site mutations before reading a session", async () => {
    expect((await GET(request("GET", undefined, undefined, "?userId=owner-1"), context)).status).toBe(400);
    const cases: Record<string, string>[] = [{ origin: "https://evil.example" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "" }, { origin: "" }];
    for (const headers of cases) {
      expect((await PATCH(request("PATCH", {}, headers), context)).status).toBe(403);
    }
    expect((await GET(request("GET", undefined, { origin: "https://evil.example" }), context)).status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("saves with expected version and server fail-closed content checks", async () => {
    const response = await PATCH(request("PATCH", { expectedVersion: 2, draft }), context);
    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(actor, { ...draft, id: "product-1" }, 2, { manuscriptReady: false, photosReady: false });
    expect(await response.json()).toMatchObject({ publicationUpdated: false, draft: { version: 3 } });
  });

  it.each(["ownerNihoUserId", "sellerNihoAccountRef", "stripeConnectAccountRef", "checks", "readiness", "consentVersion"])("rejects client-supplied server field %s", async (key) => {
    expect((await PATCH(request("PATCH", { expectedVersion: 2, draft, [key]: true }), context)).status).toBe(400);
    expect((await PATCH(request("PATCH", { expectedVersion: 2, draft: { ...draft, [key]: true } }), context)).status).toBe(400);
    expect((await publish(request("POST", { ...command, [key]: true }), context)).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("maps a version conflict without exposing Store error messages", async () => {
    mocks.save.mockRejectedValue(new StoreConflictError("SECRET_DATABASE"));
    const response = await PATCH(request("PATCH", { expectedVersion: 2, draft }), context);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "conflict" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("stops only the owner publication while preserving operations suspension", async () => {
    const response = await stop(request("POST", { expectedStateVersion: 3 }), context);
    expect(response.status).toBe(200); expect(mocks.stop).toHaveBeenCalledWith(actor, "product-1", 3);
    expect(await response.json()).toMatchObject({ publication: { operationsSuspended: true, ownerResumeRequired: true, version: 4 } });
    expect((await stop(request("POST", { expectedStateVersion: 3, operationsSuspended: false }), context)).status).toBe(400);
  });

  it("requires explicit consent and stays blocked for publish and republish", async () => {
    const noConsent = await publish(request("POST", { ...command, consentAccepted: false }), context);
    expect(noConsent.status).toBe(409); expect(await noConsent.json()).toMatchObject({ blockers: ["CONSENT_REQUIRED"] });
    for (const selfStoppedAtUtc of [null, "2026-11-03T01:00:00.000Z"]) {
      mocks.state.mockResolvedValue({ ...state, selfStoppedAtUtc });
      const response = await publish(request("POST", command), context);
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "publication_blocked", blockers: expect.arrayContaining(["READINESS_CONTRACT_UNAVAILABLE"]) });
    }
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("does not invent a consent version or accept stale publication versions", async () => {
    vi.stubEnv("EXPERIENCE_PUBLICATION_CONSENT_VERSION", "");
    const read = await (await GET(request(), context)).json(); expect(read.requiredConsentVersion).toBeNull(); expect(read.blockers).toContain("CONSENT_CONTRACT_UNAVAILABLE");
    expect((await publish(request("POST", { ...command, expectedDraftVersion: 1 }), context)).status).toBe(409);
    expect((await publish(request("POST", { ...command, expectedStateVersion: null }), context)).status).toBe(409);
  });

  it("projects preview through the public allowlist, excluding meeting/access and server refs", async () => {
    const response = await preview(request(), context); const text = await response.text();
    expect(response.status).toBe(200);
    for (const secret of ["SECRET", "CONTENT_ACCOUNT_REF", "provider-1", "product-1", "owner-1", "entranceInstructions", "meetingAddress"]) expect(text).not.toContain(secret);
    expect(JSON.parse(text).preview.meetingPoint).toBeNull();
    expect(response.headers.get("cache-control")).toContain("no-store");
    mocks.product.mockResolvedValue({ ...product, content: {} }); expect((await preview(request(), context)).status).toBe(409);
  });

  it.each([[new StoreAccessDeniedError(), 403], [new StoreNotFoundError("product"), 404], [new StoreValidationError("SECRET_VALIDATION"), 400], [new Error("SECRET_DATABASE"), 503]])("maps store errors without details", async (error, status) => {
    mocks.product.mockRejectedValue(error); const response = await GET(request(), context);
    expect(response.status).toBe(status); expect(await response.text()).not.toContain("SECRET");
  });
});
