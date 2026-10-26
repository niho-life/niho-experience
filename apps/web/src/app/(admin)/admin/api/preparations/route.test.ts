import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enabled: vi.fn(), allowed: vi.fn(), load: vi.fn(), create: vi.fn(), list: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@niho-experience/api-client/experience-preparations-schema", () => ({ decodeExperiencePreparationDraft: (value: unknown) => typeof value === "object" && value !== null && (value as { valid?: boolean }).valid === true ? value : null }));
vi.mock("@/lib/admin/server", () => ({ adminMutationAllowed: mocks.allowed }));
vi.mock("@/lib/preparations/server", () => ({
  isPreparationHttpEnabled: mocks.enabled,
  loadPreparationAdminClient: mocks.load,
  readBoundedJson: async (request: Request, max: number) => { const text = await request.text(); if (Buffer.byteLength(text) > max || new URL(request.url).search || request.headers.get("content-type") !== "application/json") return { ok: false }; try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; } },
  preparationJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  preparationFailureJson: mocks.failure,
}));

import { GET, POST } from "./route";

const post = (body: unknown, suffix = "") => new Request(`https://experience.example/admin/api/preparations${suffix}`, { method: "POST", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks(); mocks.enabled.mockReturnValue(true); mocks.allowed.mockReturnValue(true);
  mocks.create.mockResolvedValue({ ok: true, data: { case: { id: "case_1" } } }); mocks.list.mockResolvedValue({ ok: true, data: { cases: [] } });
  mocks.load.mockResolvedValue({ ok: true, client: { createCase: mocks.create, listCases: mocks.list } });
  mocks.failure.mockImplementation(() => Response.json({ error: "unavailable" }, { status: 503 }));
});

describe("Admin preparation BFF", () => {
  it("closes both reads and writes behind the rollout flag before loading an Admin session", async () => {
    mocks.enabled.mockReturnValue(false);
    expect((await GET(new Request("https://experience.example/admin/api/preparations"))).status).toBe(404);
    expect((await POST(post({ draft: { valid: true } }))).status).toBe(404);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("requires same-origin and an exact validated draft without leaking contact input on failure", async () => {
    mocks.allowed.mockReturnValue(false);
    expect((await POST(post({ draft: { valid: true, contactEmail: "private@example.test" } }))).status).toBe(403);
    mocks.allowed.mockReturnValue(true);
    expect((await POST(post({ draft: { valid: true }, extra: "private" }))).status).toBe(400);
    expect((await POST(post({ draft: { valid: false, contactEmail: "private@example.test" } }))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("passes only the selected draft and never falls back to a synthetic success", async () => {
    const draft = { valid: true, provider: { contactEmail: "synthetic@example.test" } };
    expect((await POST(post({ draft }))).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(draft);
    mocks.create.mockResolvedValue({ ok: false, kind: "network_error" });
    expect((await POST(post({ draft }))).status).toBe(503);
  });
});
