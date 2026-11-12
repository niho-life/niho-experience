import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  allowed: vi.fn(), load: vi.fn(), create: vi.fn(), current: vi.fn(), get: vi.fn(), reissue: vi.fn(), end: vi.fn(), failure: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/host/translate-rooms-server", () => ({
  translateRoomsMutationAllowed: mocks.allowed,
  readStandaloneTranslateCreateBody: async (request: Request) => {
    try {
      const value = JSON.parse(await request.text()) as Record<string, unknown>;
      return Object.keys(value).length === 1 && (value.hostLanguage === "ja" || value.hostLanguage === "en") ? value : null;
    } catch { return null; }
  },
  readEmptyTranslateBody: async (request: Request) => { const text = await request.text(); return text === "" || text === "{}"; },
  loadStandaloneTranslateRoomsClient: mocks.load,
  translateRoomsJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } }),
  translateRoomsFailure: mocks.failure,
}));

import { POST as createRoom } from "./route";
import { GET as getCurrent } from "./current/route";
import { GET as getRoom } from "./[roomId]/route";
import { POST as reissueInvite } from "./[roomId]/invites/[role]/route";
import { POST as endRoom } from "./[roomId]/end/route";

const room = {
  roomId: "room_1", state: "waiting", hostLanguage: "ja", guestLanguage: "en", expiresAt: "2026-11-04T02:30:00.000Z",
  participants: [{ role: "host", joined: false, ready: false }, { role: "guest", joined: false, ready: false }], usageMinutes: 0,
};
const invite = { inviteUrl: `https://app-stg.niho.life/t#${"g".repeat(43)}`, expiresAt: "2026-11-04T01:15:00.000Z" };
const base = "https://experience.example/host/api/translate/standalone/providers/local_provider_1/rooms";
const mutation = (url: string, body: string | null = "{}") => new Request(url, { method: "POST", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body });
const providerContext = (providerId = "local_provider_1") => ({ params: Promise.resolve({ providerId }) });
const roomContext = (roomId = "room_1") => ({ params: Promise.resolve({ providerId: "local_provider_1", roomId }) });

describe("standalone translate BFF routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.allowed.mockReturnValue(true);
    mocks.load.mockResolvedValue({ ok: true, providerApiId: "niho_provider_9", serviceAuth: false, client: {
      createStandaloneRoom: mocks.create, getCurrentStandaloneRoom: mocks.current, getStandaloneRoom: mocks.get,
      reissueStandaloneInvite: mocks.reissue, endStandaloneRoom: mocks.end,
    } });
    mocks.create.mockResolvedValue({ ok: true, data: { room, host: { ...invite, inviteUrl: `https://app-stg.niho.life/t#${"h".repeat(43)}` }, guest: invite } });
    mocks.current.mockResolvedValue({ ok: true, data: { room: null } });
    mocks.get.mockResolvedValue({ ok: true, data: room });
    mocks.reissue.mockResolvedValue({ ok: true, data: { roomId: room.roomId, role: "guest", invite } });
    mocks.end.mockResolvedValue({ ok: true, data: { roomId: room.roomId, state: "ended" } });
    mocks.failure.mockImplementation((failure: { kind: string }) => Response.json({ error: failure.kind }, { status: failure.kind === "conflict" ? 409 : 502 }));
  });

  it("create resolves the local provider before sending the fixed language body to NIHO", async () => {
    const response = await createRoom(mutation(base, '{"hostLanguage":"ja"}'), providerContext());
    expect(response.status).toBe(201);
    expect(mocks.load).toHaveBeenCalledWith("local_provider_1");
    expect(mocks.create).toHaveBeenCalledWith("niho_provider_9", "ja");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("current returns null and create 409 is preserved for browser recovery", async () => {
    expect(await (await getCurrent(new Request(`${base}/current`), providerContext())).json()).toEqual({ room: null });
    expect(mocks.current).toHaveBeenCalledWith("niho_provider_9");
    mocks.create.mockResolvedValueOnce({ ok: false, kind: "conflict" });
    expect((await createRoom(mutation(base, '{"hostLanguage":"en"}'), providerContext())).status).toBe(409);
  });

  it("status, explicit seat reissue and end use the mapped NIHO provider without mixing roles", async () => {
    expect((await getRoom(new Request(`${base}/room_1`), roomContext())).status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith("niho_provider_9", "room_1");
    const reissued = await reissueInvite(mutation(`${base}/room_1/invites/guest`), { params: Promise.resolve({ providerId: "local_provider_1", roomId: "room_1", role: "guest" }) });
    expect(await reissued.json()).toEqual({ roomId: "room_1", role: "guest", invite });
    expect(mocks.reissue).toHaveBeenCalledWith("niho_provider_9", "room_1", "guest");
    expect((await endRoom(mutation(`${base}/room_1/end`), roomContext())).status).toBe(200);
    expect(mocks.end).toHaveBeenCalledWith("niho_provider_9", "room_1");
  });

  it("rejects query, odd ids, cross-origin mutation and non-strict bodies before identity lookup", async () => {
    expect((await getCurrent(new Request(`${base}/current?debug=1`), providerContext())).status).toBe(404);
    expect((await getRoom(new Request(`${base}/room_1`), roomContext(".."))).status).toBe(404);
    expect((await createRoom(mutation(base, '{"hostLanguage":"ja","role":"host"}'), providerContext())).status).toBe(400);
    mocks.allowed.mockReturnValue(false);
    expect((await endRoom(mutation(`${base}/room_1/end`), roomContext())).status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled();
  });
});
