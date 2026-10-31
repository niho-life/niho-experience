import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperienceCheckoutRequest } from "@niho-experience/api-client";
import { bookingSourceFor, bookingSourceKey, nihoBookingSources, type BookingSources } from "./booking-source";
import { siteSaleTerms } from "./guest-booking-terms";
import { SAMPLE_TERMS } from "./testing/guest-booking-fixtures";

/** The browser side of 旅行者の予約 (#285): each experience reads and books where the server says it is sold. */

const NIHO = "https://niho.example";
const SITE = "https://experience.example";
const SOURCES: BookingSources = { nihoWebOrigin: NIHO, siteOrigin: SITE, siteSlugs: ["sample-tea"], closedSlugs: ["sample-closed"] };
const AVAILABILITY = { generatedAt: "2026-10-31T01:00:00.000Z", timeZone: "Asia/Tokyo", windowDays: 90, occurrences: [] };
const BODY: ExperienceCheckoutRequest = {
  offerId: "sample-am", occurrenceDate: "2026-11-02", adultCount: 1, childCount: 0, expectedTotalYen: 4000,
  bookingQuestionsFingerprint: "b".repeat(64), clientRequestKey: "key-12345678", guestName: "Sample Guest", guestEmail: "guest@example.com",
  answers: [{ questionId: "diet", optionIds: ["veg"] }], consent: { agreedVersion: "sample-terms-2026-10" },
};

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("the source per slug", () => {
  it("is this site for a slug sold here, nothing for a closed one, and NIHO for every other", () => {
    expect(bookingSourceFor(SOURCES, "sample-tea")).toEqual({ kind: "site", origin: SITE });
    expect(bookingSourceFor(SOURCES, "sample-closed")).toEqual({ kind: "closed" });
    expect(bookingSourceFor(SOURCES, "sample-walk")).toEqual({ kind: "niho", origin: NIHO });
    // Prototype names are slugs like any other.
    expect(bookingSourceFor(SOURCES, "constructor")).toEqual({ kind: "niho", origin: NIHO });
    expect(bookingSourceFor(nihoBookingSources(NIHO), "sample-tea")).toEqual({ kind: "niho", origin: NIHO });
    expect(new Set([bookingSourceKey({ kind: "site", origin: SITE }), bookingSourceKey({ kind: "niho", origin: NIHO }), bookingSourceKey({ kind: "closed" })]).size).toBe(3);
  });
});

describe("availability by source", () => {
  it("reads a slug sold here from this site's route and every other slug from NIHO", async () => {
    const fetchMock = vi.fn(async () => Response.json(AVAILABILITY));
    vi.stubGlobal("fetch", fetchMock);
    const { readBookingAvailability } = await import("./browser-availability");
    expect(await readBookingAvailability("sample-tea", false, bookingSourceFor(SOURCES, "sample-tea"))).toEqual({ ok: true, occurrences: [] });
    expect(await readBookingAvailability("sample-walk", false, bookingSourceFor(SOURCES, "sample-walk"))).toEqual({ ok: true, occurrences: [] });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual([`${SITE}/api/public/experiences/sample-tea/availability`, `${NIHO}/api/public/experiences/sample-walk/availability`]);
    expect(calls[0]![1].referrerPolicy).toBe("same-origin");
    expect(calls[1]![1].referrerPolicy).toBe("no-referrer");
    expect(calls.every(([, init]) => init.credentials === "omit" && init.cache === "no-store")).toBe(true);
  });

  it("reads this site's one availability on the Japanese pages too, and nothing for a closed slug", async () => {
    const fetchMock = vi.fn(async () => Response.json(AVAILABILITY));
    vi.stubGlobal("fetch", fetchMock);
    const { readBookingAvailability } = await import("./browser-availability");
    expect(await readBookingAvailability("sample-tea", false, bookingSourceFor(SOURCES, "sample-tea"), "ja", "release-1")).toEqual({ ok: true, occurrences: [] });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(`${SITE}/api/public/experiences/sample-tea/availability`);
    expect(await readBookingAvailability("sample-closed", false, bookingSourceFor(SOURCES, "sample-closed"))).toEqual({ ok: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("checkout by source", () => {
  it("posts an experience sold here to this site with its Origin, and accepts this site's return page", async () => {
    const paid = `${SITE}/booking/return?type=instant`;
    const fetchMock = vi.fn(async () => Response.json({ checkoutUrl: paid }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const { getBookingApi } = await import("./browser-api");
    const api = await getBookingApi(false, { kind: "site", origin: SITE });
    expect(await api.startCheckout("sample-tea", BODY)).toEqual({ ok: true, checkoutUrl: paid });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SITE}/api/public/experiences/sample-tea/checkout`);
    expect(init.referrerPolicy).toBe("same-origin");
    expect(init.credentials).toBe("omit");
    expect(JSON.parse(init.body as string)).toEqual(BODY);
  });

  it("keeps NIHO's client for any other experience, where this site's return page is not a checkout answer", async () => {
    const fetchMock = vi.fn(async () => Response.json({ checkoutUrl: `${NIHO}/booking/return?type=instant` }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const { getBookingApi } = await import("./browser-api");
    const api = await getBookingApi(false, { kind: "niho", origin: NIHO });
    expect(await api.startCheckout("sample-walk", BODY)).toEqual({ ok: false, kind: "unexpected_response", status: 201 });
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].referrerPolicy).toBe("no-referrer");
    await expect(getBookingApi(false, { kind: "closed" })).rejects.toThrow();
  });
});

describe("the sale terms read again from this site", () => {
  it("reads the booking-terms route with no cache and no credentials, and refuses an answer of another shape", async () => {
    const sale = siteSaleTerms(SAMPLE_TERMS, "sample-terms-2026-10");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(sale))
      .mockResolvedValueOnce(Response.json({ ...sale, providerId: "provider-sample" }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockRejectedValueOnce(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const { getSiteBookingTerms } = await import("./browser-api");
    expect(await getSiteBookingTerms(SITE, "sample-tea")).toEqual(sale);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SITE}/api/public/experiences/sample-tea/booking-terms`);
    expect(init).toMatchObject({ method: "GET", cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "same-origin" });
    expect(await getSiteBookingTerms(SITE, "sample-tea")).toBeNull();
    expect(await getSiteBookingTerms(SITE, "sample-tea")).toBeNull();
    expect(await getSiteBookingTerms(SITE, "sample-tea")).toBeNull();
  });
});
