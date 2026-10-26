import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), list: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@niho-experience/api-client/experience-provider-operations-schema", () => ({
  isExperienceProviderOperationPathId: (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value),
  isExperienceProviderBookingCursor: (value: unknown) => typeof value === "string" && value.length > 0,
}));
vi.mock("@/lib/host/provider-operations-server", () => ({
  loadProviderOperationsClient: mocks.load,
  providerOperationsJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  providerOperationsFailure: mocks.failure,
}));

import { GET } from "./route";

const context = { params: Promise.resolve({ providerId: "provider_1" }) };
const upstream = {
  bookings: [{
    id: "booking_1", spotId: "spot_private", pageId: "page_1", offerId: "offer_1", occurrenceDate: "2027-01-02",
    startAt: "2027-01-02T01:00:00.000Z", endAt: "2027-01-02T03:00:00.000Z", headCount: 2, adultCount: 2, childCount: 0,
    offerNameSnapshot: "Walk", totalYenSnapshot: 12000, guestName: "Guest", guestEmail: "guest@example.test", note: "private",
    questionAnswersJson: null, paidAt: null, authorizedAt: null, cancelledAt: null, refundedYen: 0, createdAt: "2026-12-01T00:00:00.000Z",
    experienceSiteListingId: null, sellerDisplayNameSnapshot: null, page: { title: "Kamakura walk" }, status: "CONFIRMED", salesChannel: "EXPERIENCE_SITE",
  }],
  nextCursor: null,
};

describe("provider booking list BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({ ok: true, data: upstream });
    mocks.load.mockResolvedValue({ ok: true, client: { listBookings: mocks.list } });
    mocks.failure.mockImplementation(() => Response.json({ error: "upstream" }, { status: 502 }));
  });

  it("returns only the browser projection and never serializes the guest email", async () => {
    const response = await GET(new Request("https://experience.example/host/api/provider-operations/provider_1/bookings"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const text = await response.text();
    expect(text).not.toContain("guest@example.test");
    expect(text).not.toContain("spot_private");
    expect(JSON.parse(text)).toEqual({
      bookings: [{
        id: "booking_1", occurrenceDate: "2027-01-02", startAt: "2027-01-02T01:00:00.000Z",
        headCount: 2, offerName: "Walk", totalYen: 12000, guestName: "Guest",
        pageTitle: "Kamakura walk", status: "CONFIRMED", salesChannel: "EXPERIENCE_SITE",
      }],
      nextCursor: null,
    });
  });

  it("passes an unauthenticated response through without calling NIHO", async () => {
    mocks.load.mockResolvedValue({ ok: false, response: Response.json({ error: "unauthenticated" }, { status: 401, headers: { "cache-control": "private, no-store" } }) });
    const response = await GET(new Request("https://experience.example/host/api/provider-operations/provider_1/bookings"), context);
    expect(response.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
