import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFixtureExperiences } from "@niho-experience/api-client/mock";
import { SAMPLE_TERMS } from "./testing/guest-booking-fixtures";

/** Which experiences this site sells (#285), against a stubbed store. */
const state = vi.hoisted(() => ({
  config: { guestBookingEnabled: true, siteUrl: "https://experience.example/", nihoWebOrigin: "https://niho.example", guestBookingConsentVersion: "sample-terms-2026-10" },
  repository: null as null | Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/store-server", () => ({ guestBookingRepository: () => state.repository }));

import { GET as bookingTerms } from "@/app/api/public/experiences/[slug]/booking-terms/route";
import { bookingSourceOf, detailForSale, guestBookingSale, guestBookingSources, japaneseBookingOpen, siteNextDates } from "./guest-booking-source";
import { parseSiteSaleTerms, siteSaleTerms } from "./guest-booking-terms";

const AVAILABILITY = {
  generatedAt: "2026-10-31T01:00:00.000Z",
  timeZone: "Asia/Tokyo",
  windowDays: 90,
  occurrences: [
    { offerId: "sample-am", date: "2026-11-02", startAt: "2026-11-02T01:00:00.000Z", endAt: "2026-11-02T02:30:00.000Z", bookable: true, seatsLeft: 4, reason: null },
    { offerId: "sample-am", date: "2026-11-03", startAt: "2026-11-03T01:00:00.000Z", endAt: "2026-11-03T02:30:00.000Z", bookable: false, seatsLeft: 0, reason: "FULL" },
  ],
};
const READY = { termsFingerprint: `sha256:${"a".repeat(64)}`, bookingReady: true, unavailableCopyKey: null };
const failing = () => vi.fn(async () => { throw new Error("connection refused: postgresql://user@db/experience"); });

beforeEach(() => {
  state.config = { guestBookingEnabled: true, siteUrl: "https://experience.example/", nihoWebOrigin: "https://niho.example", guestBookingConsentVersion: "sample-terms-2026-10" };
  state.repository = {
    publicBookingTerms: vi.fn(async (slug: string) => (slug === "sample-tea" ? SAMPLE_TERMS : null)),
    sellableSlugs: vi.fn(async (slugs: readonly string[]) => slugs.filter((slug) => slug === "sample-tea")),
    listPublicAvailability: vi.fn(async (slug: string) => (slug === "sample-tea" ? AVAILABILITY : null)),
  };
});

afterEach(() => vi.restoreAllMocks());

describe("where one experience is sold", () => {
  it("is NIHO with the flag off, without asking the store", async () => {
    state.config = { ...state.config, guestBookingEnabled: false };
    expect(await guestBookingSale("sample-tea")).toEqual({ kind: "niho" });
    expect(state.repository!.publicBookingTerms).not.toHaveBeenCalled();
    expect(bookingSourceOf({ kind: "niho" })).toEqual({ kind: "niho", origin: "https://niho.example" });
  });

  it("is this site for a product the experience DB sells, and NIHO for any other", async () => {
    const sale = await guestBookingSale("sample-tea");
    expect(sale).toEqual({ kind: "site", terms: SAMPLE_TERMS });
    expect(bookingSourceOf(sale)).toEqual({ kind: "site", origin: "https://experience.example" });
    expect(await guestBookingSale("sample-walk")).toEqual({ kind: "niho" });
  });

  it("is unknown when the DB fails or is missing: closed, never NIHO, and nothing of the error is logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.repository!.publicBookingTerms = failing();
    const sale = await guestBookingSale("sample-tea");
    expect(sale).toEqual({ kind: "unknown" });
    expect(bookingSourceOf(sale)).toEqual({ kind: "closed" });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/postgresql|refused/);
    state.repository = null;
    expect(await guestBookingSale("sample-walk")).toEqual({ kind: "unknown" });
  });

  it("lays the sale over NIHO's detail for a product sold here, closes an unknown one and leaves NIHO's alone", () => {
    const detail = buildFixtureExperiences()[0]!;
    const sold = detailForSale(detail, { kind: "site", terms: SAMPLE_TERMS });
    expect(sold.offers).toEqual(siteSaleTerms(SAMPLE_TERMS, "sample-terms-2026-10").offers);
    expect(sold.booking).toEqual({ ...detail.booking, checkoutAvailable: true, consentVersion: "sample-terms-2026-10" });
    expect(sold.title).toBe(detail.title);
    const unknown = detailForSale(detail, { kind: "unknown" });
    expect(unknown.booking.checkoutAvailable).toBe(false);
    expect(unknown.offers).toBe(detail.offers);
    expect(detailForSale(detail, { kind: "niho" })).toBe(detail);
  });

  it("reads the next dates of a product sold here from the store, and none on a failure", async () => {
    expect((await siteNextDates("sample-tea")).map((occurrence) => occurrence.date)).toEqual(["2026-11-02"]);
    expect(await siteNextDates("sample-walk")).toEqual([]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.repository!.listPublicAvailability = failing();
    expect(await siteNextDates("sample-tea")).toEqual([]);
  });

  it("keeps Japanese booking (NIHO's v1.2/ja checkout) closed for a product sold here or unknown", () => {
    expect(japaneseBookingOpen({ kind: "niho" }, { localization: READY })).toBe(true);
    expect(japaneseBookingOpen({ kind: "niho" }, { localization: { ...READY, bookingReady: false, unavailableCopyKey: "booking.unavailableJa" } })).toBe(false);
    expect(japaneseBookingOpen({ kind: "site", terms: SAMPLE_TERMS }, { localization: READY })).toBe(false);
    expect(japaneseBookingOpen({ kind: "unknown" }, { localization: READY })).toBe(false);
  });
});

describe("where a page of cards reads availability", () => {
  it("names the slugs sold here in one store call, and every slug is NIHO's with the flag off", async () => {
    expect(await guestBookingSources(["sample-walk", "sample-tea"])).toEqual({
      nihoWebOrigin: "https://niho.example", siteOrigin: "https://experience.example", siteSlugs: ["sample-tea"], closedSlugs: [],
    });
    expect(state.repository!.sellableSlugs).toHaveBeenCalledOnce();
    expect(await guestBookingSources(["sample-walk"])).toEqual({ nihoWebOrigin: "https://niho.example", siteOrigin: null, siteSlugs: [], closedSlugs: [] });
    state.config = { ...state.config, guestBookingEnabled: false };
    expect(await guestBookingSources(["sample-tea"])).toEqual({ nihoWebOrigin: "https://niho.example", siteOrigin: null, siteSlugs: [], closedSlugs: [] });
    expect(state.repository!.sellableSlugs).toHaveBeenCalledTimes(2);
  });

  it("closes every card on the page when the DB cannot answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.repository!.sellableSlugs = failing();
    expect(await guestBookingSources(["sample-walk", "sample-tea", "sample-walk"])).toEqual({
      nihoWebOrigin: "https://niho.example", siteOrigin: null, siteSlugs: [], closedSlugs: ["sample-walk", "sample-tea"],
    });
  });
});

describe("GET /api/public/experiences/{slug}/booking-terms", () => {
  const read = (slug: string) => bookingTerms(new Request(`https://experience.example/api/public/experiences/${slug}/booking-terms`), { params: Promise.resolve({ slug }) });

  it("returns the sale terms the booking form reads, no-store, and nothing server-only", async () => {
    const response = await read("sample-tea");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const body: unknown = await response.json();
    expect(body).toEqual(siteSaleTerms(SAMPLE_TERMS, "sample-terms-2026-10"));
    expect(parseSiteSaleTerms(body)).not.toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/provider-sample|productId/);
  });

  it("is 404 without a body when the flag is off or the experience is not sold here, and 503 on a DB failure", async () => {
    const notSold = await read("sample-walk");
    expect(notSold.status).toBe(404);
    expect(await notSold.text()).toBe("");
    expect((await read("x".repeat(161))).status).toBe(404);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.repository!.publicBookingTerms = failing();
    expect((await read("sample-tea")).status).toBe(503);
    state.repository = null;
    expect((await read("sample-tea")).status).toBe(503);
    state.config = { ...state.config, guestBookingEnabled: false };
    const off = await read("sample-tea");
    expect(off.status).toBe(404);
    expect(await off.text()).toBe("");
  });
});
