import { describe, expect, it } from "vitest";
import { createMockTranslateRooms, MOCK_INVITE_ORIGIN, MOCK_INVITE_TTL_MS, MOCK_STANDALONE_INVITE_ORIGIN, MOCK_STANDALONE_ROOM_TTL_MS, MOCK_TIMELINE } from "./mock-translate-rooms";

const ORIGIN = "https://niho.test";
const SITE_ROOMS = `${ORIGIN}/api/experience-providers/sample-provider-kitchen/site-bookings/00000000-0000-4000-8000-00000000b101/translate-rooms`;
const STANDALONE_ROOMS = `${ORIGIN}/api/experience-providers/sample-provider-kitchen/translate-rooms`;
const headers = { authorization: "Bearer mock-access-token.x" };

function harness(start = 1_000_000) {
  let now = start;
  const rooms = createMockTranslateRooms();
  const deps = { now: () => now, providerExists: async (providerId: string) => providerId === "sample-provider-kitchen" };
  return {
    advance(ms: number) { now += ms; },
    route: (url: string, method = "GET", body?: string) => rooms.route(new Request(url, { method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body }), deps),
  };
}

describe("mock translate rooms", () => {
  it("keeps one standalone room per provider with current/null, 90-minute room and 15-minute invites", async () => {
    const { route } = harness();
    expect(await (await route(`${STANDALONE_ROOMS}/current`))!.json()).toEqual({ room: null });
    const made = await route(STANDALONE_ROOMS, "POST", '{"hostLanguage":"ja"}');
    expect(made?.status).toBe(201);
    const created = await made!.json() as { room: { roomId: string; hostLanguage: string; guestLanguage: string; expiresAt: string }; host: { inviteUrl: string; expiresAt: string }; guest: { inviteUrl: string } };
    expect(created.room).toMatchObject({ hostLanguage: "ja", guestLanguage: "en" });
    expect(new Date(created.room.expiresAt).getTime()).toBe(1_000_000 + MOCK_STANDALONE_ROOM_TTL_MS);
    expect(new Date(created.host.expiresAt).getTime()).toBe(1_000_000 + MOCK_INVITE_TTL_MS);
    expect(created.host.inviteUrl).toMatch(new RegExp(`^${MOCK_STANDALONE_INVITE_ORIGIN.replaceAll(".", "\\.")}\\/t#`));
    expect(created.guest.inviteUrl).not.toBe(created.host.inviteUrl);
    expect((await route(STANDALONE_ROOMS, "POST", '{"hostLanguage":"en"}'))?.status).toBe(409);
    expect(await (await route(`${STANDALONE_ROOMS}/current`))!.json()).toMatchObject({ room: { roomId: created.room.roomId } });
  });

  it("reissues only the requested standalone seat, resets its synthetic presence, and end clears current", async () => {
    const { route, advance } = harness();
    const created = await (await route(STANDALONE_ROOMS, "POST", '{"hostLanguage":"en"}'))!.json() as { room: { roomId: string }; host: { inviteUrl: string }; guest: { inviteUrl: string } };
    advance(MOCK_TIMELINE.hostReady);
    expect(await (await route(`${STANDALONE_ROOMS}/${created.room.roomId}`))!.json()).toMatchObject({ state: "waiting", usageMinutes: 0 });
    advance(MOCK_TIMELINE.guestReady - MOCK_TIMELINE.hostReady);
    const before = await (await route(`${STANDALONE_ROOMS}/${created.room.roomId}`))!.json() as { participants: { role: string; joined: boolean; ready: boolean }[] };
    expect(before.participants.every((participant) => participant.ready)).toBe(true);
    expect(before).toMatchObject({ state: "active", usageMinutes: 0 });
    advance(60_000);
    expect(await (await route(`${STANDALONE_ROOMS}/${created.room.roomId}`))!.json()).toMatchObject({ state: "active", usageMinutes: 1 });
    const result = await (await route(`${STANDALONE_ROOMS}/${created.room.roomId}/invites/guest`, "POST", "{}"))!.json() as { role: string; invite: { inviteUrl: string } };
    expect(result.role).toBe("guest");
    expect(result.invite.inviteUrl).not.toBe(created.guest.inviteUrl);
    const after = await (await route(`${STANDALONE_ROOMS}/${created.room.roomId}`))!.json() as { participants: { role: string; joined: boolean; ready: boolean }[] };
    expect(after.participants).toEqual([{ role: "host", joined: true, ready: true }, { role: "guest", joined: false, ready: false }]);
    expect((await route(`${STANDALONE_ROOMS}/${created.room.roomId}/end`, "POST", "{}"))?.status).toBe(200);
    expect(await (await route(`${STANDALONE_ROOMS}/current`))!.json()).toEqual({ room: null });
    expect((await route(`${STANDALONE_ROOMS}/${created.room.roomId}/invites/host`, "POST", "{}"))?.status).toBe(404);
  });

  it("answers only translate-room paths of a provider the host belongs to", async () => {
    const { route } = harness();
    expect(await route(`${ORIGIN}/api/experience-providers/sample-provider-kitchen/bookings/bk-2038`)).toBeNull();
    expect(await route(`${ORIGIN}/api/experience-providers/sample-provider-kitchen/bookings/bk-2038/translate-rooms/extra/parts/here`)).toBeNull();
    expect(await route(`${ORIGIN}/api/experience-providers/sample-provider-kitchen/bookings/bk-2038/translate-rooms`)).toBeNull();
    expect((await route(`${ORIGIN}/api/experience-providers/other-provider/site-bookings/00000000-0000-4000-8000-00000000b101/translate-rooms`, "POST"))?.status).toBe(404);
    expect((await route(SITE_ROOMS, "GET"))?.status).toBe(404);
  });

  it("makes a room with two invite URLs on the test host and both codes only inside those URLs", async () => {
    const { route } = harness();
    const response = await route(SITE_ROOMS, "POST");
    expect(response?.status).toBe(201);
    const room = await response!.json() as { roomId: string; state: string; host: { inviteCode: string; inviteUrl: string }; guest: { inviteCode: string; inviteUrl: string }; expiresAt: string };
    expect(room.state).toBe("waiting");
    expect(room.host.inviteUrl).toBe(`${MOCK_INVITE_ORIGIN}/t#${room.host.inviteCode}`);
    expect(room.guest.inviteUrl).toBe(`${MOCK_INVITE_ORIGIN}/t#${room.guest.inviteCode}`);
    expect(room.host.inviteCode).not.toBe(room.guest.inviteCode);
    expect(new Date(room.expiresAt).getTime()).toBe(1_000_000 + MOCK_INVITE_TTL_MS);
  });

  it("lets the host arrive first, then the guest, counts minutes once active and freezes them at 終了", async () => {
    const { route, advance } = harness();
    const { roomId } = await (await route(SITE_ROOMS, "POST"))!.json() as { roomId: string };
    const read = async () => (await route(`${SITE_ROOMS}/${roomId}`))!.json() as Promise<{ state: string; participants: { role: string; joined: boolean; ready: boolean }[]; usageMinutes: number }>;
    expect(await read()).toEqual({ state: "waiting", participants: [{ role: "host", joined: false, ready: false }, { role: "guest", joined: false, ready: false }], usageMinutes: 0 });
    advance(MOCK_TIMELINE.hostJoined);
    expect((await read()).participants[0]).toEqual({ role: "host", joined: true, ready: false });
    advance(MOCK_TIMELINE.hostReady - MOCK_TIMELINE.hostJoined);
    expect((await read()).state).toBe("active");
    advance(MOCK_TIMELINE.guestReady - MOCK_TIMELINE.hostReady);
    expect((await read()).participants[1]).toEqual({ role: "guest", joined: true, ready: true });
    advance(5 * 60_000);
    expect((await read()).usageMinutes).toBe(5);
    const ended = await route(`${SITE_ROOMS}/${roomId}/end`, "POST");
    expect(ended?.status).toBe(200);
    expect(await ended!.json()).toEqual({ roomId, state: "ended" });
    advance(10 * 60_000);
    expect(await read()).toMatchObject({ state: "ended", usageMinutes: 5 });
    // Ending twice changes nothing.
    expect((await route(`${SITE_ROOMS}/${roomId}/end`, "POST"))?.status).toBe(200);
  });

  it("keeps rooms to their own provider and booking and refuses the wrong method", async () => {
    const { route } = harness();
    const { roomId } = await (await route(SITE_ROOMS, "POST"))!.json() as { roomId: string };
    expect((await route(`${ORIGIN}/api/experience-providers/sample-provider-kitchen/site-bookings/00000000-0000-4000-8000-00000000b102/translate-rooms/${roomId}`))?.status).toBe(404);
    expect((await route(`${SITE_ROOMS}/${roomId}`, "POST"))?.status).toBe(404);
    expect((await route(`${SITE_ROOMS}/${roomId}/end`, "GET"))?.status).toBe(404);
    expect((await route(`${SITE_ROOMS}/no-such-room`))?.status).toBe(404);
  });
});
