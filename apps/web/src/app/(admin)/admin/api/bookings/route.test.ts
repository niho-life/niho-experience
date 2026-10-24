import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enabled: vi.fn(), mutationAllowed: vi.fn(), load: vi.fn(), query: vi.fn(), failure: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/server", () => ({
  adminMutationAllowed: mocks.mutationAllowed,
  isAdminHttpRead: mocks.enabled,
  loadAdminReadClient: mocks.load,
  adminReadFailureJson: mocks.failure,
  adminJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));

import { POST } from "./route";

function request(body: unknown, contentType = "application/json", suffix = "") {
  return new Request(`https://experience.example/admin/api/bookings${suffix}`, { method: "POST", headers: { "content-type": contentType, origin: "https://experience.example", "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.mutationAllowed.mockReturnValue(true);
  mocks.query.mockResolvedValue({ ok: true, data: { bookings: [], nextCursor: null } });
  mocks.load.mockResolvedValue({ ok: true, client: { queryBookings: mocks.query } });
  mocks.failure.mockImplementation(() => Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "private, no-store" } }));
});

describe("Admin HTTP booking query BFF", () => {
  it("keeps the read flag/auth gate closed without touching the API client", async () => {
    mocks.enabled.mockReturnValue(false);
    const response = await POST(request({ limit: 50 }));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("requires same-origin and strict JSON before sending search terms", async () => {
    mocks.mutationAllowed.mockReturnValue(false);
    expect((await POST(request({ limit: 50, search: "secret" }))).status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled();

    mocks.mutationAllowed.mockReturnValue(true);
    expect((await POST(request({ limit: 50 }, "text/plain"))).status).toBe(400);
    expect((await POST(request({ limit: 50 }, "application/json-patch+json"))).status).toBe(400);
    expect((await POST(request({ limit: 50 }, "application/json; charset=utf-8", "?search=secret"))).status).toBe(400);
    expect((await POST(request({ limit: 50, unknown: true }))).status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects every URL query before loading the admin session", async () => {
    const response = await POST(request({ limit: 50 }, "application/json", "?search=secret"));
    expect(response.status).toBe(400);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("passes the validated JSON body and returns private no-store", async () => {
    const response = await POST(request({ limit: 50, hostSearch: "工房", search: "guest", support: "legacy" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.query).toHaveBeenCalledWith({ limit: 50, hostSearch: "工房", search: "guest", support: "legacy" });
  });

  it("does not turn upstream failure into an empty list", async () => {
    mocks.query.mockResolvedValue({ ok: false, kind: "network_error" });
    const response = await POST(request({ limit: 50 }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });
});
