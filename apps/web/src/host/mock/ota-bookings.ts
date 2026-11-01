import type { HostOtaBooking } from "@niho-experience/experience-store";

/*
 * OTA の予約 (#194 PR B) as the experience DB's external ledger gives them, invented for the preview's `?mock=ota-bookings`
 * sign-in: the sample kitchen's Community Dinner around the preview's day (10/21), from GetYourGuide, Airbnb, Viator and
 * Jalan. One is new (read the day before), one cancelled on its site, one not confirmed by its site yet, one waiting for
 * staff (its time matched no session) and one whose guest details were erased. Nothing here is a real booking or guest;
 * the store's integration tests check the real reads.
 */

const DINNER = { productId: "community-dinner", productTitle: "Kamakura Community Dinner with Locals", timeZone: "Asia/Tokyo" } as const;

function slot(date: string, start: string, offerId: string | null): Pick<HostOtaBooking, "offerId" | "occurrenceId" | "occurrenceStartUtc" | "occurrenceEndUtc" | "sourceStartUtc" | "sourceEndUtc"> {
  const startUtc = new Date(`${date}T${start}:00+09:00`).toISOString();
  const endUtc = new Date(Date.parse(startUtc) + 2 * 60 * 60 * 1000).toISOString();
  return {
    offerId,
    occurrenceId: offerId ? `${offerId}@${date}` : null,
    occurrenceStartUtc: offerId ? startUtc : null,
    occurrenceEndUtc: offerId ? endUtc : null,
    sourceStartUtc: startUtc,
    sourceEndUtc: endUtc,
  };
}

export const MOCK_OTA_BOOKINGS: readonly HostOtaBooking[] = [
  {
    ref: "0b7f3c1e-5a2d-4e8f-9c61-2d4b8a7e1f01", site: "GetYourGuide", ...DINNER, ...slot("2026-10-22", "18:00", "offer-dinner"),
    status: "CONFIRMED", seats: 3, partyBreakdown: [{ band: "ADULT", count: 2 }, { band: "CHILD", count: 1 }], bookingReference: "GYG-SAMPLE-1042",
    guest: { name: "Sample Traveler", email: "traveler@example.com", phone: "+44 20 0000 0000", language: "en-GB", notes: "One vegetarian, please." },
    erased: false, needsReview: false, firstSeenAtUtc: "2026-10-20T09:15:00.000Z",
  },
  {
    ref: "0b7f3c1e-5a2d-4e8f-9c61-2d4b8a7e1f02", site: "Airbnb", ...DINNER, ...slot("2026-10-24", "18:00", "offer-dinner"),
    status: "CANCELLED", seats: 2, partyBreakdown: null, bookingReference: "HMSAMPLE22",
    guest: { name: "Sample Couple", email: null, phone: null, language: "en", notes: null },
    erased: false, needsReview: false, firstSeenAtUtc: "2026-10-12T02:00:00.000Z",
  },
  {
    ref: "0b7f3c1e-5a2d-4e8f-9c61-2d4b8a7e1f03", site: "Jalan", ...DINNER, ...slot("2026-10-27", "18:00", "offer-dinner"),
    status: "PENDING", seats: 2, partyBreakdown: [{ band: "ADULT", count: 2 }], bookingReference: "JLN-SAMPLE-0007",
    guest: { name: "見本 花子", email: "hanako@example.jp", phone: "090-0000-0000", language: "ja", notes: null },
    erased: false, needsReview: false, firstSeenAtUtc: "2026-10-21T01:30:00.000Z",
  },
  {
    ref: "0b7f3c1e-5a2d-4e8f-9c61-2d4b8a7e1f04", site: "Viator", ...DINNER, ...slot("2026-10-29", "16:30", null),
    status: "CONFIRMED", seats: 1, partyBreakdown: null, bookingReference: "BR-SAMPLE-55",
    guest: { name: "Sample Solo", email: "solo@example.com", phone: null, language: "fr", notes: null },
    erased: false, needsReview: true, firstSeenAtUtc: "2026-10-19T05:00:00.000Z",
  },
  {
    ref: "0b7f3c1e-5a2d-4e8f-9c61-2d4b8a7e1f05", site: "GetYourGuide", ...DINNER, ...slot("2025-09-12", "18:00", "offer-dinner"),
    status: "CONFIRMED", seats: 2, partyBreakdown: null, bookingReference: null, guest: null,
    erased: true, needsReview: false, firstSeenAtUtc: "2025-09-01T00:00:00.000Z",
  },
];
