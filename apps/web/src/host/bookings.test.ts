import { describe, expect, it } from "vitest";
import {
  actionTime,
  approveBooking,
  bookingActions,
  bookingFilterOf,
  bookingGroups,
  bookingRequestRows,
  bookingRowDetail,
  bookingsHref,
  bookingStateRows,
  bookingStatusLabel,
  bookingWhen,
  cancelBooking,
  cancelConfirmLabel,
  declineBooking,
  defaultCancelMessage,
  defaultCancelReason,
  matchesBookingFilter,
  meetingGuideLabel,
  REFUND_CHOICES,
  refundChoicesFor,
  refundNowYen,
  refundTargetYen,
  respondByLabel,
  sessionHref,
  sessionOfBooking,
  shortDateTime,
  type BookingFilter,
  type BookingGroup,
} from "./bookings";
import { MOCK_KITCHEN_BOOKINGS, MOCK_TODAY } from "./mock/bookings";
import { MOCK_KITCHEN_EXPERIENCES } from "./mock/experiences";
import { BOOKING_STATUS } from "./status";
import type { HostBooking, HostBookingStatus } from "./types";

const byId = (id: string): HostBooking => MOCK_KITCHEN_BOOKINGS.find((booking) => booking.id === id)!;
const AT = "2026-10-21T15:30";
const list = (filter: BookingFilter, experienceId: string | null = null) => bookingGroups(MOCK_KITCHEN_BOOKINGS, MOCK_KITCHEN_EXPERIENCES, { filter, experienceId }, MOCK_TODAY);
const shape = (groups: BookingGroup[]) => groups.map((group) => [group.label, group.seats, group.bookings.map((booking) => booking.guest)]);

describe("the bookings list", () => {
  it("shows what is ahead under これから, one heading per session with the seats its requests and bookings keep", () => {
    const upcoming = list("upcoming");
    expect(shape(upcoming)).toEqual([
      // Today's tea time is over by the preview's 15:30, but still today's: attendance is recorded on the day (#107).
      ["10月21日（水）13:00", "4 / 8名", ["Aiko Tanaka", "Tom Becker"]],
      ["10月22日（木）18:00", "4 / 8名", ["Lucas & Mia Chen", "Emma Larsson"]],
      ["10月24日（土）18:00", "1 / 8名", ["Noah Williams"]],
      // The traveler asked to cancel: still to be handled, but it keeps no seat.
      ["10月25日（日）13:00", "0 / 8名", ["Mateo García"]],
      ["10月27日（火）18:00", "3 / 8名", ["Sofia Rossi"]],
      ["10月29日（木）18:00", "3 / 8名", ["Ana Souza"]],
    ]);
    expect(upcoming.map((group) => group.title)).toEqual(Array(6).fill("Kamakura Community Dinner with Locals"));
    // Each heading names its session for この回 (#107).
    expect(upcoming[0]).toMatchObject({ date: "2026-10-21", start: "13:00", experience: "community-dinner", offer: "offer-tea" });
  });

  it("counts the whole session in a narrowed list", () => {
    expect(shape(list("pending"))).toEqual([
      ["10月22日（木）18:00", "4 / 8名", ["Lucas & Mia Chen"]],
      ["10月29日（木）18:00", "3 / 8名", ["Ana Souza"]],
    ]);
  });

  it("starts 過去 and 取消済み from the latest day, and puts every booking in one of これから, 過去 and 取消済み", () => {
    expect(shape(list("past"))).toEqual([
      ["10月17日（土）18:00", "2 / 8名", ["Oliver Brown", "Chloé Dubois"]],
      ["10月13日（火）18:00", "2 / 8名", ["佐藤 由紀"]],
      // A booking the guest did not come to stays a booking (確定): its seat counts.
      ["10月10日（土）18:00", "1 / 8名", ["森 健二", "Liam Walker"]],
      // Older dinners whose guests wrote a review (#108).
      ["9月26日（土）18:00", "3 / 8名", ["Lena Novak"]],
      ["9月12日（土）18:00", "2 / 8名", ["Grace Lee"]],
      ["9月5日（土）18:00", "1 / 8名", ["Ella Martin"]],
      ["9月1日（火）18:00", "2 / 8名", ["Jonas Weber"]],
    ]);
    expect(shape(list("cancelled"))).toEqual([["10月15日（木）18:00", "0 / 8名", ["Hannah Kim"]]]);
    for (const booking of MOCK_KITCHEN_BOOKINGS) {
      const views = (["upcoming", "past", "cancelled"] as const).filter((filter) => matchesBookingFilter(booking, filter, MOCK_TODAY));
      expect(views, booking.id).toHaveLength(1);
    }
  });

  it("moves a request that ended without a booking to 過去, whatever its day", () => {
    const declined = { ...byId("bk-2044"), status: "declined" as const };
    expect(matchesBookingFilter(declined, "upcoming", MOCK_TODAY)).toBe(false);
    expect(matchesBookingFilter(declined, "pending", MOCK_TODAY)).toBe(false);
    expect(matchesBookingFilter(declined, "past", MOCK_TODAY)).toBe(true);
  });

  it("narrows to one experience, and reads ?filter= safely", () => {
    expect(list("upcoming", "kintsugi")).toEqual([]);
    expect(list("upcoming", "community-dinner")).toHaveLength(6);
    expect([null, "", "pending", "past", "cancelled", "everything"].map(bookingFilterOf)).toEqual(["upcoming", "upcoming", "pending", "past", "cancelled", "upcoming"]);
  });

  it("writes the screen's address with ?providerId= first and leaves the default filter out", () => {
    expect(bookingsHref()).toBe("/host/bookings");
    expect(bookingsHref({ filter: "upcoming", experience: null })).toBe("/host/bookings");
    expect(bookingsHref({ booking: "bk-2041" })).toBe("/host/bookings?booking=bk-2041");
    expect(bookingsHref({ providerId: "sample-provider-kitchen", filter: "pending", experience: "community-dinner", booking: "bk-2041" })).toBe(
      "/host/bookings?providerId=sample-provider-kitchen&filter=pending&experience=community-dinner&booking=bk-2041",
    );
  });

  it("never has the guest's email address: NIHO keeps it, and the host writes through the thread", () => {
    for (const booking of MOCK_KITCHEN_BOOKINGS) {
      expect(Object.keys(booking).filter((key) => /mail|address/i.test(key)), booking.id).toEqual([]);
      expect(JSON.stringify(booking), booking.id).not.toMatch(/@/);
      // The phone a guest chose to give is the only way to reach them besides the thread (この回 shows it, #107).
      if (booking.phone) expect(booking.phone, booking.id).toMatch(/^\+44 7700 900\d{3}$/);
    }
  });

  it("writes この回's address under 予約, with ?providerId= first", () => {
    expect(sessionOfBooking(byId("bk-2038"))).toEqual({ date: "2026-10-22", start: "18:00", experience: "community-dinner", offer: "offer-dinner" });
    expect(sessionHref(sessionOfBooking(byId("bk-2038")))).toBe("/host/bookings/session?date=2026-10-22&start=18%3A00&experience=community-dinner&offer=offer-dinner");
    expect(sessionHref({ providerId: "sample-provider-kitchen", ...sessionOfBooking(byId("bk-2006")) })).toBe(
      "/host/bookings/session?providerId=sample-provider-kitchen&date=2026-10-21&start=13%3A00&experience=community-dinner&offer=offer-tea",
    );
  });
});

describe("what the host can do in each state", () => {
  const allowed = (status: HostBookingStatus) =>
    Object.entries(bookingActions(status))
      .filter(([, can]) => can)
      .map(([action]) => action);

  it("approves and declines requests, cancels bookings, and writes to everyone who booked", () => {
    expect(allowed("pending")).toEqual(["approve", "decline", "message"]);
    expect(allowed("confirmed")).toEqual(["cancel", "message"]);
    expect(allowed("refund_needed")).toEqual(["cancel", "message"]);
    expect(allowed("cancelled")).toEqual(["message"]);
    expect(allowed("declined")).toEqual([]);
    expect(allowed("expired")).toEqual([]);
  });
});

describe("refunds", () => {
  it("gives back the whole payment, half of it or nothing", () => {
    const booking = byId("bk-2038");
    expect(REFUND_CHOICES.map((choice) => [choice.label, refundNowYen(booking, choice.value)])).toEqual([
      ["全額", 60000],
      ["半額", 30000],
      ["返金なし", 0],
    ]);
    expect(refundTargetYen(90001, "half")).toBe(45000);
    // What went back before counts toward it.
    expect(refundNowYen({ amountYen: 60000, refundedYen: 30000 }, "full")).toBe(30000);
    expect(refundNowYen({ amountYen: 60000, refundedYen: 30000 }, "half")).toBe(0);
    expect([60000, 30000, 0].map(cancelConfirmLabel)).toEqual(["¥60,000 を返金して取り消す", "¥30,000 を返金して取り消す", "予約を取り消す"]);
  });

  it("refunds a traveler's own cancellation in full, and starts with their reason and a message in their language", () => {
    expect(refundChoicesFor("refund_needed")).toEqual(["full"]);
    expect(refundChoicesFor("confirmed")).toEqual(["full", "half", "none"]);
    expect(defaultCancelReason("refund_needed")).toBe("guest");
    expect(defaultCancelReason("confirmed")).toBeNull();
    expect(defaultCancelMessage(byId("bk-2033"))).toMatch(/^As you asked/);
    expect(defaultCancelMessage(byId("bk-2038"))).toMatch(/^We’re very sorry/);
    expect(defaultCancelMessage({ status: "confirmed", language: "ja" })).toContain("ご予約を取り消します");
  });
});

describe("the actions", () => {
  it("承認 charges the card, confirms the booking and sends the meeting guide", () => {
    const approved = approveBooking(byId("bk-2041"), AT);
    expect(approved).toMatchObject({ status: "confirmed", paidAt: AT, meetingGuide: { version: 2, sentAt: AT } });
    expect(approved.timeline.slice(-2)).toEqual([
      { at: AT, text: "承認 · 確定" },
      { at: AT, text: "支払い" },
    ]);
    expect(approveBooking(byId("bk-2038"), AT)).toBe(byId("bk-2038"));
  });

  it("お断り releases the card hold; nothing is sent", () => {
    const declined = declineBooking(byId("bk-2044"), AT);
    expect(declined).toMatchObject({ status: "declined", paidAt: null, meetingGuide: null });
    expect(declined.timeline.at(-1)).toEqual({ at: AT, text: "お断り · 与信を取り消し" });
    expect(declineBooking(byId("bk-2038"), AT)).toBe(byId("bk-2038"));
  });

  it("取消 refunds what was chosen and keeps the reason and the message", () => {
    const half = cancelBooking(byId("bk-2038"), { refund: "half", reason: "host", message: "  Sorry!  " }, AT);
    expect(half).toMatchObject({ status: "cancelled", cancelledAt: AT, cancelReason: "host", cancelMessage: "Sorry!", refundedYen: 30000 });
    expect(half.timeline.at(-1)).toEqual({ at: AT, text: "取消 · 返金 ¥30,000" });
    const none = cancelBooking(byId("bk-2035"), { refund: "none", reason: "other", message: "x" }, AT);
    expect([none.refundedYen, none.timeline.at(-1)?.text]).toEqual([0, "取消 · 返金なし"]);
    // A traveler's own request goes back in full whatever is asked.
    expect(cancelBooking(byId("bk-2033"), { refund: "none", reason: "guest", message: "x" }, AT).refundedYen).toBe(30000);
    // Requests and bookings that already ended cannot be cancelled.
    for (const id of ["bk-2041", "bk-2012", "bk-2026", "bk-2017"]) expect(cancelBooking(byId(id), { refund: "full", reason: "host", message: "x" }, AT), id).toBe(byId(id));
  });

  it("dates an action with the screen's day and the time in Japan", () => {
    expect(actionTime("2026-10-21", Date.UTC(2026, 11, 1, 6, 7))).toBe("2026-10-21T15:07");
  });
});

describe("the booking's rows", () => {
  it("lists what the guest booked, with the answers and the meeting guide's version", () => {
    expect(bookingRequestRows(byId("bk-2044"), "Kamakura Community Dinner with Locals")).toEqual([
      { label: "体験", value: "Kamakura Community Dinner with Locals" },
      { label: "商品", value: "Dinner" },
      { label: "人数", value: "3名（大人 2・子ども 1）" },
      { label: "金額", value: "¥72,000" },
      { label: "内訳", value: "大人 ¥30,000 × 2 ＋ 子ども ¥12,000 × 1" },
      { label: "言語", value: "英語" },
      { label: "申込経路", value: "体験サイト" },
      { label: "申込メモ", value: "Our daughter is 8 and loves cooking.", multiline: true },
      { label: "回答", answers: [{ question: "Any dietary preferences we should know about?", answer: "Our daughter does not eat raw fish." }] },
      { label: "集合案内", value: "v2 · 承認後に送付" },
    ]);
    // No memo, no questions (tea time), and the guide that went out.
    expect(bookingRequestRows(byId("bk-2033"), "").map((row) => row.label)).toEqual(["商品", "人数", "金額", "内訳", "言語", "申込経路", "集合案内"]);
    expect(meetingGuideLabel({ version: 1, sentAt: "2026-10-15T18:02" })).toBe("v1 · 10月15日に送付");
  });

  it("shows only the states that happened", () => {
    expect(bookingStateRows(byId("bk-2041"))).toEqual([
      { label: "予約", value: "承認待ち" },
      { label: "与信", value: "10月20日（火）14:02" },
      { label: "承認期限", value: "10月21日（水）22:00" },
    ]);
    expect(bookingStateRows(byId("bk-2038")).map((row) => row.label)).toEqual(["予約", "与信", "支払い"]);
    expect(bookingStateRows(byId("bk-2033"))).toContainEqual({ label: "累計返金", value: "¥0" });
    expect(bookingStateRows(byId("bk-2012"))).toEqual([
      { label: "予約", value: "取消済み" },
      { label: "与信", value: "10月5日（月）11:20" },
      { label: "支払い", value: "10月5日（月）12:00" },
      { label: "取消依頼", value: "10月12日（月）09:14" },
      { label: "取消", value: "10月12日（月）09:30" },
      { label: "取消理由", value: "旅行者からの依頼" },
      { label: "取消連絡", value: "As you asked, we have cancelled your booking. The full amount will go back to your card.", multiline: true },
      { label: "累計返金", value: "¥60,000" },
    ]);
  });

  it("writes the row, the day and the times the Japanese way", () => {
    expect(bookingRowDetail(byId("bk-2041"))).toBe("2名 · ¥60,000 · 体験サイト");
    expect(bookingWhen(byId("bk-2033"))).toBe("10月25日（日）13:00–15:00 · tea time");
    expect(shortDateTime("2026-10-05T09:04")).toBe("10/5 09:04");
    expect(respondByLabel("2026-10-21T22:00", MOCK_TODAY)).toBe("今日 22:00");
    expect(respondByLabel("2026-10-23T12:00", MOCK_TODAY)).toBe("10月23日（金）12:00");
  });

  it("colors the state as the console does: a passed booking stays 確定 in the quiet tone", () => {
    expect(bookingStatusLabel(byId("bk-2038"), MOCK_TODAY)).toEqual({ label: "確定", tone: "ok" });
    expect(bookingStatusLabel(byId("bk-2020"), MOCK_TODAY)).toEqual({ label: "確定", tone: "draft" });
    expect((["refund_needed", "declined", "expired", "cancelled"] as const).map((status) => [BOOKING_STATUS[status].label, BOOKING_STATUS[status].tone])).toEqual([
      ["要返金", "wait"],
      ["お断り", "draft"],
      ["期限切れ", "draft"],
      ["取消済み", "stop"],
    ]);
  });
});
