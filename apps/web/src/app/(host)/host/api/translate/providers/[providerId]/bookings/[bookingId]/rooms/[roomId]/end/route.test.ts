import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ allowed: vi.fn(), load: vi.fn(), end: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/host/translate-rooms-server", () => ({
  translateRoomsMutationAllowed: mocks.allowed,
  loadTranslateRoomsClient: mocks.load,
  readEmptyTranslateBody: async (request: Request) => (await request.text()) === "",
  translateRoomsJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  translateRoomsFailure: mocks.failure,
}));

import { POST } from "./route";

const context = (roomId = "room_1") => ({ params: Promise.resolve({ providerId: "provider_1", bookingId: "booking_1", roomId }) });
const request = (body: string | null = null) => new Request("https://experience.example/host/api/translate/providers/provider_1/bookings/booking_1/rooms/room_1/end", { method: "POST", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin" }, body });

describe("translate room end BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.allowed.mockReturnValue(true);
    mocks.end.mockResolvedValue({ ok: true, data: { state: "ended" } });
    mocks.load.mockResolvedValue({ ok: true, client: { endRoom: mocks.end } });
    mocks.failure.mockImplementation(() => Response.json({ error: "conflict" }, { status: 409 }));
  });

  it("ends the room and returns only the final state", async () => {
    const response = await POST(request(), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "ended" });
    expect(mocks.end).toHaveBeenCalledWith("provider_1", "booking_1", "room_1");
  });

  it("refuses cross-site requests and bodies, and maps NIHO's conflict", async () => {
    mocks.allowed.mockReturnValue(false);
    expect((await POST(request(), context())).status).toBe(403);
    mocks.allowed.mockReturnValue(true);
    expect((await POST(request("{\"force\":true}"), context())).status).toBe(400);
    expect((await POST(request(), context("a/b"))).status).toBe(404);
    expect(mocks.end).not.toHaveBeenCalled();
    mocks.end.mockResolvedValue({ ok: false, kind: "conflict" });
    expect((await POST(request(), context())).status).toBe(409);
  });
});
