import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingMessagesClosedError,
  StoreConflictError,
  StoreRateLimitedError,
  StoreValidationError,
  type GuestBookingConversation,
} from "@niho-experience/experience-store";

/** 予約ごとのメッセージ on the guest's booking page (#285 slice 6b): the route, the browser call and the page's copy. Synthetic data only. */
const state = vi.hoisted(() => ({
  config: { guestBookingEnabled: true, guestMailEnabled: true, siteUrl: "https://experience.example" },
  messages: null as null | Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/store-server", () => ({ guestBookingMessages: () => state.messages }));

import { POST as send } from "@/app/api/public/bookings/messages/route";
import { BookingMessages, bookingMessageProblem } from "@/components/BookingMessages";
import { sendBookingMessage } from "./guest-booking-page";

const ORIGIN = "https://experience.example";
const SESSION = "sampleSessionAbcdefghijklmnopqrstuvwxyz0123";
const BOOKING = "0f8fad5b-d9cb-469f-a165-708677289501";
const KEY = "6f1c2b9e-3a4d-4c5e-8f70-112233445566";
const COOKIE = `__Host-nb_${createHash("sha256").update(BOOKING).digest("hex").slice(0, 8)}`;
const valid = { publicBookingId: BOOKING, clientRequestKey: KEY, message: "Is there parking nearby?" };

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/public/bookings/messages`, {
    method: "POST",
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", cookie: `${COOKIE}=${SESSION}`, ...headers },
    body: JSON.stringify(body),
  });
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.config = { guestBookingEnabled: true, guestMailEnabled: true, siteUrl: ORIGIN };
  state.messages = { sendMessage: vi.fn(async () => ({ status: "received", repeated: false })) };
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  errors.mockRestore();
});

describe("POST /api/public/bookings/messages", () => {
  it("sends the guest's words with the session of that booking's cookie, privately and never cached", async () => {
    const response = await send(post(valid));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "received" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(state.messages?.sendMessage).toHaveBeenCalledExactlyOnceWith(SESSION, BOOKING, { message: valid.message, clientRequestKey: KEY });
  });

  it("answers each refusal so the page can say what happened", async () => {
    const cases: [Error, number, unknown][] = [
      [new BookingMessagesClosedError(), 409, { error: "CLOSED" }],
      [new StoreConflictError("synthetic"), 409, { error: "CONFLICT" }],
      [new StoreValidationError("synthetic"), 422, null],
    ];
    for (const [error, status, body] of cases) {
      state.messages!.sendMessage!.mockRejectedValueOnce(error);
      const response = await send(post(valid));
      expect(response.status).toBe(status);
      if (body) expect(await response.json()).toEqual(body);
    }
    state.messages!.sendMessage!.mockRejectedValueOnce(new StoreRateLimitedError(1200));
    const limited = await send(post(valid));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1200");
    // A store failure: 503, logged by class name only, never the words.
    state.messages!.sendMessage!.mockRejectedValueOnce(new Error(`synthetic outage ${valid.message}`));
    expect((await send(post(valid))).status).toBe(503);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("parking");
  });

  it("refuses another site, a booking without its session, and anything but its fields, before the store", async () => {
    expect((await send(post(valid, { origin: "https://other.example" }))).status).toBe(403);
    expect((await send(post(valid, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await send(post(valid, { cookie: "" }))).status).toBe(404);
    expect((await send(post(valid, { cookie: `${COOKIE}=not-a-session` }))).status).toBe(404);
    for (const body of [{ ...valid, publicBookingId: "not-a-booking" }, { ...valid, message: 42 }, { ...valid, clientRequestKey: null }, ["array"]]) {
      expect((await send(post(body))).status).toBe(400);
    }
    expect((await send(post({ ...valid, message: "x".repeat(5000) }))).status).toBe(413);
    expect(state.messages?.sendMessage).not.toHaveBeenCalled();
    // The session does not open this booking (ended, revoked, another booking's): the same 404.
    state.messages!.sendMessage!.mockResolvedValueOnce(null);
    expect((await send(post(valid))).status).toBe(404);
  });

  it("is not there while the booking page is off, and says unavailable without the experience DB", async () => {
    state.config = { ...state.config, guestMailEnabled: false };
    expect((await send(post(valid))).status).toBe(404);
    state.config = { ...state.config, guestMailEnabled: true };
    state.messages = null;
    expect((await send(post(valid))).status).toBe(503);
  });
});

describe("sendBookingMessage (the browser's call)", () => {
  const answer = (status: number, body: unknown = null, headers: Record<string, string> = {}) =>
    vi.fn(async () => new Response(body === null ? null : JSON.stringify(body), { status, headers }));

  it("posts same-origin with the booking's cookie and reads each answer", async () => {
    const fetchImpl = answer(200, { status: "received" });
    expect(await sendBookingMessage(valid, fetchImpl)).toEqual({ kind: "sent" });
    const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/public/bookings/messages");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "same-origin" });
    expect(JSON.parse(String(init.body))).toEqual(valid);

    expect(await sendBookingMessage(valid, answer(409, { error: "CLOSED" }))).toEqual({ kind: "closed" });
    expect(await sendBookingMessage(valid, answer(409, { error: "CONFLICT" }))).toEqual({ kind: "conflict" });
    expect(await sendBookingMessage(valid, answer(429, null, { "retry-after": "90" }))).toEqual({ kind: "limited", retryAfterSeconds: 90 });
    expect(await sendBookingMessage(valid, answer(429))).toEqual({ kind: "limited", retryAfterSeconds: 3600 });
    expect(await sendBookingMessage(valid, answer(422))).toEqual({ kind: "invalid" });
    expect(await sendBookingMessage(valid, answer(404))).toEqual({ kind: "signedOut" });
    expect(await sendBookingMessage(valid, answer(503))).toEqual({ kind: "failed" });
    expect(await sendBookingMessage(valid, vi.fn(async () => Promise.reject(new TypeError("offline"))))).toEqual({ kind: "failed" });
  });
});

describe("the booking page's messages", () => {
  const conversation = (open: boolean): GuestBookingConversation => ({
    open,
    messages: [
      { id: "m-1", from: "guest", atUtc: "2026-11-01T01:00:00.000Z", body: "Is there parking nearby?" },
      { id: "m-2", from: "host", atUtc: "2026-11-01T02:30:00.000Z", body: "Yes, right next to the station." },
    ],
  });
  const render = (value: GuestBookingConversation | null) =>
    renderToStaticMarkup(createElement(BookingMessages, { publicBookingId: BOOKING, hostDisplayName: "Sample Host", timeZone: "Asia/Tokyo", conversation: value }));

  it("shows the guest's words and the host's English, in the experience's time, with a box while the booking takes messages", () => {
    const html = render(conversation(true));
    expect(html).toContain("Is there parking nearby?");
    expect(html).toContain("Yes, right next to the station.");
    expect(html).toContain("Sun 1 Nov, 11:30");
    expect(html).toContain("Write to Sample Host");
    expect(html).toContain('maxLength="1000"');
    expect(html).toContain("Send message");
  });

  it("shows a cancelled or long-over booking's history without a box, an empty one with a word to start, and a read failure", () => {
    const closed = render(conversation(false));
    expect(closed).toContain("Yes, right next to the station.");
    expect(closed).not.toContain("<textarea");
    expect(closed).toContain("This booking no longer takes messages.");
    expect(render({ open: true, messages: [] })).toContain("No messages yet. Write to Sample Host about this booking");
    const failed = render(null);
    expect(failed).toContain("We couldn&#x27;t load your messages with Sample Host.");
    expect(failed).not.toContain("<textarea");
  });

  it("says what happened after a send that did not go through", () => {
    expect(bookingMessageProblem({ kind: "sent" }, "Sample Host")).toBeNull();
    expect(bookingMessageProblem({ kind: "closed" }, "Sample Host")?.title).toBe("This booking no longer takes messages");
    expect(bookingMessageProblem({ kind: "limited", retryAfterSeconds: 61 }, "Sample Host")?.title).toContain("try again in 2 minutes");
    expect(bookingMessageProblem({ kind: "limited", retryAfterSeconds: 30 }, "Sample Host")?.title).toContain("try again in 1 minute.");
    expect(bookingMessageProblem({ kind: "failed" }, "Sample Host")).toMatchObject({ tone: "danger", body: "Trying again is safe: it won't be sent twice." });
    expect(bookingMessageProblem({ kind: "invalid" }, "Sample Host")?.title).toBe("Write a message of up to 1000 characters.");
    expect(bookingMessageProblem({ kind: "signedOut" }, "Sample Host")?.title).toBe("This booking isn't open on this device any more");
    expect(bookingMessageProblem({ kind: "conflict" }, "Sample Host")?.tone).toBe("danger");
  });
});
