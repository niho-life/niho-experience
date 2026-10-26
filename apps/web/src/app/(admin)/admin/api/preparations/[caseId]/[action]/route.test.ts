import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enabled: vi.fn(), allowed: vi.fn(), load: vi.fn(), getCase: vi.fn(), verify: vi.fn(), materialize: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@niho-experience/api-client/experience-preparations-schema", () => ({
  isExperiencePreparationPathId: (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value),
  decodeExperiencePreparationUploadPolicyInput: () => null,
  decodeExperiencePreparationLockedAcceptance: (value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    return Object.keys(input).length === 3 && Number.isInteger(input.expectedRevision) && typeof input.snapshotHash === "string" && typeof input.acceptedByUserId === "string" ? input : null;
  },
}));
vi.mock("@/lib/admin/server", () => ({ adminMutationAllowed: mocks.allowed }));
vi.mock("@/lib/preparations/server", () => ({
  isPreparationHttpEnabled: mocks.enabled,
  loadPreparationAdminClient: mocks.load,
  readBoundedJson: async (request: Request) => { try { return { ok: true, value: await request.json() }; } catch { return { ok: false }; } },
  preparationJson: (body: unknown, status = 200) => Response.json(body, { status }),
  preparationFailureJson: mocks.failure,
}));

import { POST } from "./route";

const hash = "a".repeat(64);
const proof = { expectedRevision: 4, snapshotHash: hash, acceptedByUserId: "representative_1" };
const adminCase = {
  id: "case_1", revision: 4, snapshotHash: hash,
  currentAcceptance: { revision: 4, snapshotHash: hash, acceptedBy: { userId: "representative_1", displayName: "合成代表者" }, revokedAt: null },
};
const context = (action: "verify-representative" | "materialize") => ({ params: Promise.resolve({ caseId: "case_1", action }) });
const request = (body: unknown) => new Request("https://experience.example/admin/api/preparations/case_1/verify-representative", { method: "POST", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true); mocks.allowed.mockReturnValue(true);
  mocks.getCase.mockResolvedValue({ ok: true, data: { case: adminCase, correctionRequests: [], audits: [], readiness: null } });
  mocks.verify.mockResolvedValue({ ok: true, data: { case: adminCase } });
  mocks.materialize.mockResolvedValue({ ok: true, data: { materialized: { providerId: "synthetic_provider" } } });
  mocks.load.mockResolvedValue({ ok: true, client: { getCase: mocks.getCase, verifyRepresentative: mocks.verify, materialize: mocks.materialize } });
  mocks.failure.mockImplementation(() => Response.json({ error: "unavailable" }, { status: 503 }));
});

describe("Admin representative proof BFF", () => {
  it("sends the exact representative and displayed case proof after checking the current case", async () => {
    expect((await POST(request(proof), context("verify-representative"))).status).toBe(200);
    expect(mocks.getCase).toHaveBeenCalledWith("case_1");
    expect(mocks.verify).toHaveBeenCalledWith("case_1", proof);
  });

  it("rejects an old revision and a different representative before mutation", async () => {
    expect((await POST(request({ ...proof, expectedRevision: 3 }), context("verify-representative"))).status).toBe(409);
    expect((await POST(request({ ...proof, acceptedByUserId: "former_representative" }), context("materialize"))).status).toBe(409);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it("rejects a revoked acceptance and unknown proof keys", async () => {
    mocks.getCase.mockResolvedValue({ ok: true, data: { case: { ...adminCase, currentAcceptance: { ...adminCase.currentAcceptance, revokedAt: "2026-10-26T00:00:00.000Z" } } } });
    expect((await POST(request(proof), context("materialize"))).status).toBe(409);
    expect((await POST(request({ ...proof, acceptedByDisplayName: "合成代表者" }), context("verify-representative"))).status).toBe(400);
    expect(mocks.materialize).not.toHaveBeenCalled();
  });
});
