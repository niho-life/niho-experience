import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { apiMode: "http" as "http" | "mock", experiencePublicationsEnabled: true, guestBookingEnabled: true as boolean },
  bookings: { publicBookingTerms: vi.fn() },
  publications: { claimsSlug: vi.fn() },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/experience/store-server", () => ({ guestBookingRepository: () => mocks.bookings, experiencePublicationRepository: () => mocks.publications }));
vi.mock("@/lib/experience/public-http", () => ({
  publicEmpty: (status: number) => new Response(null, { status }),
  publicJson: (status: number, value: unknown) => Response.json(value, { status }),
}));

import { GET } from "./route";

describe("public Experience sale terms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.config, { apiMode: "http", experiencePublicationsEnabled: true });
    mocks.config.guestBookingEnabled = true;
    mocks.publications.claimsSlug.mockResolvedValue(false);
    mocks.bookings.publicBookingTerms.mockResolvedValue({
      providerId: "private-provider",
      productId: "private-product",
      title: "Synthetic workshop",
      currency: "JPY",
      sellerDisplayName: "Synthetic seller",
      offers: [{
        id: "workshop-rule",
        name: "Workshop",
        shortDescription: null,
        pricing: { currency: "JPY", taxIncluded: true, adultPriceYen: 4_000, child: null },
        capacity: 6,
        maxPartySize: 6,
        minimumParticipants: 1,
        minimumChargeableParticipants: 2,
        durationMinutes: 90,
        startTime: "10:00",
        weekdays: [6],
        cancellationPolicy: { code: "CUSTOM", freeCancellationHoursBefore: null },
        cancellationTerms: { cancellationWindowMinutesBeforeStart: 90, refundBasisPoints: 3_750 },
        acceptanceMode: "INSTANT",
        bookingQuestions: [],
        bookingQuestionsFingerprint: "a".repeat(64),
      }],
      conditionsVersion: null,
    });
  });

  it("returns lossless custom terms and excludes internal Experience keys", async () => {
    const response = await GET(new Request("https://experience.example/api/public/experiences/workshop/sale-terms"), { params: Promise.resolve({ slug: "workshop" }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { saleTerms: Record<string, unknown> };
    expect(body.saleTerms).not.toHaveProperty("providerId");
    expect(body.saleTerms).not.toHaveProperty("productId");
    expect(body.saleTerms).toMatchObject({ offers: [{ cancellationPolicy: { code: "CUSTOM" }, cancellationTerms: { refundBasisPoints: 3_750 }, minimumChargeableParticipants: 2 }] });
  });

  it("hides unavailable terms and respects the booking switch", async () => {
    mocks.bookings.publicBookingTerms.mockResolvedValue(null);
    expect((await GET(new Request("https://experience.example/api/public/experiences/missing/sale-terms"), { params: Promise.resolve({ slug: "missing" }) })).status).toBe(404);
    mocks.config.guestBookingEnabled = false;
    expect((await GET(new Request("https://experience.example/api/public/experiences/workshop/sale-terms"), { params: Promise.resolve({ slug: "workshop" }) })).status).toBe(404);
  });

  it("keeps a new seller's slug private while the public publication switch is off", async () => {
    mocks.config.experiencePublicationsEnabled = false;
    mocks.publications.claimsSlug.mockResolvedValue(true);
    const response = await GET(new Request("https://experience.example/api/public/experiences/workshop/sale-terms"), { params: Promise.resolve({ slug: "workshop" }) });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(mocks.bookings.publicBookingTerms).not.toHaveBeenCalled();
  });
});
