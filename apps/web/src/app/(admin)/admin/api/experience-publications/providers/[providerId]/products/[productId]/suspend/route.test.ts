import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ suspend: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { experiencePublicationsEnabled: true, apiMode: "http", adminSupportConsoleEnabled: true } }));
vi.mock("@/lib/admin/server", () => ({
  adminMutationAllowed: () => true, clearAdminHttpSessionCookie: () => undefined,
  loadAdminHttpSession: async () => ({ status: "ok", actor: { id: "admin-a" } }),
}));
vi.mock("@/lib/experience/store-server", () => ({ experiencePublicationRepository: () => ({ suspendByOperations: mocks.suspend }) }));

import { POST } from "./route";

const post = (reasonCode: string) => POST(new Request("https://experience.example/x", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedStateVersion: 1, reasonCode }),
}), { params: Promise.resolve({ providerId: "prv_1", productId: "x1" }) });

beforeEach(() => { vi.clearAllMocks(); mocks.suspend.mockResolvedValue({ version: 2, firstPublishedAtUtc: null, selfStoppedAtUtc: null }); });

describe("product suspension reason (#711)", () => {
  it("takes an ordinary code and refuses the one reserved for a whole host", async () => {
    expect((await post("POLICY_REVIEW")).status).toBe(200);
    expect((await post("PROVIDER_SUSPENDED")).status).toBe(400);
    expect(mocks.suspend).toHaveBeenCalledTimes(1);
  });
});
