import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), get: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@niho-experience/api-client/experience-provider-operations-schema", () => ({
  isExperienceProviderOperationPathId: (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value),
}));
vi.mock("@/lib/host/provider-operations-server", () => ({
  loadProviderOperationsClient: mocks.load,
  providerOperationsJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  providerOperationsFailure: mocks.failure,
}));

import { GET } from "./route";

const context = { params: Promise.resolve({ providerId: "provider_1", bookingId: "booking_1" }) };
const upstream = {
  booking: {
    id: "booking_1", offerId: "offer_1", offerName: "Walk", occurrenceDate: "2027-01-02", startAt: "2027-01-02T01:00:00.000Z",
    endAt: "2027-01-02T03:00:00.000Z", headCount: 2, adultCount: 2, childCount: 0, guestName: "Guest", guestEmail: "guest@example.test",
    languageSnapshot: "EN", note: null, answers: null, status: "CONFIRMED", unitPriceYen: 6000, adultPriceYen: 6000, childPriceYen: null,
    totalYen: 12000, paidAt: null, authorizedAt: null, approvalDeadlineAt: null, travelerCancelRequestedAt: null, cancelledAt: null,
    cancelReason: null, cancelMessage: null, refundedYen: 0, createdAt: "2026-12-01T00:00:00.000Z", salesChannel: "EXPERIENCE_SITE",
    hostMessages: [{ id: "host_1", subject: "Meeting point", body: "Meet at the gate", createdAt: "2026-12-01T01:00:00.000Z", sentAt: null, failed: false, deliveryStatus: "QUEUED" }],
    guestMessages: [{ id: "guest_1", body: "Thank you", createdAt: "2026-12-01T02:00:00.000Z" }],
    pageId: "page_1", page: { title: "Kamakura walk" },
  },
  sender: { displayName: "Provider", replyToEmails: ["provider@example.test"] },
};

describe("provider booking detail BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue({ ok: true, data: upstream });
    mocks.load.mockResolvedValue({ ok: true, client: { getBooking: mocks.get } });
    mocks.failure.mockImplementation((failure: { kind: string }) => Response.json({ error: "permission_ended" }, { status: failure.kind === "not_found" ? 404 : 502, headers: { "cache-control": "private, no-store" } }));
  });

  it("returns the two-way conversation but no guest or sender email", async () => {
    const response = await GET(new Request("https://experience.example/host/api/provider-operations/provider_1/bookings/booking_1"), context);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("Meet at the gate");
    expect(text).toContain("Thank you");
    expect(text).not.toContain("guest@example.test");
    expect(text).not.toContain("provider@example.test");
    expect(text).not.toContain("replyToEmails");
  });

  it("keeps another provider's booking indistinguishable from not found", async () => {
    mocks.get.mockResolvedValue({ ok: false, kind: "not_found" });
    const response = await GET(new Request("https://experience.example/host/api/provider-operations/provider_1/bookings/booking_1"), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "permission_ended" });
  });
});
