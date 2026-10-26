import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enabled: vi.fn(), allowed: vi.fn(), load: vi.fn(), grant: vi.fn(), review: vi.fn(), accept: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@niho-experience/api-client/experience-preparations-schema", () => ({
  isExperiencePreparationPathId: (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value),
  isExperiencePreparationCorrection: (value: unknown) => typeof value === "string" && value.trim().length > 0,
}));
vi.mock("@/lib/preparations/server", () => ({
  isPreparationHttpEnabled: mocks.enabled,
  preparationMutationAllowed: mocks.allowed,
  loadPreparationHostClient: mocks.load,
  readPreparationReviewGrant: mocks.grant,
  preparationReviewClient: () => ({ review: mocks.review }),
  readBoundedJson: async (request: Request) => { try { return { ok: true, value: await request.json() }; } catch { return { ok: false }; } },
  preparationJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } }),
  preparationFailureJson: mocks.failure,
}));

import { POST } from "./route";

const review = {
  caseId: "case_1", revision: 4, snapshotHash: "a".repeat(64), proposal: { target: { mode: "NEW_PROVIDER", providerId: null } },
  consents: { preparation: { version: "agreement-v1" }, provider: { required: true, version: "provider-v1" }, listing: { version: "listing-v1" } },
};
const context = { params: Promise.resolve({ caseId: "case_1", action: "accept" }) };
const accepted = { contentAccepted: true, salesTermsAccepted: true, supportAuthorized: true, representativeDeclared: true, listingAuthorized: true, providerConsentAccepted: true };
const displayed = { ...accepted, caseVersion: 4, snapshotHash: "a".repeat(64), agreementVersion: "agreement-v1", providerConsentVersion: "provider-v1", listingConsentVersion: "listing-v1", target: { mode: "NEW_PROVIDER", providerId: null } };
const request = (body: unknown, origin = "https://experience.example") => new Request("https://experience.example/host/api/preparations/case_1/accept", { method: "POST", headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true); mocks.allowed.mockReturnValue(true);
  mocks.grant.mockResolvedValue({ token: "t".repeat(43), caseId: "case_1", expiresAt: Date.now() + 60_000 });
  mocks.review.mockResolvedValue({ ok: true, data: review });
  mocks.accept.mockResolvedValue({ ok: true, data: { acceptance: { id: "a1" } } });
  mocks.load.mockResolvedValue({ ok: true, client: { accept: mocks.accept, requestCorrection: vi.fn(), revokeAcceptance: vi.fn(), readiness: vi.fn() } });
  mocks.failure.mockImplementation(() => Response.json({ error: "unavailable" }, { status: 503 }));
});

describe("host preparation acceptance BFF", () => {
  it("stays closed behind the HTTP flag and same-origin check", async () => {
    mocks.enabled.mockReturnValue(false);
    expect((await POST(request(displayed), context)).status).toBe(404);
    mocks.enabled.mockReturnValue(true); mocks.allowed.mockReturnValue(false);
    expect((await POST(request(displayed, "https://evil.example"), context)).status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("adds only the sealed token after matching the proof shown by the browser", async () => {
    const response = await POST(request(displayed), context);
    expect(response.status).toBe(200);
    expect(mocks.accept).toHaveBeenCalledWith("case_1", {
      reviewToken: "t".repeat(43), caseVersion: 4, snapshotHash: "a".repeat(64), agreementVersion: "agreement-v1",
      providerConsent: { version: "provider-v1", accepted: true }, listingConsentVersion: "listing-v1", target: { mode: "NEW_PROVIDER", providerId: null },
      contentAccepted: true, salesTermsAccepted: true, supportAuthorized: true, representativeDeclared: true, listingAuthorized: true,
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("rejects missing independent consent, token injection, expired grants and another case cookie", async () => {
    expect((await POST(request({ ...displayed, salesTermsAccepted: false }), context)).status).toBe(400);
    expect((await POST(request({ ...displayed, reviewToken: "attacker" }), context)).status).toBe(400);
    mocks.grant.mockResolvedValue(null);
    expect((await POST(request(displayed), context)).status).toBe(401);
    mocks.grant.mockResolvedValue({ token: "t".repeat(43), caseId: "other", expiresAt: Date.now() + 60_000 });
    expect((await POST(request(displayed), context)).status).toBe(401);
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it("rejects an old tab after another tab replaces the review cookie, then accepts the newly displayed proof", async () => {
    const newer = {
      ...review,
      revision: 5,
      snapshotHash: "b".repeat(64),
      consents: { preparation: { version: "agreement-v2" }, provider: { required: true, version: "provider-v2" }, listing: { version: "listing-v2" } },
      proposal: { target: { mode: "EXISTING_PROVIDER", providerId: "provider_2" } },
    };
    mocks.review.mockResolvedValue({ ok: true, data: newer });
    expect((await POST(request(displayed), context)).status).toBe(409);
    expect(mocks.accept).not.toHaveBeenCalled();

    const newlyDisplayed = { ...accepted, caseVersion: 5, snapshotHash: "b".repeat(64), agreementVersion: "agreement-v2", providerConsentVersion: "provider-v2", listingConsentVersion: "listing-v2", target: { mode: "EXISTING_PROVIDER", providerId: "provider_2" } };
    expect((await POST(request(newlyDisplayed), context)).status).toBe(200);
    expect(mocks.accept).toHaveBeenCalledWith("case_1", expect.objectContaining({ caseVersion: 5, snapshotHash: "b".repeat(64), target: newlyDisplayed.target }));
  });
});
