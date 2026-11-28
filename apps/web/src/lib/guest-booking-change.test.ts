import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreConflictError, StoreValidationError, type BookingNoticeEmail, type GuestBookingView } from "@niho-experience/experience-store";

/** 予約の日時変更 (#720 stage 1): the two routes, the page's calls, the page's section and the guest's email. Synthetic data only. */
const state = vi.hoisted(() => ({
  config: { guestBookingEnabled: true, guestMailEnabled: true, guestBookingChangeEnabled: true, siteUrl: "https://experience.example" },
  changes: null as null | Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/store-server", () => ({ bookingChanges: () => state.changes }));

import { POST as change } from "@/app/api/public/bookings/change/route";
import { POST as options } from "@/app/api/public/bookings/change/options/route";
import { GuestBookingDetails } from "@/components/GuestBookingDetails";
import { changeBookingDate, loadBookingChangeOptions } from "./guest-booking-page";
import { bookingNoticeEmail } from "./mail/templates";

const ORIGIN = "https://experience.example";
const SESSION = "sampleSessionAbcdefghijklmnopqrstuvwxyz0123";
const BOOKING = "0f8fad5b-d9cb-469f-a165-708677289501";
const COMMAND = "6f1c2b9e-3a4d-4c5e-8f70-112233445566";
const COOKIE = `__Host-nb_${createHash("sha256").update(BOOKING).digest("hex").slice(0, 8)}`;
const FROM = "2026-11-14T01:00:00.000Z";
const TO = "2026-11-16T01:00:00.000Z";
const NEW_DEADLINE = "2026-11-14T01:00:00.000Z";
const OPTION = { date: "2026-11-16", startAtUtc: TO, endAtUtc: "2026-11-16T02:30:00.000Z", seatsLeft: 5, newDeadlineUtc: NEW_DEADLINE };
const OFFERED = { changeable: true, fromStartUtc: FROM, changesUsed: 0, maxChanges: 2, options: [OPTION] };

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", cookie: `${COOKIE}=${SESSION}`, ...headers },
    body: JSON.stringify(body),
  });
}
const valid = { publicBookingId: BOOKING, commandId: COMMAND, toDate: "2026-11-16", shownFromStartUtc: FROM, shownToStartUtc: TO, shownNewDeadlineUtc: NEW_DEADLINE };
const changeRequest = (body: unknown, headers?: Record<string, string>) => post("/api/public/bookings/change", body, headers);
const optionsRequest = (body: unknown, headers?: Record<string, string>) => post("/api/public/bookings/change/options", body, headers);

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.config = { guestBookingEnabled: true, guestMailEnabled: true, guestBookingChangeEnabled: true, siteUrl: ORIGIN };
  state.changes = {
    listChangeOptions: vi.fn(async () => OFFERED),
    changeAsGuest: vi.fn(async () => ({ outcome: "OK", repeated: false, changeNumber: 1 })),
  };
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  errors.mockRestore();
});

describe("POST /api/public/bookings/change/options", () => {
  it("lists the dates with the session of that booking's cookie, privately and without anything personal", async () => {
    const response = await options(optionsRequest({ publicBookingId: BOOKING }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(OFFERED);
    expect(state.changes!.listChangeOptions).toHaveBeenCalledExactlyOnceWith(SESSION, BOOKING);
    state.changes!.listChangeOptions!.mockResolvedValueOnce({ changeable: false });
    expect(await (await options(optionsRequest({ publicBookingId: BOOKING }))).json()).toEqual({ changeable: false, options: [] });
  });

  it("answers 404 without a session or while a flag is off, 403 for other sites, 400 for a malformed body and 503 when the store fails", async () => {
    expect((await options(optionsRequest({ publicBookingId: BOOKING }, { cookie: "" }))).status).toBe(404);
    state.changes!.listChangeOptions!.mockResolvedValueOnce(null);
    expect((await options(optionsRequest({ publicBookingId: BOOKING }))).status).toBe(404);
    expect((await options(optionsRequest({ publicBookingId: BOOKING }, { origin: "https://elsewhere.example" }))).status).toBe(403);
    expect((await options(optionsRequest({ publicBookingId: "not-a-booking" }))).status).toBe(400);
    state.changes!.listChangeOptions!.mockRejectedValueOnce(new Error(`database down ${BOOKING}`));
    expect((await options(optionsRequest({ publicBookingId: BOOKING }))).status).toBe(503);
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/0f8fad5b|database down/);
    for (const config of [
      { ...state.config, guestBookingChangeEnabled: false },
      { ...state.config, guestMailEnabled: false },
      { ...state.config, guestBookingEnabled: false },
    ]) {
      state.config = config;
      expect((await options(optionsRequest({ publicBookingId: BOOKING }))).status).toBe(404);
    }
  });
});

describe("POST /api/public/bookings/change", () => {
  it("moves the booking with what the page showed and answers the outcome only", async () => {
    const response = await change(changeRequest(valid));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ outcome: "OK" });
    expect(state.changes!.changeAsGuest).toHaveBeenCalledExactlyOnceWith(SESSION, BOOKING, {
      commandId: COMMAND, toDate: "2026-11-16", shownFromStartUtc: FROM, shownToStartUtc: TO, shownNewDeadlineUtc: NEW_DEADLINE,
    });
    for (const outcome of ["CHANGED", "FULL", "NOT_CHANGEABLE"]) {
      state.changes!.changeAsGuest!.mockResolvedValueOnce({ outcome, repeated: false });
      expect(await (await change(changeRequest(valid))).json()).toEqual({ outcome });
    }
  });

  it("refuses other sites, malformed bodies and a missing session as the booking page does", async () => {
    expect((await change(changeRequest(valid, { origin: "https://elsewhere.example" }))).status).toBe(403);
    expect((await change(changeRequest(valid, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    for (const body of [
      { ...valid, publicBookingId: "not-a-booking" },
      { ...valid, commandId: "not-a-uuid" },
      { ...valid, toDate: "16 Nov" },
      { ...valid, shownFromStartUtc: "2026-11-14" },
      { ...valid, shownToStartUtc: null },
      { ...valid, shownNewDeadlineUtc: undefined },
    ]) {
      expect((await change(changeRequest(body))).status).toBe(400);
    }
    expect((await change(changeRequest(valid, { cookie: "" }))).status).toBe(404);
    state.changes!.changeAsGuest!.mockResolvedValueOnce(null);
    expect((await change(changeRequest(valid))).status).toBe(404);
    expect(state.changes!.changeAsGuest).toHaveBeenCalledOnce();
  });

  it("answers 409 for a command reused with other input, 400 for input the store refuses, 503 when it fails, and 404 while the flag is off", async () => {
    state.changes!.changeAsGuest!.mockRejectedValueOnce(new StoreConflictError("The command ID was already used with different input."));
    expect((await change(changeRequest(valid))).status).toBe(409);
    state.changes!.changeAsGuest!.mockRejectedValueOnce(new StoreValidationError("toDate must be a YYYY-MM-DD date."));
    expect((await change(changeRequest({ ...valid, toDate: "2026-02-30" }))).status).toBe(400);
    state.changes!.changeAsGuest!.mockRejectedValueOnce(new Error(`database down ${BOOKING}`));
    expect((await change(changeRequest(valid))).status).toBe(503);
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/0f8fad5b|database down|2026-11-16/);
    state.config = { ...state.config, guestBookingChangeEnabled: false };
    expect((await change(changeRequest(valid))).status).toBe(404);
  });
});

describe("the page's calls", () => {
  const reply = (status: number, body?: unknown) => vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));

  it("reads the dates same-origin with the cookie, and refuses an answer of another shape", async () => {
    const fetchImpl = reply(200, OFFERED);
    expect(await loadBookingChangeOptions(BOOKING, fetchImpl)).toEqual({ kind: "options", fromStartUtc: FROM, changesUsed: 0, maxChanges: 2, options: [OPTION] });
    expect(fetchImpl).toHaveBeenCalledWith("/api/public/bookings/change/options", expect.objectContaining({ method: "POST", credentials: "same-origin", referrerPolicy: "same-origin", redirect: "error" }));
    expect(await loadBookingChangeOptions(BOOKING, reply(200, { changeable: false, options: [] }))).toEqual({ kind: "notChangeable" });
    expect(await loadBookingChangeOptions(BOOKING, reply(404))).toEqual({ kind: "closed" });
    expect(await loadBookingChangeOptions(BOOKING, reply(503))).toEqual({ kind: "failed" });
    expect(await loadBookingChangeOptions(BOOKING, reply(200, { ...OFFERED, options: [{ ...OPTION, seatsLeft: "5" }] }))).toEqual({ kind: "failed" });
  });

  it("sends the change and reads its outcome; a lost answer is a failure to retry with the same command", async () => {
    const fetchImpl = reply(200, { outcome: "OK" });
    const input = { publicBookingId: BOOKING, commandId: COMMAND, toDate: "2026-11-16", shownFromStartUtc: FROM, shownToStartUtc: TO, shownNewDeadlineUtc: NEW_DEADLINE };
    expect(await changeBookingDate(input, fetchImpl)).toEqual({ kind: "done", outcome: "OK" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/public/bookings/change", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
    expect(await changeBookingDate(input, reply(200, { outcome: "FULL" }))).toEqual({ kind: "done", outcome: "FULL" });
    expect(await changeBookingDate(input, reply(404))).toEqual({ kind: "closed" });
    expect(await changeBookingDate(input, reply(409))).toEqual({ kind: "conflict" });
    expect(await changeBookingDate(input, reply(503))).toEqual({ kind: "failed" });
    expect(await changeBookingDate(input, reply(200, { outcome: "MOVED" }))).toEqual({ kind: "failed" });
    expect(await changeBookingDate(input, vi.fn(async () => { throw new TypeError("offline"); }))).toEqual({ kind: "failed" });
  });
});

describe("the booking page's date change section", () => {
  const VIEW: GuestBookingView = {
    publicBookingId: BOOKING, status: "CONFIRMED", experienceTitle: "Synthetic walk", experienceSlug: "sample-walk",
    localDate: "2026-11-14", localStartTime: "10:00", timeZone: "Asia/Tokyo", startUtc: FROM, endUtc: "2026-11-14T02:30:00.000Z",
    adultCount: 2, childCount: 1, totalAmount: 7500, currency: "JPY", cancellationPolicy: "FREE_UNTIL_48H", cancellationRefundBasisPoints: 10000,
    freeCancellationUntilUtc: "2026-11-12T01:00:00.000Z", hostDisplayName: "Sample Host", guestName: "Sample Guest", guestLanguage: "EN",
    bookedAtUtc: "2026-10-31T01:00:00.000Z", cancelledAtUtc: null, cancelledBy: null, cancellationReason: null, freeCancellationOpen: true,
    experienceEnded: false, refunds: [], cancellationRequest: null,
  };
  const NOW = new Date("2026-11-01T00:00:00.000Z");
  const page = (booking: Partial<GuestBookingView>, changeable = true) =>
    renderToStaticMarkup(createElement(GuestBookingDetails, { booking: { ...VIEW, ...booking }, now: NOW, changeable }));

  it("offers \"Change date\" only for a confirmed booking the server found changeable", () => {
    const html = page({});
    expect(html).toContain("Change date");
    expect(html).toContain("You can move this booking to another date of the same experience, for the same group and price.");
    expect(html.indexOf("Change date")).toBeLessThan(html.indexOf("Cancel and get a full refund"));
    expect(page({}, false)).not.toContain("Change date");
    expect(page({ status: "CANCELLED", freeCancellationOpen: false, cancelledAtUtc: "2026-11-02T00:00:00.000Z", cancelledBy: "HOST", cancellationReason: "WEATHER" })).not.toContain("Change date");
    expect(page({ experienceEnded: true })).not.toContain("Change date");
    const japanese = page({ guestLanguage: "JA" });
    expect(japanese).toContain("日付を変更する");
    expect(japanese).not.toContain("Change date");
  });
});

describe("the guest's email about the new date", () => {
  const facts = {
    publicBookingId: BOOKING, guestEmail: "guest@example.com", guestName: "Sample Guest", guestLanguage: "EN" as const,
    experienceTitle: "Synthetic walk", experienceSlug: "sample-walk", localDate: "2026-11-16", localStartTime: "10:00", timeZone: "Asia/Tokyo",
    hostDisplayName: "Sample Host",
  };
  const changed: BookingNoticeEmail = {
    ...facts, kind: "CHANGED", fromLocalDate: "2026-11-14", fromLocalStartTime: "10:00", fromTimeZone: "Asia/Tokyo",
    totalAmount: 7500, currency: "JPY", freeCancellationUntilUtc: NEW_DEADLINE,
  };

  it("says both dates, the same price, the new deadline and links to the booking page once", () => {
    const mail = bookingNoticeEmail(changed, { siteUrl: ORIGIN, bookingPageGrant: "G".repeat(43) });
    expect(mail.subject).toBe("Your booking date changed: Synthetic walk, Mon 16 Nov 2026 10:00");
    expect(mail.text).toContain("Your booking moved from Saturday 14 November 2026, 10:00 Japan time to Monday 16 November 2026, 10:00 Japan time.");
    expect(mail.text).toContain("The price stays ¥7,500: nothing more is charged and nothing is refunded.");
    expect(mail.text).toContain("You can cancel for free until Sat 14 Nov, 10:00 Japan time.");
    expect(mail.text).toContain(`${ORIGIN}/bookings/open#g=${"G".repeat(43)}`);
    expect(bookingNoticeEmail({ ...changed, totalAmount: 0 }, { siteUrl: ORIGIN }).text).toContain("It is still free.");
  });

  it("speaks Japanese to a Japanese booking", () => {
    const mail = bookingNoticeEmail({ ...changed, guestLanguage: "JA", guestName: "合成 花子" }, { siteUrl: ORIGIN, bookingPageGrant: "G".repeat(43) });
    expect(mail.subject).toContain("ご予約の日付を変更しました");
    expect(mail.text).toContain("ご予約を2026年11月14日(土) 10:00（日本時間）から2026年11月16日(月) 10:00（日本時間）に変更しました。");
    expect(mail.text).toContain("料金は 7,500円 のまま変わりません。");
    expect(mail.text).toContain("11月14日(土) 10:00（日本時間）まで無料でキャンセルできます。");
    expect(mail.text).not.toMatch(/\b(Hi|Your booking)\b/);
  });
});
