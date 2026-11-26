import { describe, expect, it } from "vitest";
import { siteBookingSelectionFromSearch } from "./site-booking-selection";

describe("siteBookingSelectionFromSearch", () => {
  it("accepts only valid public selection fields and ignores contact fields", () => {
    expect(siteBookingSelectionFromSearch({
      date: "2026-12-10", offer: "morning_1", adults: "2", children: "1", name: "Private Name", email: "private@example.test",
    })).toEqual({ date: "2026-12-10", offerId: "morning_1", adults: 2, children: 1 });
  });

  it.each([
    { date: "2026-02-30", offer: "offer", adults: "1", children: "0" },
    { date: "2026-12-10", offer: "bad/offer", adults: "1", children: "0" },
    { date: "2026-12-10", offer: "offer", adults: "-1", children: "0" },
    { date: "2026-12-10", offer: "offer", adults: "1", children: ["0", "1"] },
  ])("rejects malformed selector values %#", (search) => {
    expect(siteBookingSelectionFromSearch(search)).toBeNull();
  });
});
