import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ enabled: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/host/support-history-server", () => ({ isHostSupportHistoryEnabled: mocks.enabled, loadHostSupportHistoryClient: mocks.load, hostSupportHistoryFailureJson: () => Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "private, no-store" } }) }));
vi.mock("@/lib/host/server", () => ({ hostNotFound: () => Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "private, no-store" } }), noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }) }));
import { GET } from "./route";
describe("Host support history fixed BFF", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.enabled.mockReturnValue(true); mocks.load.mockResolvedValue({ ok: true, client: { list: vi.fn(async () => ({ ok: true, data: { bookingRequestId: "b1", operations: [], history: { limit: 50, truncated: false } } })) } }); });
  it("stays OFF without preview fallback", async () => { mocks.enabled.mockReturnValue(false); const response = await GET(new Request("https://experience.example/host/api/bookings/b1/support-history"), { params: Promise.resolve({ bookingId: "b1" }) }); expect(response.status).toBe(404); expect(mocks.load).not.toHaveBeenCalled(); });
  it("loads server-only session and returns no-store", async () => { const response = await GET(new Request("https://experience.example/host/api/bookings/b1/support-history"), { params: Promise.resolve({ bookingId: "b1" }) }); expect(mocks.load).toHaveBeenCalledOnce(); expect(response.headers.get("cache-control")).toBe("private, no-store"); });
  it("rejects query expansion", async () => { const response = await GET(new Request("https://experience.example/host/api/bookings/b1/support-history?provider=other"), { params: Promise.resolve({ bookingId: "b1" }) }); expect(response.status).toBe(400); expect(mocks.load).not.toHaveBeenCalled(); });
});
