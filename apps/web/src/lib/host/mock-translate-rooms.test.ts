import { describe, expect, it } from "vitest";
import { createMockTranslateRooms, MOCK_INVITE_ORIGIN, MOCK_INVITE_TTL_MS, MOCK_TIMELINE } from "./mock-translate-rooms";

const ORIGIN = "https://niho.test";
const ROOMS = `${ORIGIN}/api/experience-providers/sample-provider-kitchen/bookings/bk-2038/translate-rooms`;
const headers = { authorization: "Bearer mock-id-token.x" };

function harness(start = 1_000_000) {
  let now = start;
  const rooms = createMockTranslateRooms();
  const deps = { now: () => now, providerExists: async (providerId: string) => providerId === "sample-provider-kitchen" };
  return {
    advance(ms: number) { now += ms; },
    route: (url: string, method = "GET") => rooms.route(new Request(url, { method, headers }), deps),
  };
}

describe("mock translate rooms", () => {
  it("answers only translate-room paths of a provider the host belongs to", async () => {
    const { route } = harness();
    expect(await route(`${ORIGIN}/api/experience-providers/sample-provider-kitchen/bookings/bk-2038`)).toBeNull();
    expect(await route(`${ORIGIN}/api/experience-providers/sample-provider-kitchen/bookings/bk-2038/translate-rooms/extra/parts/here`)).toBeNull();
    expect((await route(`${ORIGIN}/api/experience-providers/other-provider/bookings/bk-2038/translate-rooms`, "POST"))?.status).toBe(404);
    expect((await route(ROOMS, "GET"))?.status).toBe(404);
  });

  it("makes a room with two invite URLs on the test host and both codes only inside those URLs", async () => {
    const { route } = harness();
    const response = await route(ROOMS, "POST");
    expect(response?.status).toBe(201);
    const room = await response!.json() as { roomId: string; state: string; host: { inviteCode: string; inviteUrl: string }; guest: { inviteCode: string; inviteUrl: string }; expiresAt: string };
    expect(room.state).toBe("created");
    expect(room.host.inviteUrl).toBe(`${MOCK_INVITE_ORIGIN}/i/${room.host.inviteCode}`);
    expect(room.guest.inviteUrl).toBe(`${MOCK_INVITE_ORIGIN}/i/${room.guest.inviteCode}`);
    expect(room.host.inviteCode).not.toBe(room.guest.inviteCode);
    expect(new Date(room.expiresAt).getTime()).toBe(1_000_000 + MOCK_INVITE_TTL_MS);
  });

  it("lets the host arrive first, then the guest, counts minutes once active and freezes them at 終了", async () => {
    const { route, advance } = harness();
    const { roomId } = await (await route(ROOMS, "POST"))!.json() as { roomId: string };
    const read = async () => (await route(`${ROOMS}/${roomId}`))!.json() as Promise<{ state: string; participants: { role: string; joined: boolean; ready: boolean }[]; usageMinutes: number }>;
    expect(await read()).toEqual({ state: "created", participants: [{ role: "host", joined: false, ready: false }, { role: "guest", joined: false, ready: false }], usageMinutes: 0 });
    advance(MOCK_TIMELINE.hostJoined);
    expect((await read()).participants[0]).toEqual({ role: "host", joined: true, ready: false });
    advance(MOCK_TIMELINE.hostReady - MOCK_TIMELINE.hostJoined);
    expect((await read()).state).toBe("active");
    advance(MOCK_TIMELINE.guestReady - MOCK_TIMELINE.hostReady);
    expect((await read()).participants[1]).toEqual({ role: "guest", joined: true, ready: true });
    advance(5 * 60_000);
    expect((await read()).usageMinutes).toBe(5);
    const ended = await route(`${ROOMS}/${roomId}/end`, "POST");
    expect(ended?.status).toBe(200);
    expect(await ended!.json()).toEqual({ state: "ended" });
    advance(10 * 60_000);
    expect(await read()).toMatchObject({ state: "ended", usageMinutes: 5 });
    // Ending twice changes nothing.
    expect((await route(`${ROOMS}/${roomId}/end`, "POST"))?.status).toBe(200);
  });

  it("keeps rooms to their own provider and booking and refuses the wrong method", async () => {
    const { route } = harness();
    const { roomId } = await (await route(ROOMS, "POST"))!.json() as { roomId: string };
    expect((await route(`${ORIGIN}/api/experience-providers/sample-provider-kitchen/bookings/bk-2041/translate-rooms/${roomId}`))?.status).toBe(404);
    expect((await route(`${ROOMS}/${roomId}`, "POST"))?.status).toBe(404);
    expect((await route(`${ROOMS}/${roomId}/end`, "GET"))?.status).toBe(404);
    expect((await route(`${ROOMS}/no-such-room`))?.status).toBe(404);
  });
});
