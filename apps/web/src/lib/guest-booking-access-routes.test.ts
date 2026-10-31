import { createHash } from "node:crypto";
import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreValidationError } from "@niho-experience/experience-store";

/** 予約者の予約ページ (#285 slice 6): its routes and the booking page against a stubbed store, synthetic data only. */
const state = vi.hoisted(() => ({
  config: { guestBookingEnabled: true, guestMailEnabled: true, translationEnabled: false, siteUrl: "https://experience.example" },
  access: null as null | Record<string, ReturnType<typeof vi.fn>>,
  messages: null as null | Record<string, ReturnType<typeof vi.fn>>,
  cookies: new Map<string, string>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/store-server", () => ({ guestBookingAccess: () => state.access, guestBookingMessages: () => state.messages }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (state.cookies.has(name) ? { name, value: state.cookies.get(name)! } : undefined) }) }));
vi.mock("next/navigation", async (importActual) => ({
  ...(await importActual<typeof import("next/navigation")>()),
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { POST as openSession } from "@/app/api/public/bookings/session/route";
import { POST as requestLink } from "@/app/api/public/bookings/link/route";
import { POST as signOut } from "@/app/api/public/bookings/sign-out/route";
import GuestBookingPage from "@/app/(site)/bookings/[publicBookingId]/page";
import BookingOpenPage from "@/app/(site)/bookings/open/page";
import FindBookingPage from "@/app/(site)/bookings/page";
import { BookingNotOpen, BookingUnavailable, GuestBookingDetails } from "@/components/GuestBookingDetails";
import { bookingSessionCookieName } from "@/lib/experience/booking-access-http";

const ORIGIN = "https://experience.example";
const GRANT = "sampleGrantAbcdefghijklmnopqrstuvwxyz012345";
const SESSION = "sampleSessionAbcdefghijklmnopqrstuvwxyz0123";
const BOOKING = "0f8fad5b-d9cb-469f-a165-708677289501";
const OTHER = "1f8fad5b-d9cb-469f-a165-708677289502";
const EXPIRES = "2026-12-31T00:00:00.000Z";
const CONVERSATION = { open: true, messages: [{ id: "m-1", from: "host", atUtc: "2026-11-01T02:30:00.000Z", body: "Welcome!" }] };
const COOKIE = `__Host-nb_${createHash("sha256").update(BOOKING).digest("hex").slice(0, 8)}`;
const VIEW = {
  publicBookingId: BOOKING, status: "CONFIRMED", experienceTitle: "Synthetic walk", experienceSlug: "sample-walk",
  localDate: "2026-11-14", localStartTime: "10:00", timeZone: "Asia/Tokyo", startUtc: "2026-11-14T01:00:00.000Z", endUtc: "2026-11-14T02:30:00.000Z",
  adultCount: 2, childCount: 1, totalAmount: 7500, currency: "JPY", cancellationPolicy: "FREE_UNTIL_48H", freeCancellationUntilUtc: "2026-11-12T01:00:00.000Z",
  hostDisplayName: "Sample Host", guestName: "Sample Guest", bookedAtUtc: "2026-10-31T01:00:00.000Z", cancelledAtUtc: null,
};

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Every answer: never stored by a cache, indexed or sent on with a Referer. */
function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
}

beforeEach(() => {
  state.config = { guestBookingEnabled: true, guestMailEnabled: true, translationEnabled: false, siteUrl: ORIGIN };
  state.cookies = new Map();
  state.access = {
    openBookingSession: vi.fn(async () => ({ sessionId: SESSION, publicBookingId: BOOKING, expiresAtUtc: EXPIRES })),
    readBookingSession: vi.fn(async () => VIEW),
    endBookingSession: vi.fn(async () => {}),
    requestBookingLink: vi.fn(async () => {}),
  };
  state.messages = { readConversation: vi.fn(async () => CONVERSATION) };
});

describe("POST /api/public/bookings/session", () => {
  it("opens a grant from the body only and sets that booking's session cookie: HttpOnly, Secure, Lax, host-only", async () => {
    vi.useFakeTimers({ now: new Date("2026-12-01T00:00:00.000Z") });
    try {
      const response = await openSession(post("/api/public/bookings/session", { grant: GRANT }));
      expect(response.status).toBe(200);
      expectPrivate(response);
      expect(await response.json()).toEqual({ publicBookingId: BOOKING });
      expect(state.access?.openBookingSession).toHaveBeenCalledExactlyOnceWith(GRANT);
      expect(response.headers.get("set-cookie")).toBe(`${COOKIE}=${SESSION}; Max-Age=2592000; Path=/; Secure; HttpOnly; SameSite=Lax`);
      expect(response.headers.get("set-cookie")).not.toMatch(/Domain=/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a closed link with an empty 404, whatever the reason, and sets nothing", async () => {
    state.access!.openBookingSession!.mockResolvedValueOnce(null);
    for (const body of [{ grant: GRANT }, { grant: "short" }, { grant: 7 }, {}]) {
      const response = await openSession(post("/api/public/bookings/session", body));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
      expect(response.headers.get("set-cookie")).toBeNull();
      expectPrivate(response);
    }
    expect(state.access?.openBookingSession).toHaveBeenCalledOnce();
  });

  it("refuses other sites, bodies that are not a small JSON object, and is a 404 while either flag is off", async () => {
    for (const headers of [{ origin: "https://other.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      expect((await openSession(post("/api/public/bookings/session", { grant: GRANT }, headers))).status).toBe(403);
    }
    expect((await openSession(post("/api/public/bookings/session", "[]"))).status).toBe(400);
    expect((await openSession(post("/api/public/bookings/session", { grant: GRANT }, { "content-type": "text/plain" }))).status).toBe(400);
    expect((await openSession(post("/api/public/bookings/session", { grant: GRANT, padding: "x".repeat(5000) }))).status).toBe(413);
    expect(state.access?.openBookingSession).not.toHaveBeenCalled();
    for (const flags of [{ guestBookingEnabled: false }, { guestMailEnabled: false }]) {
      state.config = { ...state.config, guestBookingEnabled: true, guestMailEnabled: true, ...flags };
      expect((await openSession(post("/api/public/bookings/session", { grant: GRANT }))).status).toBe(404);
    }
  });

  it("is an empty 503 without the DB or when the store fails", async () => {
    state.access!.openBookingSession!.mockRejectedValueOnce(new Error("connect ECONNREFUSED (guest@example.com)"));
    const failed = await openSession(post("/api/public/bookings/session", { grant: GRANT }));
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe("");
    state.access = null;
    expect((await openSession(post("/api/public/bookings/session", { grant: GRANT }))).status).toBe(503);
  });
});

describe("POST /api/public/bookings/link", () => {
  it("answers the same 202 whether or not the address has a booking, and passes the address to the store only", async () => {
    const answers: string[] = [];
    for (const email of ["guest@example.com", "nobody@example.com"]) {
      const response = await requestLink(post("/api/public/bookings/link", { email }));
      expect(response.status).toBe(202);
      expectPrivate(response);
      expect(response.headers.get("set-cookie")).toBeNull();
      answers.push(await response.text());
    }
    expect(answers).toEqual([JSON.stringify({ accepted: true }), JSON.stringify({ accepted: true })]);
    expect(state.access?.requestBookingLink?.mock.calls).toEqual([[{ email: "guest@example.com" }], [{ email: "nobody@example.com" }]]);
  });

  it("is a 422 for something that is not an address, 403 from other sites and 503 when the store fails", async () => {
    state.access!.requestBookingLink!.mockRejectedValueOnce(new StoreValidationError("email must be an email address."));
    expect((await requestLink(post("/api/public/bookings/link", { email: "not-an-address" }))).status).toBe(422);
    expect((await requestLink(post("/api/public/bookings/link", { email: 7 }))).status).toBe(422);
    expect((await requestLink(post("/api/public/bookings/link", { email: "guest@example.com" }, { origin: "https://other.example" }))).status).toBe(403);
    state.access!.requestBookingLink!.mockRejectedValueOnce(new Error("synthetic outage"));
    expect((await requestLink(post("/api/public/bookings/link", { email: "guest@example.com" }))).status).toBe(503);
    state.config = { ...state.config, guestMailEnabled: false };
    expect((await requestLink(post("/api/public/bookings/link", { email: "guest@example.com" }))).status).toBe(404);
  });
});

describe("POST /api/public/bookings/sign-out", () => {
  it("ends this booking's session and removes its cookie", async () => {
    const response = await signOut(post("/api/public/bookings/sign-out", { publicBookingId: BOOKING.toUpperCase() }, { cookie: `other=1; ${COOKIE}=${SESSION}` }));
    expect(response.status).toBe(204);
    expectPrivate(response);
    expect(state.access?.endBookingSession).toHaveBeenCalledExactlyOnceWith(SESSION);
    expect(response.headers.get("set-cookie")).toBe(`${COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`);
  });

  it("answers alike without a session, ends nothing for another booking's cookie, and refuses other sites", async () => {
    const without = await signOut(post("/api/public/bookings/sign-out", { publicBookingId: OTHER }, { cookie: `${COOKIE}=${SESSION}` }));
    expect(without.status).toBe(204);
    expect(state.access?.endBookingSession).not.toHaveBeenCalled();
    expect(without.headers.get("set-cookie")).toContain(`${bookingSessionCookieName(OTHER)}=; Max-Age=0`);
    expect((await signOut(post("/api/public/bookings/sign-out", { publicBookingId: "not-a-booking" }))).status).toBe(400);
    expect((await signOut(post("/api/public/bookings/sign-out", { publicBookingId: BOOKING }, { origin: "https://other.example", cookie: `${COOKIE}=${SESSION}` }))).status).toBe(403);
    expect(state.access?.endBookingSession).not.toHaveBeenCalled();
    state.access!.endBookingSession!.mockRejectedValueOnce(new Error("synthetic outage"));
    const failed = await signOut(post("/api/public/bookings/sign-out", { publicBookingId: BOOKING }, { cookie: `${COOKIE}=${SESSION}` }));
    expect(failed.status).toBe(503);
    expect(failed.headers.get("set-cookie")).toBeNull();
  });
});

describe("the guest's booking pages", () => {
  async function bookingPage(id: string): Promise<ReactElement<Record<string, unknown>>> {
    const element: unknown = await GuestBookingPage({ params: Promise.resolve({ publicBookingId: id }) });
    expect(isValidElement(element)).toBe(true);
    return element as ReactElement<Record<string, unknown>>;
  }

  it("shows the booking to the session for it, read from that booking's cookie only", async () => {
    state.cookies.set(COOKIE, SESSION);
    const view = await bookingPage(BOOKING);
    expect(view.type).toBe(GuestBookingDetails);
    expect(view.props.booking).toEqual(VIEW);
    expect(state.access?.readBookingSession).toHaveBeenCalledExactlyOnceWith(SESSION, BOOKING);
    // The messages with the host (#285 slice 6b), read with the same session.
    expect(view.props.conversation).toEqual(CONVERSATION);
    expect(state.messages?.readConversation).toHaveBeenCalledExactlyOnceWith(SESSION, BOOKING);
  });

  it("tells the page whether the guest's messages are translated into Japanese, so it may say so (privacy notice, #285)", async () => {
    state.cookies.set(COOKIE, SESSION);
    // Off while translation is off (the booking page itself is open: it needs the mail setting).
    expect((await bookingPage(BOOKING)).props.translationNotice).toBe(false);
    state.config = { ...state.config, translationEnabled: true };
    expect((await bookingPage(BOOKING)).props.translationNotice).toBe(true);
  });

  it("still shows the booking when only its messages cannot be read (#285 slice 6b)", async () => {
    state.cookies.set(COOKIE, SESSION);
    state.messages!.readConversation!.mockRejectedValueOnce(new Error("synthetic outage"));
    const view = await bookingPage(BOOKING);
    expect(view.type).toBe(GuestBookingDetails);
    expect(view.props.conversation).toBeNull();
  });

  it("shows the same neutral page without a session, for another booking's cookie, an unknown ID or a refused session", async () => {
    state.cookies.set(COOKIE, SESSION);
    // This booking's cookie is never read for another booking.
    expect((await bookingPage(OTHER)).type).toBe(BookingNotOpen);
    expect((await bookingPage("not-a-booking")).type).toBe(BookingNotOpen);
    expect(state.access?.readBookingSession).not.toHaveBeenCalled();
    state.access!.readBookingSession!.mockResolvedValueOnce(null);
    expect((await bookingPage(BOOKING)).type).toBe(BookingNotOpen);
    state.cookies.set(COOKIE, "not-a-session");
    expect((await bookingPage(BOOKING)).type).toBe(BookingNotOpen);
    expect(state.access?.readBookingSession).toHaveBeenCalledOnce();
  });

  it("says the booking could not be read when the store fails, and is a 404 while either flag is off", async () => {
    state.cookies.set(COOKIE, SESSION);
    state.access!.readBookingSession!.mockRejectedValueOnce(new Error("synthetic outage"));
    expect((await bookingPage(BOOKING)).type).toBe(BookingUnavailable);
    state.config = { ...state.config, guestMailEnabled: false };
    await expect(bookingPage(BOOKING)).rejects.toThrow("NOT_FOUND");
    expect(() => BookingOpenPage()).toThrow("NOT_FOUND");
    expect(() => FindBookingPage()).toThrow("NOT_FOUND");
    state.config = { ...state.config, guestMailEnabled: true, guestBookingEnabled: false };
    expect(() => BookingOpenPage()).toThrow("NOT_FOUND");
    state.config = { ...state.config, guestBookingEnabled: true };
    expect(isValidElement(BookingOpenPage())).toBe(true);
    expect(isValidElement(FindBookingPage())).toBe(true);
  });
});
