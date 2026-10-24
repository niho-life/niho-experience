import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enabled: vi.fn(), load: vi.fn(), get: vi.fn(), failure: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/server", () => ({
  isAdminHttpRead: mocks.enabled,
  loadAdminReadClient: mocks.load,
  adminReadFailureJson: mocks.failure,
  adminJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.get.mockResolvedValue({ ok: false, kind: "not_found" });
  mocks.load.mockResolvedValue({ ok: true, client: { getBooking: mocks.get } });
  mocks.failure.mockImplementation(() => Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "private, no-store" } }));
});

describe("Admin HTTP booking detail BFF", () => {
  it("keeps the read flag closed before validating the path request", async () => {
    mocks.enabled.mockReturnValue(false);
    const response = await GET(new Request("https://experience.example/admin/api/bookings/deep-booking?search=guest"), { params: Promise.resolve({ bookingId: "deep-booking" }) });
    expect(response.status).toBe(404);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("supports a deep opaque booking id that was not loaded in the list", async () => {
    mocks.get.mockResolvedValue({ ok: true, data: { booking: { id: "deep-booking" }, supportAgreement: {} } });
    const response = await GET(new Request("https://experience.example/admin/api/bookings/deep-booking"), { params: Promise.resolve({ bookingId: "deep-booking" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.get).toHaveBeenCalledWith("deep-booking");
  });

  it("passes an invalid id through the closed SDK result without constructing another path", async () => {
    mocks.get.mockResolvedValue({ ok: false, kind: "invalid_request" });
    mocks.failure.mockImplementation(() => Response.json({ error: "invalid_input" }, { status: 400, headers: { "cache-control": "private, no-store" } }));
    const response = await GET(new Request("https://experience.example/admin/api/bookings/%2E%2E%2Fauth"), { params: Promise.resolve({ bookingId: "../auth" }) });
    expect(response.status).toBe(400);
    expect(mocks.get).toHaveBeenCalledWith("../auth");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects every URL query before loading the admin session", async () => {
    const response = await GET(new Request("https://experience.example/admin/api/bookings/deep-booking?search=guest"), { params: Promise.resolve({ bookingId: "deep-booking" }) });
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
