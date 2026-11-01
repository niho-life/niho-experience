import type { HostOtaBooking } from "@niho-experience/experience-store";
import { describe, expect, it } from "vitest";
import { bookingGroups, bookingRowDetail } from "./bookings";
import { MOCK_OTA_BOOKINGS } from "./mock/ota-bookings";
import { OTA_BOOKING_ERASED_NAME, OTA_BOOKING_NO_NAME, otaBooking, otaBookingExperiences, otaHomeTodos, otaPartyLabel, otaStatusLabel, withOtaGuests } from "./ota-bookings";

/** OTA の予約 as 予約, ホーム and この回 show them (#194 PR B). Synthetic bookings only. */
const [gyg, airbnb, jalan, viator, erased] = MOCK_OTA_BOOKINGS as [HostOtaBooking, HostOtaBooking, HostOtaBooking, HostOtaBooking, HostOtaBooking];

describe("an OTA booking on the console", () => {
  it("is shown at its session's time in Japan, with its site, party and contact, and no amount", () => {
    const booking = otaBooking(gyg);
    expect(booking).toMatchObject({
      id: gyg.ref, experienceId: "community-dinner", offerId: "offer-dinner", date: "2026-10-22", start: "18:00", end: "20:00",
      guest: "Sample Traveler", language: "en", guests: 3, adults: 2, children: 1, amountYen: 0, status: "confirmed", channel: "GetYourGuide",
      phone: null, note: "One vegetarian, please.",
      ota: { ref: gyg.ref, siteLabel: "GetYourGuide", bookingReference: "GYG-SAMPLE-1042", email: "traveler@example.com", phone: "+44 20 0000 0000", party: "大人 2・子ども 1", pending: false, needsReview: false, erased: false, hasDetails: true },
    });
    // The row says where it came from, never an amount.
    expect(bookingRowDetail(booking)).toBe("3名 · GetYourGuide");
    expect(booking.timeline).toEqual([{ at: "2026-10-20T18:15", text: "GetYourGuide から取り込み" }]);
  });

  it("names the site as hosts know it, and says what is pending, waiting for staff, cancelled or erased", () => {
    expect(otaBooking(jalan)).toMatchObject({ channel: "じゃらん", language: "ja", status: "confirmed", ota: { pending: true, siteLabel: "じゃらん" } });
    expect(otaStatusLabel(otaBooking(jalan), "2026-10-21")).toEqual({ label: "確定待ち", tone: "wait" });
    // No session for its time: its own heading, no この回.
    expect(otaBooking(viator)).toMatchObject({ offerId: "", date: "2026-10-29", start: "16:30", ota: { needsReview: true } });
    expect(otaStatusLabel(otaBooking(viator), "2026-10-21")).toEqual({ label: "確認中", tone: "wait" });
    expect(otaStatusLabel(otaBooking(airbnb), "2026-10-21")).toMatchObject({ label: "取消済み" });
    expect(otaBooking(erased)).toMatchObject({ guest: OTA_BOOKING_ERASED_NAME, ota: { erased: true, hasDetails: false, email: null } });
    expect(otaBooking({ ...gyg, guest: null })).toMatchObject({ guest: OTA_BOOKING_NO_NAME, adults: 2, children: 1 });
    expect(otaBooking({ ...gyg, partyBreakdown: null })).toMatchObject({ adults: 3, children: 0, ota: { party: null } });
    expect(otaPartyLabel([{ band: "SENIOR", count: 1 }, { band: "INFANT", count: 1 }])).toBe("シニア 1・幼児 1");
  });

  it("joins the list's sessions and its experience select like the other bookings", () => {
    const rows = MOCK_OTA_BOOKINGS.map(otaBooking);
    const experiences = otaBookingExperiences(MOCK_OTA_BOOKINGS);
    expect(experiences).toEqual([{ id: "community-dinner", title: "Kamakura Community Dinner with Locals", offers: [{ id: "offer-dinner", capacity: null, durationMinutes: 120 }] }]);
    const upcoming = bookingGroups(rows, experiences, { filter: "upcoming", experienceId: null }, "2026-10-21");
    expect(upcoming.map((group) => [group.label, group.seats, group.bookings.map((booking) => booking.guest)])).toEqual([
      ["10月22日（木）18:00", "3名", ["Sample Traveler"]],
      ["10月27日（火）18:00", "2名", ["見本 花子"]],
      ["10月29日（木）16:30", "1名", ["Sample Solo"]],
    ]);
    expect(bookingGroups(rows, experiences, { filter: "cancelled", experienceId: null }, "2026-10-21").flatMap((group) => group.bookings.map((booking) => booking.guest))).toEqual(["Sample Couple"]);
  });

  it("puts this site's new OTA bookings, ahead and not cancelled, in 次にすること, newest first", () => {
    const now = Date.parse("2026-10-21T12:00:00+09:00");
    const todos = otaHomeTodos(MOCK_OTA_BOOKINGS, now);
    expect(todos.map((todo) => [todo.title, todo.detail, todo.action?.href])).toEqual([
      ["じゃらん で新しい予約", "10/27（火）18:00 · Kamakura Community Dinner with Locals · 見本 花子 様 · 2名", `/host/bookings?ota=${jalan.ref}`],
      ["GetYourGuide で新しい予約", "10/22（木）18:00 · Kamakura Community Dinner with Locals · Sample Traveler 様 · 3名", `/host/bookings?ota=${gyg.ref}`],
      ["Viator で新しい予約", "10/29（木）16:30 · Kamakura Community Dinner with Locals · Sample Solo 様 · 1名", `/host/bookings?ota=${viator.ref}`],
    ]);
    // Three days on, none is new any more.
    expect(otaHomeTodos(MOCK_OTA_BOOKINGS, Date.parse("2026-10-25T12:00:00+09:00"))).toEqual([]);
  });

  it("adds a session's OTA guests to この回, or makes the session of them alone", () => {
    const query = { date: "2026-10-22", start: "18:00", experience: "community-dinner", offer: "offer-dinner" };
    const guest = { ...otaBooking(gyg), phone: "+44 20 0000 0000" };
    expect(withOtaGuests(null, [], query)).toBeNull();
    expect(withOtaGuests(null, [guest], query)).toMatchObject({ date: "2026-10-22", start: "18:00", end: "20:00", title: "Kamakura Community Dinner with Locals", capacity: null, bookings: [guest] });
    const view = { date: "2026-10-22", start: "18:00", end: "20:00", experienceId: "community-dinner", offerId: "offer-dinner", title: "Dinner", offer: "Dinner", capacity: 8, meetingArea: "Kamakura", bookings: [] };
    expect(withOtaGuests(view, [guest], query)?.bookings).toEqual([guest]);
    // A guest already on the session stays once.
    expect(withOtaGuests({ ...view, bookings: [guest] }, [guest], query)?.bookings).toEqual([guest]);
  });
});
