import type { BookingAttendanceStatus, HostGuestBooking, HostGuestSession, HostSessionAttendance } from "@niho-experience/experience-store";
import { actionTime, seatsLabel, sessionHref, type SessionQuery } from "./bookings";
import type { HostHomeData, HostSessionView } from "./console-data";
import { addDays, dateWithWeekdayJa, dayOfMonth, durationJa, shortDateWithWeekdayJa, weekdayJa } from "./format";
import type { HomeSessions, HomeTodo, HomeUpcoming } from "./home";
import { SESSION_PHASE_LABELS, sessionPhase } from "./session";
import { siteBooking } from "./site-bookings";
import { BOOKING_STATUS } from "./status";
import type { HostAttendance, HostBooking } from "./types";

/*
 * ホーム and この回 for the bookings travelers made on this site (#285 slice 8b, docs/guest-booking.md「ホストの画面」):
 * the experience DB's sessions as ホーム's rows and 次にすること, and one session's bookings as この回 shows them.
 * A session is what the bookings' occurrence snapshots name (the day, the start, the experience and the offer), as
 * 予約 groups them. この回 also has each guest's thread (slice 6b), calling the session off (slice 7) and, with
 * EXPERIENCE_HOST_ATTENDANCE_ENABLED, 出欠 and the session's capacity (#107).
 * Type-only use of the store: the screens' client code shares these rules and texts.
 */

/** Beside NIHO's bookings (provider operations on): the rows and the todos of this site's bookings say so. */
export const SITE_SESSION_LABEL = "このサイトの予約";
/** 次にすること for a session with payments under review (確認待ち). */
export const SITE_PAYMENT_REVIEW_TODO_TITLE = "確認待ちの支払いがあります";
/** ホーム when the sessions could not be read: the rows and todos above may be missing some. */
export const SITE_HOME_LOAD_FAILED_TEXT = "このサイトで受けた予約を読み込めませんでした。開催と次にすることに出ていない予約があるかもしれません。";
export const SITE_SESSION_LOAD_FAILED_TEXT = "参加者を読み込めませんでした。時間をおいて、もう一度お試しください。";
/** 出欠 (#107) when it could not be kept: the mark the screen had stays. */
export const SITE_ATTENDANCE_FAILED_TEXT = "出欠を記録できませんでした。時間をおいて、もう一度お試しください。";
/** The store's NOT_STARTED: the browser thought the session had started, the database did not. */
export const SITE_ATTENDANCE_NOT_STARTED_TEXT = "まだ開始時刻前のため、出欠は付けられません。開始後にもう一度お試しください。";
/** The store's NOT_CONFIRMED: the booking was cancelled (or is under review) since the screen opened. */
export const SITE_ATTENDANCE_NOT_CONFIRMED_TEXT = "この予約は確定していないため、出欠を付けられません。画面を開き直してください。";

/** ホーム's part from this site: the sessions by day and 次にすること. */
export interface SiteHome {
  sessions: HomeSessions;
  todos: HomeTodo[];
}

function queryOf(session: HostGuestSession): SessionQuery {
  return { date: session.localDate, start: session.localStartTime, experience: session.productId, offer: session.offerId };
}

/** この回 of a session of this site; beside NIHO's bookings with `?source=site`, so "‹ 予約" goes back to this site's. */
export function siteSessionHref(session: HostGuestSession, besideNiho: boolean): string {
  return sessionHref({ ...queryOf(session), source: besideNiho ? "site" : null });
}

/** HH:MM in Japan of the session's end. */
function endOf(session: Pick<HostGuestSession, "localDate" | "endUtc">): string {
  return actionTime(session.localDate, Date.parse(session.endUtc)).slice(11);
}

function homeRow(session: HostGuestSession, now: string | null, besideNiho: boolean): HomeUpcoming {
  const minutes = Math.round((Date.parse(session.endUtc) - Date.parse(session.startUtc)) / 60_000);
  const span = { date: session.localDate, start: session.localStartTime, end: endOf(session) };
  return {
    key: `site/${session.localDate}T${session.localStartTime}/${session.productId}/${session.offerId}`,
    href: siteSessionHref(session, besideNiho),
    dateLabel: dateWithWeekdayJa(session.localDate),
    weekday: weekdayJa(session.localDate),
    day: dayOfMonth(session.localDate),
    title: session.productTitle,
    detail: [`${session.localStartTime} 開始`, minutes > 0 ? durationJa(minutes) : null].filter(Boolean).join(" · "),
    // A booking keeps the occurrence's capacity only as it was when it was made: "4名", as 予約's headings say.
    seats: seatsLabel({ guests: session.participants, capacity: null }),
    bookings: `${session.bookings}件`,
    // The bookings made here ask for food wishes only among the experience's own questions (この回 shows the answers).
    dietary: "",
    // No attendance is kept for them: today's rows say only where the session stands.
    phase: now ? { text: SESSION_PHASE_LABELS[sessionPhase(span, now)], tone: "muted" } : null,
    ...(besideNiho ? { source: SITE_SESSION_LABEL } : {}),
  };
}

/**
 * ホーム's 今日・明日・これからの開催 from this site's sessions (the nearest first, from today): today's also once
 * started or over, tomorrow's, and `limit` after that, as homeSessions splits NIHO's. `now` is YYYY-MM-DDTHH:MM in Japan.
 * Who may come counts the confirmed bookings and the payments under review (the store's participants).
 */
export function siteHomeSessions(sessions: readonly HostGuestSession[], now: string, besideNiho: boolean, limit = 3): HomeSessions {
  const [today = ""] = now.split("T");
  const tomorrow = addDays(today, 1);
  return {
    today: sessions.filter((session) => session.localDate === today).map((session) => homeRow(session, now, besideNiho)),
    tomorrow: sessions.filter((session) => session.localDate === tomorrow).map((session) => homeRow(session, null, besideNiho)),
    later: sessions
      .filter((session) => session.localDate > tomorrow)
      .slice(0, limit)
      .map((session) => homeRow(session, null, besideNiho)),
  };
}

/**
 * 次にすること: one row per session with payments under review (確認待ち: paid after the hold ended, no seat kept),
 * leading to この回. Nothing on the screen settles them yet (NIHO support does), so they are not in the app badge.
 */
export function siteHomeTodos(sessions: readonly HostGuestSession[], besideNiho: boolean): HomeTodo[] {
  return sessions
    .filter((session) => session.paymentReviews > 0)
    .map((session) => ({
      key: `site-payment-review/${session.localDate}T${session.localStartTime}/${session.productId}/${session.offerId}`,
      status: BOOKING_STATUS.payment_review,
      aside: besideNiho ? { text: SITE_SESSION_LABEL, tone: "muted" } : null,
      title: SITE_PAYMENT_REVIEW_TODO_TITLE,
      detail: [`${shortDateWithWeekdayJa(session.localDate)}${session.localStartTime}`, session.productTitle, `${session.paymentReviews} 件`, "席は確保されていません"].join(" · "),
      approval: null,
      action: { label: "この回を見る", href: siteSessionHref(session, besideNiho), primary: false },
    }));
}

/**
 * ホーム with this site's part: its todos first (NIHO's are none in http mode yet), and its sessions after NIHO's
 * on each day. Without NIHO's bookings they are the whole screen; beside them, each row says it is this site's.
 */
export function withSiteHome(home: HostHomeData, site: SiteHome): HostHomeData {
  return {
    ...home,
    todos: [...site.todos, ...home.todos],
    sessions: {
      today: [...home.sessions.today, ...site.sessions.today],
      tomorrow: [...home.sessions.tomorrow, ...site.sessions.tomorrow],
      later: [...home.sessions.later, ...site.sessions.later],
    },
  };
}

/** One booking as この回 shows it: as 予約 does, with the phone the guest gave. この回 is the one screen that has it (#103). */
export function siteSessionBooking(stored: HostGuestBooking): HostBooking {
  return { ...siteBooking(stored), phone: stored.guest?.phone ?? null };
}

const ATTENDANCE: Record<BookingAttendanceStatus, HostAttendance> = { ATTENDED: "attended", NO_SHOW: "no_show" };
const STORED_ATTENDANCE: Record<HostAttendance, BookingAttendanceStatus> = { attended: "ATTENDED", no_show: "NO_SHOW" };

/** 来た / 来なかった as the store keeps it, and back. */
export function siteAttendance(status: BookingAttendanceStatus): HostAttendance {
  return ATTENDANCE[status];
}

export function storedAttendance(value: HostAttendance): BookingAttendanceStatus {
  return STORED_ATTENDANCE[value];
}

/**
 * この回 of this site's bookings for the session `query` names; null when it has none of the provider's. With
 * `attendance` (#107, its flag on) each booking carries its mark and the session the occurrence's capacity now.
 */
export function siteSessionView(stored: readonly HostGuestBooking[], query: SessionQuery, attendance: HostSessionAttendance | null = null): HostSessionView | null {
  const first = stored[0];
  if (!first) return null;
  const marks = new Map(attendance?.marks.map((mark) => [mark.publicBookingId, siteAttendance(mark.status)]));
  const bookings = stored.map((booking) => ({ ...siteSessionBooking(booking), attendance: marks.get(booking.publicBookingId) ?? null }));
  return {
    date: query.date,
    start: query.start,
    end: bookings[0]!.end,
    experienceId: query.experience,
    offerId: query.offer,
    title: first.productTitle,
    offer: first.productTitle,
    // The occurrence's now (#107); unknown without it, as on 予約: the bookings keep it only as it was when each was made.
    capacity: attendance?.capacity ?? null,
    // Not in the experience DB's booking: 集合 is left out.
    meetingArea: "",
    bookings,
  };
}

/**
 * この回's count of this site's guests: "参加 4 名" counts the confirmed bookings and the payments under review, as
 * ホーム does ("参加 4 名 · 定員 8" when the capacity is known, #107), and "うち確認待ち 1 名（席は確保されていません）"
 * says how many of them keep no seat.
 */
export function siteSessionCountLines(bookings: readonly Pick<HostBooking, "status" | "guests">[], capacity: number | null = null): { main: string; pending: string | null } {
  const sum = (status: HostBooking["status"]) => bookings.filter((booking) => booking.status === status).reduce((total, booking) => total + booking.guests, 0);
  const review = sum("payment_review");
  const main = `参加 ${sum("confirmed") + review} 名`;
  return { main: capacity ? `${main} · 定員 ${capacity}` : main, pending: review ? `うち確認待ち ${review} 名（席は確保されていません）` : null };
}
