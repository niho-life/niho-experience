import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ allowed: vi.fn(), load: vi.fn(), create: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/host/translate-rooms-server", () => ({
  translateRoomsMutationAllowed: mocks.allowed,
  loadSiteTranslateRoomsClient: mocks.load,
  readEmptyTranslateBody: async (request: Request) => { const text = await request.text(); return text === "" || text === "{}"; },
  translateRoomsJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } }),
  translateRoomsFailure: mocks.failure,
}));

import { POST } from "./route";

const bookingId = "00000000-0000-4000-8000-00000000b101";
const created = {
  roomId: "room_1", state: "waiting", expiresAt: "2026-11-08T01:15:00.000Z",
  host: { participantId: "participant_host", inviteCode: "host-code-secret", inviteUrl: "https://app-stg.niho.test/t#host-code-secret" },
  guest: { participantId: "participant_guest", inviteCode: "guest-code-secret", inviteUrl: "https://app-stg.niho.test/t#guest-code-secret" },
};
const context = (providerId = "provider_1", id = bookingId) => ({ params: Promise.resolve({ providerId, bookingId: id }) });
const request = (body: string | null = null) => new Request(`https://experience.example/host/api/translate/site/providers/provider_1/bookings/${bookingId}/rooms`, {
  method: "POST", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin" }, body,
});

describe("site translate room create BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.allowed.mockReturnValue(true);
    mocks.create.mockResolvedValue({ ok: true, data: created });
    mocks.load.mockResolvedValue({ ok: true, client: { createSiteRoom: mocks.create } });
  });

  it("site sourceの所属・開始条件を検査してから固定client methodだけを呼ぶ", async () => {
    const response = await POST(request(), context());
    expect(response.status).toBe(201);
    expect(mocks.load).toHaveBeenCalledWith("provider_1", bookingId, "create");
    expect(mocks.create).toHaveBeenCalledWith("provider_1", bookingId);
    expect(await response.json()).toEqual({ room: { id: "room_1", state: "waiting", expiresAt: created.expiresAt, hostInviteUrl: created.host.inviteUrl, guestInviteUrl: created.guest.inviteUrl } });
  });

  it("cross-origin・申告field・不正IDを所属照会前に拒否する", async () => {
    mocks.allowed.mockReturnValue(false);
    expect((await POST(request(), context())).status).toBe(403);
    mocks.allowed.mockReturnValue(true);
    expect((await POST(request('{"role":"host"}'), context())).status).toBe(400);
    expect((await POST(request(), context("../private"))).status).toBe(404);
    expect(mocks.load).not.toHaveBeenCalled();
  });
});
