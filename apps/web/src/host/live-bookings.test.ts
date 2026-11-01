import { describe, expect, it } from "vitest";
import type {
  ExperienceProviderBookingDetailResponse,
  ExperienceProviderBookingListResponse,
} from "@niho-experience/api-client/experience-provider-operations";
import { projectHostBookingDetail, projectHostBookingList } from "./live-bookings";

const list = {
  bookings: [{
    id: "booking_1", spotId: "private_spot", pageId: "page_1", offerId: "offer_1", occurrenceDate: "2027-01-02",
    startAt: "2027-01-02T01:00:00.000Z", endAt: "2027-01-02T03:00:00.000Z", headCount: 2, adultCount: 2, childCount: 0,
    offerNameSnapshot: "Walk", totalYenSnapshot: 12000, guestName: "Guest", guestEmail: "guest@example.test", note: "private note",
    questionAnswersJson: null, paidAt: null, authorizedAt: null, cancelledAt: null, refundedYen: 0,
    createdAt: "2026-12-01T00:00:00.000Z", experienceSiteListingId: "listing_private", sellerDisplayNameSnapshot: "Seller",
    page: { title: "Kamakura walk" }, status: "PROVISIONAL", salesChannel: "EXPERIENCE_SITE",
  }],
  nextCursor: null,
} satisfies ExperienceProviderBookingListResponse;

const detail = {
  booking: {
    id: "booking_1", offerId: "offer_1", offerName: "Walk", occurrenceDate: "2027-01-02",
    startAt: "2027-01-02T01:00:00.000Z", endAt: "2027-01-02T03:00:00.000Z", headCount: 2, adultCount: 2, childCount: 0,
    guestName: "Guest", guestEmail: "guest@example.test", languageSnapshot: "EN", note: "No shellfish", answers: null,
    status: "CONFIRMED", unitPriceYen: 6000, adultPriceYen: 6000, childPriceYen: null, totalYen: 12000,
    paidAt: "2026-12-01T00:00:00.000Z", authorizedAt: "2026-11-30T00:00:00.000Z", approvalDeadlineAt: null,
    travelerCancelRequestedAt: null, cancelledAt: null, cancelReason: null, cancelMessage: null, refundedYen: 0,
    createdAt: "2026-11-30T00:00:00.000Z", salesChannel: "EXPERIENCE_SITE", pageId: "page_1", page: { title: "Kamakura walk" },
    hostMessages: [{ id: "host_1", subject: "Meeting point", body: "Meet at the gate", createdAt: "2026-12-01T01:00:00.000Z", sentAt: "2026-12-01T01:00:02.000Z", failed: false, deliveryStatus: "SENT" }],
    guestMessages: [{ id: "guest_1", body: "Thank you. We will be there.", createdAt: "2026-12-01T02:00:00.000Z" }],
  },
  sender: { displayName: "Provider", replyToEmails: ["provider@example.test"] },
} satisfies ExperienceProviderBookingDetailResponse;

describe("host booking BFF projection", () => {
  it("keeps the real list fields the UI needs and removes upstream email and provider internals", () => {
    const projected = projectHostBookingList(list);
    expect(projected.bookings[0]).toEqual({
      id: "booking_1", pageId: "page_1", offerId: "offer_1", occurrenceDate: "2027-01-02", startAt: "2027-01-02T01:00:00.000Z", endAt: "2027-01-02T03:00:00.000Z",
      headCount: 2, offerName: "Walk", totalYen: 12000, guestName: "Guest", pageTitle: "Kamakura walk", status: "PROVISIONAL", salesChannel: "EXPERIENCE_SITE",
    });
    const text = JSON.stringify(projected);
    expect(text).not.toContain("guest@example.test");
    expect(text).not.toContain("private_spot");
    expect(text).not.toContain("private note");
  });

  it("keeps both Web conversation directions and removes every email field server-side", () => {
    const projected = projectHostBookingDetail(detail);
    expect(projected.booking.hostMessages[0]?.body).toBe("Meet at the gate");
    expect(projected.booking.guestMessages[0]?.body).toBe("Thank you. We will be there.");
    const text = JSON.stringify(projected);
    expect(text).not.toContain("guest@example.test");
    expect(text).not.toContain("provider@example.test");
    expect(text).not.toContain("replyToEmails");
    expect(text).not.toContain("guestEmail");
  });
});
