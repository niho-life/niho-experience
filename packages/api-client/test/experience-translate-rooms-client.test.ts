import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createExperienceTranslateRoomsClient } from "../src/experience-translate-rooms/client.ts";
import { decodeExperienceTranslateRoomStatusResponse, isExperienceTranslateRoomPathId } from "../src/experience-translate-rooms/schema.ts";
import type { FetchLike } from "../src/client.ts";

const ORIGIN = "https://niho.example";
const TOKEN = "header.payload.signature";
const ROOMS = "https://niho.example/api/experience-providers/provider_1/bookings/booking_1/translate-rooms";
const invite = (role: "host" | "guest") => ({ participantId: `participant_${role}`, inviteCode: `synthetic-${role}-code`, inviteUrl: `https://app-stg.niho.test/i/synthetic-${role}-code` });
const created = { roomId: "room_1", state: "created", host: invite("host"), guest: invite("guest"), expiresAt: "2026-11-08T01:15:00.000Z" };
const status = { state: "active", participants: [{ role: "host", joined: true, ready: true }, { role: "guest", joined: false, ready: false }], usageMinutes: 2 };

function respond(status: number, body: unknown): ReturnType<typeof vi.fn<FetchLike>> {
  return vi.fn<FetchLike>(async () => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("experience translate rooms transport", () => {
  it("creates a room with an empty JSON object on the pinned path and never forwards cookies, redirects or referrers", async () => {
    const fetcher = respond(201, created);
    const api = createExperienceTranslateRoomsClient({ nihoWebOrigin: ORIGIN, idToken: TOKEN, fetch: fetcher });
    expect(await api.createRoom("provider_1", "booking_1")).toEqual({ ok: true, data: created });
    expect(fetcher).toHaveBeenCalledWith(ROOMS, expect.objectContaining({
      method: "POST", credentials: "omit", redirect: "manual", cache: "no-store", referrerPolicy: "no-referrer", body: "{}",
      headers: { accept: "application/json", authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    }));
  });

  it("reads and ends the room on its own paths", async () => {
    const read = respond(200, status);
    expect(await createExperienceTranslateRoomsClient({ nihoWebOrigin: ORIGIN, idToken: TOKEN, fetch: read }).getRoom("provider_1", "booking_1", "room_1")).toEqual({ ok: true, data: status });
    expect(read).toHaveBeenCalledWith(`${ROOMS}/room_1`, expect.objectContaining({ method: "GET" }));
    const end = respond(200, { state: "ended" });
    expect(await createExperienceTranslateRoomsClient({ nihoWebOrigin: ORIGIN, idToken: TOKEN, fetch: end }).endRoom("provider_1", "booking_1", "room_1")).toEqual({ ok: true, data: { state: "ended" } });
    expect(end).toHaveBeenCalledWith(`${ROOMS}/room_1/end`, expect.objectContaining({ method: "POST", body: "{}" }));
  });

  it("rejects invalid ids before fetch", async () => {
    const fetcher = respond(201, created);
    const api = createExperienceTranslateRoomsClient({ nihoWebOrigin: ORIGIN, idToken: TOKEN, fetch: fetcher });
    expect(await api.createRoom("../private", "booking_1")).toEqual({ ok: false, kind: "invalid_request" });
    expect(await api.getRoom("provider_1", "booking_1", "a/b")).toEqual({ ok: false, kind: "invalid_request" });
    expect(await api.endRoom("provider_1", "", "room_1")).toEqual({ ok: false, kind: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(isExperienceTranslateRoomPathId("room_1")).toBe(true);
    expect(isExperienceTranslateRoomPathId("room%2F1")).toBe(false);
  });

  it("accepts only the pinned shapes: a relay ticket, an unknown state or a third participant is an unexpected response", async () => {
    const api = (body: unknown, status = 200) => createExperienceTranslateRoomsClient({ nihoWebOrigin: ORIGIN, idToken: TOKEN, fetch: respond(status, body) });
    expect(await api({ ...created, ticket: "eyJ.hidden" }, 201).createRoom("provider_1", "booking_1")).toEqual({ ok: false, kind: "unexpected_response", status: 201 });
    expect(await api(created, 200).createRoom("provider_1", "booking_1")).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
    expect(await api({ ...status, state: "live" }).getRoom("provider_1", "booking_1", "room_1")).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
    expect(await api({ ...status, participants: [...status.participants, { role: "guest", joined: true, ready: true }] }).getRoom("provider_1", "booking_1", "room_1")).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
    expect(await api({ state: "ended", usageMinutes: 3 }).endRoom("provider_1", "booking_1", "room_1")).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
    expect(decodeExperienceTranslateRoomStatusResponse({ state: "created", participants: [], usageMinutes: 0 })).toEqual({ state: "created", participants: [], usageMinutes: 0 });
    expect(decodeExperienceTranslateRoomStatusResponse({ state: "created", participants: [], usageMinutes: -1 })).toBeNull();
  });

  it.each([
    [401, { ok: false, kind: "rejected", status: 401 }],
    [403, { ok: false, kind: "rejected", status: 403 }],
    [404, { ok: false, kind: "not_found" }],
    [409, { ok: false, kind: "conflict" }],
  ] as const)("maps %i without exposing upstream error bodies", async (status, expected) => {
    const api = createExperienceTranslateRoomsClient({ nihoWebOrigin: ORIGIN, idToken: TOKEN, fetch: respond(status, { message: "private", relayUrl: "wss://hidden" }) });
    expect(await api.createRoom("provider_1", "booking_1")).toEqual(expected);
  });

  it("treats a timeout as a network error and never retries", async () => {
    const fetcher = vi.fn<FetchLike>(async () => { throw new DOMException("timed out", "TimeoutError"); });
    const api = createExperienceTranslateRoomsClient({ nihoWebOrigin: ORIGIN, idToken: TOKEN, fetch: fetcher, timeoutMs: 1 });
    expect(await api.endRoom("provider_1", "booking_1", "room_1")).toEqual({ ok: false, kind: "network_error" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses a token that cannot be a bearer credential", () => {
    expect(() => createExperienceTranslateRoomsClient({ nihoWebOrigin: ORIGIN, idToken: "bad token\n" })).toThrow();
  });
});
