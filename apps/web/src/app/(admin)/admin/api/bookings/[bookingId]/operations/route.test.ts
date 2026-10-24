import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ enabled: vi.fn(), load: vi.fn(), allowed: vi.fn() }));
vi.mock("@/lib/admin/operations-server", () => ({ isAdminHttpOperations: mocks.enabled, loadAdminOperationsClient: mocks.load, adminOperationsFailureJson: () => Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "private, no-store" } }) }));
vi.mock("@/lib/admin/server", () => ({ adminMutationAllowed: mocks.allowed, adminJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }) }));
import { GET, POST } from "./route";
const command = { operationId: "123e4567-e89b-42d3-a456-426614174000", expectedRevision: 1, expectedStatus: "PROVISIONAL", expectedTotalYen: 1000, expectedRefundedYen: 0, reasonCode: "SUPPORT_REVIEWED" };
describe("Admin operations fixed BFF", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.enabled.mockReturnValue(true); mocks.allowed.mockReturnValue(true); mocks.load.mockResolvedValue({ ok: true, client: { getSnapshot: vi.fn(async () => ({ ok: true, data: { fixed: true } })), execute: vi.fn(async () => ({ ok: true, data: { fixed: true }, status: 202 })) } }); });
  it("re-verifies through the loader and returns private no-store", async () => { const response = await GET(new Request("https://experience.example/admin/api/bookings/b1/operations"), { params: Promise.resolve({ bookingId: "b1" }) }); expect(mocks.load).toHaveBeenCalledOnce(); expect(response.headers.get("cache-control")).toBe("private, no-store"); });
  it("fails closed while the independent flag is OFF", async () => { mocks.enabled.mockReturnValue(false); const response = await GET(new Request("https://experience.example/admin/api/bookings/b1/operations"), { params: Promise.resolve({ bookingId: "b1" }) }); expect(response.status).toBe(404); expect(mocks.load).not.toHaveBeenCalled(); });
  it("requires same-origin and exact action/command JSON before session loading", async () => { mocks.allowed.mockReturnValue(false); const request = () => new Request("https://experience.example/admin/api/bookings/b1/operations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "APPROVE", command }) }); const cross = await POST(request(), { params: Promise.resolve({ bookingId: "b1" }) }); expect(cross.status).toBe(403); expect(mocks.load).not.toHaveBeenCalled(); mocks.allowed.mockReturnValue(true); const extra = await POST(new Request("https://experience.example/admin/api/bookings/b1/operations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "APPROVE", command, extra: true }) }), { params: Promise.resolve({ bookingId: "b1" }) }); expect(extra.status).toBe(400); expect(mocks.load).not.toHaveBeenCalled(); });
  it("forwards only a valid command and preserves 202", async () => { const response = await POST(new Request("https://experience.example/admin/api/bookings/b1/operations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "APPROVE", command }) }), { params: Promise.resolve({ bookingId: "b1" }) }); expect(response.status).toBe(202); expect(response.headers.get("cache-control")).toBe("private, no-store"); });
  it("rejects an oversized streamed body without trusting content-length", async () => {
    const response = await POST(new Request("https://experience.example/admin/api/bookings/b1/operations", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "MESSAGE", command: "x".repeat(33000) }),
    }), { params: Promise.resolve({ bookingId: "b1" }) });
    expect(response.status).toBe(400);
    expect(mocks.load).not.toHaveBeenCalled();
  });
});
