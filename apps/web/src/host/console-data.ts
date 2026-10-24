import type { HostMockScenario } from "@/lib/host/session";
import { actionTime, bookingActions, type SessionQuery } from "./bookings";
import { GOOGLE_NOT_CONNECTED } from "./calendar";
import { todayInJapan } from "./format";
import { homeMonth, homeSessions, homeTodos, type HomeMonth, type HomeSessions, type HomeTodo } from "./home";
import { emptyThreadFor } from "./messages";
import { MOCK_NOW, MOCK_TODAY } from "./mock/bookings";
import { MOCK_CONSOLE_PROVIDERS, MOCK_GOOGLE_CONNECTION } from "./mock/provider";
import { MOCK_SALES_PERIOD } from "./mock/sales";
import type { SalesPeriod } from "./sales";
import { sessionBookings } from "./session";
import type {
  HostBooking,
  HostCalendarSettings,
  HostExperience,
  HostGoogleConnection,
  HostMeetingDefaults,
  HostNotificationSettings,
  HostReview,
  HostSale,
  HostThread,
} from "./types";

export type HostDataMode = "mock" | "http";

/** What the console shows for one provider beyond NIHO's provider record. */
export interface HostConsoleSnapshot {
  /** YYYY-MM-DD in Japan. */
  today: string;
  /** YYYY-MM-DDTHH:MM in Japan: what ホーム's deadlines and "2 時間前" count from (the preview's fixed moment in mock mode). */
  now: string;
  /** The months 売上 moves between (its current one is the home card's); null while sales cannot be read. */
  salesPeriod: SalesPeriod | null;
  experiences: readonly HostExperience[];
  bookings: readonly HostBooking[];
  /** メッセージ (#106): the guests' questions and the bookings' messages. */
  threads: readonly HostThread[];
  /** レビュー (#108): the guests' reviews, published or still checked by NIHO. */
  reviews: readonly HostReview[];
  sales: readonly HostSale[];
  meetingPoint: HostMeetingDefaults;
  /** カレンダー (#109): the Google Calendar and the bookings feed. */
  calendar: HostCalendarSettings;
  /** 通知 (#109), as NIHO answers its owner. */
  notifications: HostNotificationSettings;
}

const NO_MEETING_POINT: HostMeetingDefaults = { area: "", mapUrl: "", entrance: "" };
const NO_CALENDAR: HostCalendarSettings = { google: GOOGLE_NOT_CONNECTED, icsUrl: null };
/** NIHO lists every notification as it starts it (notifications.ts fills them in). */
const NO_NOTIFICATIONS: HostNotificationSettings = { email: { addresses: [] }, items: [] };

/** The preview's `?mock=calendar-revoked`: a connected Google Calendar whose access was taken away in Google. */
function withScenario(calendar: HostCalendarSettings, scenario: HostMockScenario): HostCalendarSettings {
  return scenario === "calendar-revoked" && calendar.google.status === "connected" ? { ...calendar, google: { ...calendar.google, status: "revoked" } } : calendar;
}

/**
 * The data behind the console pages for a provider. Mock mode (the preview) has the
 * synthetic sets in ./mock with a fixed "today" (a provider without a set has nothing in
 * the preview's sales months); http mode has nothing to show yet. `scenario` is the mock
 * session's (`?mock=` on the mock sign-in).
 */
export function hostConsoleSnapshot(providerId: string, mode: HostDataMode, now: number, scenario: HostMockScenario = "default"): HostConsoleSnapshot {
  const mock = mode === "mock" ? MOCK_CONSOLE_PROVIDERS.get(providerId) : undefined;
  if (mock) return { today: MOCK_TODAY, now: MOCK_NOW, salesPeriod: MOCK_SALES_PERIOD, ...mock, calendar: withScenario(mock.calendar, scenario) };
  // TODO(#87): experiences, bookings, messages, reviews, sales, the meeting defaults, the calendar
  // (niho-app#19316/#19317) and the notification settings (#19315) are not in the host contract
  // yet. The payout account is: data.ts reads it from NIHO.
  const today = mode === "mock" ? MOCK_TODAY : todayInJapan(now);
  return {
    today,
    now: mode === "mock" ? MOCK_NOW : actionTime(today, now),
    salesPeriod: mode === "mock" ? MOCK_SALES_PERIOD : null,
    experiences: [],
    bookings: [],
    threads: [],
    reviews: [],
    sales: [],
    meetingPoint: NO_MEETING_POINT,
    calendar: NO_CALENDAR,
    notifications: NO_NOTIFICATIONS,
  };
}

/**
 * The Google account the preview's つなぐ connects (synthetic); null in http mode, where connecting
 * waits for NIHO's Google sign-in (niho-app#19317).
 */
export function googleConnectionPreview(mode: HostDataMode): HostGoogleConnection | null {
  // TODO(#87): NIHO's Google connection opens Google's consent page and comes back with the calendars.
  return mode === "mock" ? MOCK_GOOGLE_CONNECTION : null;
}

/** What the experience editor (#89) opens for an id. */
export type HostEditorExperience =
  | { status: "ready"; experience: HostExperience }
  | { status: "missing" }
  /** http mode: pages cannot be read or saved until the provider API is connected (#87). The page says 準備中. */
  | { status: "unavailable" };

/** The page the editor opens: the synthetic one in mock mode; nothing to edit yet in http mode. */
export function editorExperience(snapshot: Pick<HostConsoleSnapshot, "experiences">, mode: HostDataMode, id: string): HostEditorExperience {
  // TODO(#87): read the page, with the x-niho-page-updated-at it was read at, from the provider API.
  if (mode === "http") return { status: "unavailable" };
  const experience = snapshot.experiences.find((candidate) => candidate.id === id);
  return experience ? { status: "ready", experience } : { status: "missing" };
}

/** 予約 (#90): the provider's bookings, or (http mode) nothing to show until the provider API has them. */
export type HostBookingList =
  | { status: "ready"; bookings: readonly HostBooking[] }
  /** http mode: bookings cannot be read or answered until the provider API is connected (#87). The page says 準備中. */
  | { status: "unavailable" };

/** 予約 never carries the guest's phone: only the session's own screen shows it (#103, #107). */
function withoutPhone(booking: HostBooking): HostBooking {
  return booking.phone === null ? booking : { ...booking, phone: null };
}

/** The bookings screen's list: the synthetic one in mock mode; nothing to read yet in http mode. */
export function bookingList(snapshot: Pick<HostConsoleSnapshot, "bookings">, mode: HostDataMode): HostBookingList {
  // TODO(#87): read the provider's bookings from the provider API once the contract has them.
  return mode === "http" ? { status: "unavailable" } : { status: "ready", bookings: snapshot.bookings.map(withoutPhone) };
}

/**
 * When the bookings screen dates an action (YYYY-MM-DDTHH:MM, JST): the preview's fixed moment
 * in mock mode, so actions follow the synthetic timeline; null takes the clock.
 * TODO(#87): NIHO's own times, read back after each action.
 */
export function bookingClock(mode: HostDataMode): string | null {
  return mode === "mock" ? MOCK_NOW : null;
}

/** One booking the screen opens (`?booking=`). */
export type HostBookingLookup = { status: "ready"; booking: HostBooking } | { status: "missing" } | { status: "unavailable" };

/** The booking with this id among the provider's own; another provider's booking is missing here. */
export function bookingOf(snapshot: Pick<HostConsoleSnapshot, "bookings">, mode: HostDataMode, id: string): HostBookingLookup {
  const list = bookingList(snapshot, mode);
  if (list.status === "unavailable") return list;
  const booking = list.bookings.find((candidate) => candidate.id === id);
  return booking ? { status: "ready", booking } : { status: "missing" };
}

/** この回 (#107): what the session's screen shows of it. */
export interface HostSessionView {
  /** YYYY-MM-DD and HH:MM in Japan. */
  date: string;
  start: string;
  end: string;
  experienceId: string;
  offerId: string;
  /** The experience's title (the offer's name when the experience is not among the provider's). */
  title: string;
  /** The offer's name when it was booked. */
  offer: string;
  capacity: number | null;
  /** 集合場所's public line (English, as the experience site shows it); empty when the page has none. */
  meetingArea: string;
  /** Every booking of the session, whatever its state, with the phone the guest gave. */
  bookings: readonly HostBooking[];
}

export type HostSessionLookup =
  | { status: "ready"; session: HostSessionView }
  /** No booking of the provider's is on that session (another provider's, or none at all). */
  | { status: "missing" }
  /** http mode: the guests and attendance cannot be read until NIHO's API has them (niho-app#19321). The page says 準備中. */
  | { status: "unavailable" };

/** The session the screen's address names: the synthetic one in mock mode; nothing to read yet in http mode. */
export function sessionOf(snapshot: Pick<HostConsoleSnapshot, "bookings" | "experiences">, mode: HostDataMode, query: SessionQuery): HostSessionLookup {
  // TODO(#87): read the session's guests, their phone and food wishes and the attendance from NIHO.
  if (mode === "http") return { status: "unavailable" };
  const bookings = sessionBookings(snapshot.bookings, query);
  const first = bookings[0];
  if (!first) return { status: "missing" };
  const experience = snapshot.experiences.find((candidate) => candidate.id === query.experience);
  return {
    status: "ready",
    session: {
      date: query.date,
      start: query.start,
      end: first.end,
      experienceId: query.experience,
      offerId: query.offer,
      title: experience?.title || first.offer,
      offer: first.offer,
      capacity: experience?.offers.find((offer) => offer.id === query.offer)?.capacity ?? null,
      meetingArea: experience?.meeting.area.trim() ?? "",
      bookings,
    },
  };
}

/** メッセージ (#106): the provider's threads, or (http mode) nothing to show until NIHO's API has them. */
export type HostThreadList =
  | { status: "ready"; threads: readonly HostThread[] }
  /** http mode: questions and booking messages cannot be read or answered until NIHO's API has them (niho-app#19319/#19238). The page says 準備中. */
  | { status: "unavailable" };

/** The messages screen's list: the synthetic one in mock mode; nothing to read yet in http mode. */
export function threadList(snapshot: Pick<HostConsoleSnapshot, "threads">, mode: HostDataMode): HostThreadList {
  // TODO(#87): read the provider's threads from NIHO once the host contract has them.
  return mode === "http" ? { status: "unavailable" } : { status: "ready", threads: snapshot.threads };
}

/** What `?thread=` or `?booking=` opens on the messages screen. */
export type HostThreadLookup =
  /** The provider's thread. */
  | { status: "thread"; thread: HostThread }
  /** A booking that can be written to and has no thread yet: an empty one, which the first reply starts. */
  | { status: "new"; thread: HostThread }
  | { status: "missing" }
  | { status: "unavailable" };

/** The thread with this id among the provider's own; another provider's thread is missing here. */
export function threadOf(snapshot: Pick<HostConsoleSnapshot, "threads">, mode: HostDataMode, id: string): HostThreadLookup {
  const list = threadList(snapshot, mode);
  if (list.status === "unavailable") return list;
  const thread = list.threads.find((candidate) => candidate.id === id);
  return thread ? { status: "thread", thread } : { status: "missing" };
}

/**
 * A booking's thread (予約 › メッセージ): the one it is joined to, or an empty one when the guest
 * can still be written to (bookingActions), else missing, like another provider's booking.
 */
export function bookingThreadOf(snapshot: Pick<HostConsoleSnapshot, "threads" | "bookings">, mode: HostDataMode, bookingId: string): HostThreadLookup {
  const list = threadList(snapshot, mode);
  if (list.status === "unavailable") return list;
  const thread = list.threads.find((candidate) => candidate.booking?.id === bookingId);
  if (thread) return { status: "thread", thread };
  const booking = snapshot.bookings.find((candidate) => candidate.id === bookingId);
  return booking && bookingActions(booking.status).message ? { status: "new", thread: emptyThreadFor(booking) } : { status: "missing" };
}

/** レビュー (#108): the provider's reviews, or (http mode) nothing to show until NIHO's API has them. */
export type HostReviewList =
  | { status: "ready"; reviews: readonly HostReview[] }
  /** http mode: reviews cannot be read, answered or reported until NIHO's API has them (niho-app#19314). The page says 準備中. */
  | { status: "unavailable" };

/** The reviews screen's list: the synthetic one in mock mode; nothing to read yet in http mode. */
export function reviewList(snapshot: Pick<HostConsoleSnapshot, "reviews">, mode: HostDataMode): HostReviewList {
  // TODO(#87): read the provider's reviews from NIHO once the host contract has them.
  return mode === "http" ? { status: "unavailable" } : { status: "ready", reviews: snapshot.reviews };
}

/** 売上 (#91): the provider's ledger and its months, or (http mode) nothing to show until the provider API has sales. */
export type HostSalesList =
  | { status: "ready"; period: SalesPeriod; sales: readonly HostSale[] }
  /** http mode: sales cannot be read until NIHO's API has them. The page says 準備中. */
  | { status: "unavailable" };

export function salesList(snapshot: Pick<HostConsoleSnapshot, "salesPeriod" | "sales">): HostSalesList {
  // TODO: read the provider's ledger from NIHO once the host contract has sales.
  return snapshot.salesPeriod ? { status: "ready", period: snapshot.salesPeriod, sales: snapshot.sales } : { status: "unavailable" };
}

export interface HostHomeData {
  todos: HomeTodo[];
  sessions: HomeSessions;
  month: HomeMonth | null;
}

/** ホーム: 次にすること, today's and tomorrow's sessions, これからの開催 and the month's numbers. */
export function hostHome(snapshot: HostConsoleSnapshot): HostHomeData {
  return {
    todos: homeTodos(snapshot.experiences, snapshot.bookings, snapshot.threads, snapshot.today, snapshot.now, snapshot.reviews),
    sessions: homeSessions(snapshot.experiences, snapshot.bookings, snapshot.now),
    month: snapshot.salesPeriod ? homeMonth(snapshot.sales, snapshot.salesPeriod.current) : null,
  };
}
