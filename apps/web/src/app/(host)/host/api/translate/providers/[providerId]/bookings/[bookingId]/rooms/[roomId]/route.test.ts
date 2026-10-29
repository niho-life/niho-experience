import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), get: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/host/translate-rooms-server", () => ({
  loadTranslateRoomsClient: mocks.load,
  translateRoomsJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  translateRoomsFailure: mocks.failure,
}));

import { GET } from "./route";

const context = (roomId = "room_1") => ({ params: Promise.resolve({ providerId: "provider_1", bookingId: "booking_1", roomId }) });
const request = (search = "") => new Request(`https://experience.example/host/api/translate/providers/provider_1/bookings/booking_1/rooms/room_1${search}`);

describe("translate room status BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue({ ok: true, data: { state: "active", participants: [{ role: "host", joined: true, ready: true }, { role: "guest", joined: true, ready: false }], usageMinutes: 1 } });
    mocks.load.mockResolvedValue({ ok: true, client: { getRoom: mocks.get } });
    mocks.failure.mockImplementation(() => Response.json({ error: "not_found" }, { status: 404 }));
  });

  it("projects 参加状況 per role with no-store", async () => {
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "active", host: { joined: true, ready: true }, guest: { joined: true, ready: false }, usageMinutes: 1 });
    expect(mocks.get).toHaveBeenCalledWith("provider_1", "booking_1", "room_1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("refuses queries and odd room ids, and maps a room NIHO no longer has", async () => {
    expect((await GET(request("?since=0"), context())).status).toBe(404);
    expect((await GET(request(), context(".."))).status).toBe(404);
    expect(mocks.load).not.toHaveBeenCalled();
    mocks.get.mockResolvedValue({ ok: false, kind: "not_found" });
    expect((await GET(request(), context())).status).toBe(404);
    expect(mocks.failure).toHaveBeenCalledWith({ ok: false, kind: "not_found" });
  });
});
