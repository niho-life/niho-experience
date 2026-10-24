import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enabled: vi.fn(), load: vi.fn(), list: vi.fn(), failure: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/server", () => ({ adminJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }) }));
vi.mock("@/lib/admin/case-server", () => ({
  isAdminHttpSupportCase: mocks.enabled,
  loadAdminSupportCaseClient: mocks.load,
  adminSupportCaseFailureJson: mocks.failure,
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.list.mockResolvedValue({ ok: true, data: { admins: [{ id: "admin.1", displayName: "合成 管理者" }], truncated: false } });
  mocks.load.mockResolvedValue({ ok: true, client: { listSupportAdmins: mocks.list } });
  mocks.failure.mockImplementation(() => Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "private, no-store" } }));
});

describe("Admin support roster BFF", () => {
  it("requires its exact flag and rejects every query before session validation", async () => {
    mocks.enabled.mockReturnValue(false);
    expect((await GET(new Request("https://experience.example/admin/api/support-admins"))).status).toBe(404);
    mocks.enabled.mockReturnValue(true);
    expect((await GET(new Request("https://experience.example/admin/api/support-admins?limit=100"))).status).toBe(400);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("re-verifies the session, returns private no-store and does not synthesize candidates", async () => {
    const response = await GET(new Request("https://experience.example/admin/api/support-admins"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ admins: [{ id: "admin.1", displayName: "合成 管理者" }], truncated: false });
    expect(mocks.load).toHaveBeenCalledOnce();
    mocks.list.mockResolvedValue({ ok: false, kind: "network_error" });
    expect((await GET(new Request("https://experience.example/admin/api/support-admins"))).status).toBe(503);
  });
});
