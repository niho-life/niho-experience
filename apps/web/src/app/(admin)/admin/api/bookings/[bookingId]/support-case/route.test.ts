import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enabled: vi.fn(), mutationAllowed: vi.fn(), load: vi.fn(), get: vi.fn(), patch: vi.fn(), failure: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/server", () => ({
  adminMutationAllowed: mocks.mutationAllowed,
  adminJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));
vi.mock("@/lib/admin/case-server", () => ({
  isAdminHttpSupportCase: mocks.enabled,
  loadAdminSupportCaseClient: mocks.load,
  adminSupportCaseFailureJson: mocks.failure,
}));

import { GET, PATCH } from "./route";

const context = { params: Promise.resolve({ bookingId: "booking.1:opaque" }) };
const request = (body: unknown, contentType = "application/json", suffix = "") => new Request(`https://experience.example/admin/api/bookings/booking.1%3Aopaque/support-case${suffix}`, {
  method: "PATCH",
  headers: { "content-type": contentType, origin: "https://experience.example", "sec-fetch-site": "same-origin" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.mutationAllowed.mockReturnValue(true);
  mocks.get.mockResolvedValue({ ok: true, data: { supportCase: { bookingRequestId: "booking.1:opaque" }, writeCapability: { writable: true, reason: null } } });
  mocks.patch.mockResolvedValue({ ok: true, data: { supportCase: { bookingRequestId: "booking.1:opaque", revision: 2 } } });
  mocks.load.mockResolvedValue({ ok: true, client: { getSupportCase: mocks.get, patchSupportCase: mocks.patch } });
  mocks.failure.mockImplementation((failure: { kind: string; reason?: string }) => Response.json(failure.kind === "conflict" ? { error: "conflict", reason: failure.reason } : { error: "unavailable" }, { status: failure.kind === "conflict" ? 409 : 503, headers: { "cache-control": "private, no-store" } }));
});

describe("Admin support case BFF", () => {
  it("keeps the dedicated flag closed before session or input work", async () => {
    mocks.enabled.mockReturnValue(false);
    expect((await GET(new Request("https://experience.example/admin/api/bookings/x/support-case?memo=secret"), context)).status).toBe(404);
    expect((await PATCH(request({ expectedRevision: 1, internalMemo: "secret" }), context)).status).toBe(404);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("re-verifies the current Admin session for each exact GET and PATCH", async () => {
    const getResponse = await GET(new Request("https://experience.example/admin/api/bookings/booking.1%3Aopaque/support-case"), context);
    const patchResponse = await PATCH(request({ expectedRevision: 1, internalMemo: null }), context);
    expect(getResponse.status).toBe(200);
    expect(patchResponse.status).toBe(200);
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(mocks.get).toHaveBeenCalledWith("booking.1:opaque");
    expect(mocks.patch).toHaveBeenCalledWith("booking.1:opaque", { expectedRevision: 1, internalMemo: null });
    expect(getResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(patchResponse.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects query, cross-origin, loose content types and non-strict DTOs before upstream", async () => {
    expect((await GET(new Request("https://experience.example/admin/api/bookings/x/support-case?search=secret"), context)).status).toBe(400);
    expect((await PATCH(request({ expectedRevision: 1, internalMemo: "secret" }, "application/json", "?memo=secret"), context)).status).toBe(400);
    mocks.mutationAllowed.mockReturnValue(false);
    expect((await PATCH(request({ expectedRevision: 1, internalMemo: "secret" }), context)).status).toBe(403);
    mocks.mutationAllowed.mockReturnValue(true);
    expect((await PATCH(request({ expectedRevision: 1, internalMemo: "secret" }, "text/plain"), context)).status).toBe(400);
    expect((await PATCH(request({ expectedRevision: 1, internalMemo: "secret", extra: true }), context)).status).toBe(400);
    expect((await PATCH(request({ expectedRevision: 1 }), context)).status).toBe(400);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("returns only the selected conflict reason and no upstream text", async () => {
    mocks.patch.mockResolvedValue({ ok: false, kind: "conflict", reason: "REVISION_CONFLICT", upstream: "secret" });
    const response = await PATCH(request({ expectedRevision: 1, internalMemo: "draft" }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict", reason: "REVISION_CONFLICT" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("does not turn an upstream or session failure into an empty case", async () => {
    mocks.get.mockResolvedValue({ ok: false, kind: "network_error" });
    expect((await GET(new Request("https://experience.example/admin/api/bookings/x/support-case"), context)).status).toBe(503);
    mocks.load.mockResolvedValue({ ok: false, response: Response.json({ error: "signed_out" }, { status: 401, headers: { "cache-control": "private, no-store" } }) });
    const response = await GET(new Request("https://experience.example/admin/api/bookings/x/support-case"), context);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "signed_out" });
  });
});
