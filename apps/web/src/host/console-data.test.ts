import { describe, expect, it } from "vitest";
import { createMockHostFetch, MOCK_ID_TOKEN_PREFIX } from "@/lib/host/mock-niho";
import { GOOGLE_NOT_CONNECTED } from "./calendar";
import {
  bookingClock,
  bookingList,
  bookingOf,
  bookingThreadOf,
  editorExperience,
  googleConnectionPreview,
  hostConsoleSnapshot,
  hostHome,
  reviewList,
  salesList,
  sessionOf,
  threadList,
  threadOf,
} from "./console-data";
import { notificationRows } from "./notifications";
import { MOCK_CONSOLE_PROVIDERS, MOCK_GOOGLE_CONNECTION } from "./mock/provider";
import { MOCK_KITCHEN_REVIEWS } from "./mock/reviews";
import { MOCK_KITCHEN_SALES, MOCK_SALES_PERIOD } from "./mock/sales";
import { MOCK_KITCHEN_THREADS } from "./mock/threads";

const NOW = Date.UTC(2026, 11, 1, 3, 0);

describe("console data per provider", () => {
  it("gives the sample kitchen its listings, bookings and sales", () => {
    const snapshot = hostConsoleSnapshot("sample-provider-kitchen", "mock", NOW);
    expect(snapshot.experiences.map((experience) => [experience.id, experience.status])).toEqual([
      ["community-dinner", "live"],
      ["kintsugi", "review"],
      ["coffee", "draft"],
    ]);
    expect(snapshot.salesPeriod).toEqual(MOCK_SALES_PERIOD);
    expect(snapshot.notifications.email.addresses).toEqual(["kitchen@example.com"]);
    expect(notificationRows(snapshot.notifications.items).every((row) => row.enabled)).toBe(true);
    expect(snapshot.calendar.google).toMatchObject({ status: "connected", account: "kitchen@example.com", blockBusy: true, writeBookings: true, writeCalendarId: "sample-kitchen-main" });
    expect(snapshot.calendar.icsUrl).toMatch(/^https:\/\/calendar\.example\.com\/sample-kitchen\/[0-9a-z]{20,}\/bookings\.ics$/);
    expect(snapshot.now).toBe("2026-10-21T15:30");
    const home = hostHome(snapshot);
    expect(home.todos.map((todo) => todo.status?.label)).toEqual(["承認待ち", "承認待ち", "返信待ち", "返信待ち", "返信待ち", "未返信", "未返信", "公開前", "下書き", "審査待ち"]);
    expect([home.sessions.today, home.sessions.tomorrow, home.sessions.later].map((sessions) => sessions.length)).toEqual([1, 1, 3]);
    // The preview keeps its own "today": the synthetic dates stay upcoming whenever it is opened.
    expect(home.month).toEqual({ label: "10月", sales: "¥390,000", refunds: "−¥60,000", expected: "¥139,500", confirmed: "8件" });
  });

  it("gives the sample studio one draft and nothing booked", () => {
    const snapshot = hostConsoleSnapshot("sample-provider-studio", "mock", NOW);
    expect(snapshot.experiences.map((experience) => [experience.title, experience.status])).toEqual([["Write Your Own Kanji with a Kamakura Calligrapher", "draft"]]);
    expect(snapshot.bookings).toEqual([]);
    expect(snapshot.threads).toEqual([]);
    expect(snapshot.reviews).toEqual([]);
    expect(snapshot.sales).toEqual([]);
    expect(snapshot.calendar.google).toEqual(GOOGLE_NOT_CONNECTED);
    expect(snapshot.notifications.email.addresses).toEqual(["studio@example.com"]);
    const home = hostHome(snapshot);
    expect(home.todos.map((todo) => [todo.title, todo.detail, todo.action?.href])).toEqual([
      // Derived from the page (no photo, no offer yet, written in Japanese with no English yet), as the editor's 掲載までに必要 shows it.
      ["Write Your Own Kanji with a Kamakura Calligrapher の原稿を仕上げる", "表紙写真と料金が未入力 · 英語が未確定", "/host/experiences/calligraphy"],
    ]);
    expect(home.sessions).toEqual({ today: [], tomorrow: [], later: [] });
    expect(home.month).toEqual({ label: "10月", sales: "¥0", refunds: "¥0", expected: "¥0", confirmed: "0件" });
  });

  it("covers every provider the synthetic NIHO returns", async () => {
    const response = await createMockHostFetch("default")("https://niho.example.test/api/experience-providers", { headers: { authorization: `Bearer ${MOCK_ID_TOKEN_PREFIX}test` } });
    const { providers } = (await response.json()) as { providers: { id: string }[] };
    expect(providers.map((provider) => provider.id).sort()).toEqual([...MOCK_CONSOLE_PROVIDERS.keys()].sort());
  });

  it("shows nothing invented for providers outside the preview set: the preview's sales months, empty", () => {
    for (const id of ["someone-else", "constructor", "__proto__", "sample-provider-garden"]) {
      const snapshot = hostConsoleSnapshot(id, "mock", NOW);
      expect(snapshot, id).toMatchObject({
        experiences: [],
        bookings: [],
        threads: [],
        reviews: [],
        sales: [],
        salesPeriod: MOCK_SALES_PERIOD,
        calendar: { google: GOOGLE_NOT_CONNECTED, icsUrl: null },
        notifications: { email: { addresses: [] }, items: [] },
      });
      expect(hostHome(snapshot).month, id).toEqual({ label: "10月", sales: "¥0", refunds: "¥0", expected: "¥0", confirmed: "0件" });
    }
  });

  it("gives 売上 the provider's ledger and months in mock mode, and nothing to read in http mode yet", () => {
    expect(salesList(hostConsoleSnapshot("sample-provider-kitchen", "mock", NOW))).toEqual({ status: "ready", period: MOCK_SALES_PERIOD, sales: MOCK_KITCHEN_SALES });
    expect(salesList(hostConsoleSnapshot("sample-provider-studio", "mock", NOW))).toEqual({ status: "ready", period: MOCK_SALES_PERIOD, sales: [] });
    expect(salesList(hostConsoleSnapshot("sample-provider-kitchen", "http", NOW))).toEqual({ status: "unavailable" });
  });

  it("opens the provider's own experience in the editor, and nothing in http mode yet (#87)", () => {
    const kitchen = hostConsoleSnapshot("sample-provider-kitchen", "mock", NOW);
    const opened = editorExperience(kitchen, "mock", "community-dinner");
    expect(opened.status === "ready" && [opened.experience.title, opened.experience.photos.length, opened.experience.offers.map((offer) => offer.name)]).toEqual(["Kamakura Community Dinner with Locals", 8, ["Dinner", "tea time"]]);
    // Another provider's experience is not this provider's to edit.
    expect(editorExperience(hostConsoleSnapshot("sample-provider-studio", "mock", NOW), "mock", "community-dinner")).toEqual({ status: "missing" });
    expect(editorExperience(kitchen, "mock", "no-such-experience")).toEqual({ status: "missing" });
    expect(editorExperience(kitchen, "http", "community-dinner")).toEqual({ status: "unavailable" });
  });

  it("lists the provider's own bookings and opens one of them, and has none to read in http mode yet (#87)", () => {
    const kitchen = hostConsoleSnapshot("sample-provider-kitchen", "mock", NOW);
    const list = bookingList(kitchen, "mock");
    expect(list.status === "ready" && list.bookings.map((booking) => booking.status)).toEqual([
      "pending",
      "confirmed",
      "confirmed",
      "confirmed",
      "confirmed",
      "cancelled",
      "refund_needed",
      "pending",
      "declined",
      "expired",
      "confirmed",
      "confirmed",
      "confirmed",
      // The past dinners with a review (#108).
      "confirmed",
      "confirmed",
      "confirmed",
      "confirmed",
      "confirmed",
    ]);
    // 予約 never carries the guest's phone: only この回 shows it (#107).
    expect(list.status === "ready" && list.bookings.filter((booking) => booking.phone !== null)).toEqual([]);
    expect(kitchen.bookings.filter((booking) => booking.phone !== null).map((booking) => booking.id)).toEqual(["bk-2038", "bk-2020", "bk-2003"]);
    expect(bookingOf(kitchen, "mock", "bk-2038")).toMatchObject({ status: "ready", booking: { guest: "Emma Larsson", phone: null } });
    expect(bookingOf(kitchen, "mock", "bk-2041")).toMatchObject({ status: "ready", booking: { guest: "Lucas & Mia Chen" } });
    expect(bookingOf(kitchen, "mock", "no-such-booking")).toEqual({ status: "missing" });
    // Another provider's booking is not this provider's to open.
    expect(bookingOf(hostConsoleSnapshot("sample-provider-studio", "mock", NOW), "mock", "bk-2041")).toEqual({ status: "missing" });
    // The preview dates actions with its own fixed moment, after the synthetic timeline.
    expect(bookingClock("mock")).toBe("2026-10-21T15:30");
    expect(bookingClock("http")).toBeNull();
    expect(bookingList(kitchen, "http")).toEqual({ status: "unavailable" });
    expect(bookingOf(kitchen, "http", "bk-2041")).toEqual({ status: "unavailable" });
  });

  it("opens a session of the provider's with all its bookings and the guests' phones, and has none to read in http mode yet (#87)", () => {
    const kitchen = hostConsoleSnapshot("sample-provider-kitchen", "mock", NOW);
    const dinner = { date: "2026-10-22", start: "18:00", experience: "community-dinner", offer: "offer-dinner" };
    const opened = sessionOf(kitchen, "mock", dinner);
    expect(opened.status === "ready" && { ...opened.session, bookings: opened.session.bookings.map((booking) => [booking.id, booking.phone]) }).toEqual({
      date: "2026-10-22",
      start: "18:00",
      end: "20:00",
      experienceId: "community-dinner",
      offerId: "offer-dinner",
      title: "Kamakura Community Dinner with Locals",
      offer: "Dinner",
      capacity: 8,
      meetingArea: "Near Kamakura Station, 2-minute walk",
      bookings: [
        ["bk-2041", null],
        ["bk-2038", "+44 7700 900123"],
      ],
    });
    // A session with only cancelled bookings still opens; one without any booking, or another provider's, does not.
    expect(sessionOf(kitchen, "mock", { ...dinner, date: "2026-10-15" })).toMatchObject({ status: "ready" });
    expect(sessionOf(kitchen, "mock", { ...dinner, date: "2026-10-20" })).toEqual({ status: "missing" });
    expect(sessionOf(kitchen, "mock", { ...dinner, offer: "offer-tea" })).toEqual({ status: "missing" });
    expect(sessionOf(hostConsoleSnapshot("sample-provider-studio", "mock", NOW), "mock", dinner)).toEqual({ status: "missing" });
    expect(sessionOf(kitchen, "http", dinner)).toEqual({ status: "unavailable" });
  });

  it("lists the provider's own threads and opens one, or a booking's (an empty one to start), and has none to read in http mode yet (#87)", () => {
    const kitchen = hostConsoleSnapshot("sample-provider-kitchen", "mock", NOW);
    expect(threadList(kitchen, "mock")).toEqual({ status: "ready", threads: MOCK_KITCHEN_THREADS });
    expect(threadOf(kitchen, "mock", "th-3012")).toMatchObject({ status: "thread", thread: { guest: "Emma Wilson" } });
    expect(threadOf(kitchen, "mock", "no-such-thread")).toEqual({ status: "missing" });
    // A booking with a thread opens it; one without starts an empty one; an ended request has none to start.
    expect(bookingThreadOf(kitchen, "mock", "bk-2031")).toMatchObject({ status: "thread", thread: { id: "th-3004" } });
    expect(bookingThreadOf(kitchen, "mock", "bk-2044")).toMatchObject({ status: "new", thread: { id: "th-bk-2044", guest: "Ana Souza", messages: [] } });
    expect(bookingThreadOf(kitchen, "mock", "bk-2012")).toMatchObject({ status: "new" });
    expect(bookingThreadOf(kitchen, "mock", "bk-2026")).toEqual({ status: "missing" });
    expect(bookingThreadOf(kitchen, "mock", "no-such-booking")).toEqual({ status: "missing" });
    // Another provider's thread or booking is not this provider's to open.
    const studio = hostConsoleSnapshot("sample-provider-studio", "mock", NOW);
    expect([threadOf(studio, "mock", "th-3012"), bookingThreadOf(studio, "mock", "bk-2031")]).toEqual([{ status: "missing" }, { status: "missing" }]);
    expect(threadList(kitchen, "http")).toEqual({ status: "unavailable" });
    expect([threadOf(kitchen, "http", "th-3012"), bookingThreadOf(kitchen, "http", "bk-2031")]).toEqual([{ status: "unavailable" }, { status: "unavailable" }]);
  });

  it("lists the provider's own reviews, and has none to read in http mode yet (#87, #108)", () => {
    expect(reviewList(hostConsoleSnapshot("sample-provider-kitchen", "mock", NOW), "mock")).toEqual({ status: "ready", reviews: MOCK_KITCHEN_REVIEWS });
    expect(reviewList(hostConsoleSnapshot("sample-provider-studio", "mock", NOW), "mock")).toEqual({ status: "ready", reviews: [] });
    expect(reviewList(hostConsoleSnapshot("sample-provider-kitchen", "mock", NOW), "http")).toEqual({ status: "unavailable" });
  });

  it("is empty in http mode until the provider API is connected (#87)", () => {
    const snapshot = hostConsoleSnapshot("sample-provider-kitchen", "http", NOW);
    expect(snapshot).toEqual({
      today: "2026-12-01",
      now: "2026-12-01T12:00",
      salesPeriod: null,
      experiences: [],
      bookings: [],
      threads: [],
      reviews: [],
      sales: [],
      meetingPoint: { area: "", mapUrl: "", entrance: "" },
      calendar: { google: GOOGLE_NOT_CONNECTED, icsUrl: null },
      notifications: { email: { addresses: [] }, items: [] },
    });
    expect(hostHome(snapshot)).toEqual({ todos: [], sessions: { today: [], tomorrow: [], later: [] }, month: null });
  });
});

describe("the calendar in the preview (#109)", () => {
  it("takes the kitchen's Google access away for ?mock=calendar-revoked, keeping its account and choices", () => {
    const revoked = hostConsoleSnapshot("sample-provider-kitchen", "mock", NOW, "calendar-revoked").calendar;
    const usual = hostConsoleSnapshot("sample-provider-kitchen", "mock", NOW).calendar;
    expect(revoked).toEqual({ ...usual, google: { ...usual.google, status: "revoked" } });
    // A calendar that was never connected stays so; nothing else of the scenario differs.
    expect(hostConsoleSnapshot("sample-provider-studio", "mock", NOW, "calendar-revoked").calendar.google).toEqual(GOOGLE_NOT_CONNECTED);
    expect(hostConsoleSnapshot("sample-provider-kitchen", "mock", NOW, "calendar-revoked").bookings).toEqual(hostConsoleSnapshot("sample-provider-kitchen", "mock", NOW).bookings);
    // http mode never reads the scenario.
    expect(hostConsoleSnapshot("sample-provider-kitchen", "http", NOW, "calendar-revoked").calendar.google).toEqual(GOOGLE_NOT_CONNECTED);
  });

  it("connects the synthetic Google account in the preview only", () => {
    expect(googleConnectionPreview("mock")).toBe(MOCK_GOOGLE_CONNECTION);
    expect(MOCK_GOOGLE_CONNECTION.account).toBe("host@example.com");
    expect(googleConnectionPreview("http")).toBeNull();
  });
});
