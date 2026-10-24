import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enabled: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/host/support-settings-server", () => ({ isHostSupportSettingsEnabled: mocks.enabled, loadHostSupportSettingsClient: mocks.load, hostSupportSettingsFailureJson: () => Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "private, no-store" } }) }));
vi.mock("@/lib/host/server", () => ({ hostNotFound: () => Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "private, no-store" } }), noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }) }));
import { GET } from "./route";

const hosts = { hosts: [], limit: 100, truncated: false };

describe("Host support settings list fixed BFF", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.enabled.mockReturnValue(true); mocks.load.mockResolvedValue({ ok: true, client: { list: vi.fn(async () => ({ ok: true, data: hosts })) } }); });

  it("stays 404 while its independent HTTP flag is OFF", async () => {
    mocks.enabled.mockReturnValue(false);
    const response = await GET(new Request("https://experience.example/host/api/support-settings"));
    expect(response.status).toBe(404);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("rejects query expansion and returns a private no-store exact list", async () => {
    expect((await GET(new Request("https://experience.example/host/api/support-settings?provider=x"))).status).toBe(400);
    const response = await GET(new Request("https://experience.example/host/api/support-settings"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(hosts);
  });
});
