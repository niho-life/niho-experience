import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ allowed: vi.fn(), load: vi.fn(), create: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/host/translate-rooms-server", () => ({
  translateRoomsMutationAllowed: mocks.allowed,
  loadTranslateRoomsClient: mocks.load,
  readEmptyTranslateBody: async (request: Request) => { const text = await request.text(); return text === "" || text === "{}"; },
  translateRoomsJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } }),
  translateRoomsFailure: mocks.failure,
}));

import { POST } from "./route";

const created = {
  roomId: "room_1", state: "created", expiresAt: "2026-11-08T01:15:00.000Z",
  host: { participantId: "participant_host", inviteCode: "host-code-secret", inviteUrl: "https://app-stg.niho.test/i/host-code-secret" },
  guest: { participantId: "participant_guest", inviteCode: "guest-code-secret", inviteUrl: "https://app-stg.niho.test/i/guest-code-secret" },
};
const context = (providerId = "provider_1", bookingId = "booking_1") => ({ params: Promise.resolve({ providerId, bookingId }) });
const request = (body: string | null = null, url = "https://experience.example/host/api/translate/providers/provider_1/bookings/booking_1/rooms") =>
  new Request(url, { method: "POST", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", ...(body === null ? {} : { "content-type": "application/json" }) }, body });

describe("translate room create BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.allowed.mockReturnValue(true);
    mocks.create.mockResolvedValue({ ok: true, data: created });
    mocks.load.mockResolvedValue({ ok: true, client: { createRoom: mocks.create } });
    mocks.failure.mockImplementation(() => Response.json({ error: "upstream" }, { status: 502 }));
  });

  it("makes the room and hands the browser the invite URLs, never a participant id or a bare code", async () => {
    const response = await POST(request(), context());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ room: { id: "room_1", state: "created", expiresAt: "2026-11-08T01:15:00.000Z", hostInviteUrl: created.host.inviteUrl, guestInviteUrl: created.guest.inviteUrl } });
    expect(mocks.create).toHaveBeenCalledWith("provider_1", "booking_1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("refuses cross-site requests, bodies with fields, queries and odd ids before touching NIHO", async () => {
    mocks.allowed.mockReturnValue(false);
    expect((await POST(request(), context())).status).toBe(403);
    mocks.allowed.mockReturnValue(true);
    expect((await POST(request(JSON.stringify({ language: "fr" })), context())).status).toBe(400);
    expect((await POST(request(null, "https://experience.example/host/api/translate/providers/provider_1/bookings/booking_1/rooms?debug=1"), context())).status).toBe(404);
    expect((await POST(request(), context("../private", "booking_1"))).status).toBe(404);
    expect((await POST(request(), context("provider_1", "a%2Fb"))).status).toBe(404);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("passes the gate's own answer through and maps NIHO's refusal", async () => {
    mocks.load.mockResolvedValue({ ok: false, response: Response.json({ error: "not_found" }, { status: 404 }) });
    expect((await POST(request(), context())).status).toBe(404);
    mocks.load.mockResolvedValue({ ok: true, client: { createRoom: mocks.create } });
    mocks.create.mockResolvedValue({ ok: false, kind: "conflict" });
    expect((await POST(request(), context())).status).toBe(502);
    expect(mocks.failure).toHaveBeenCalledWith({ ok: false, kind: "conflict" });
  });
});
