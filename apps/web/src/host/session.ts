import { cancelBooking, guestLanguageLabel, refundNowYen, type SessionQuery } from "./bookings";
import { addDays, remainingJa, shortDateWithWeekdayJa, yen } from "./format";
import type { HostAttendance, HostBooking, HostBookingAnswer, HostBookingStatus, HostGuestLanguage } from "./types";

/*
 * この回 (#107, Epic #103)'s rules, apart from the screen so they can be tested: one session's
 * guests on the day and what to look out for, who came, and calling the session off. The host
 * writes to the guests one at a time through their threads (#106): there is no message to
 * everyone, and calling off sends only NIHO's cancellation email with a fixed reason.
 * NIHO decides these for real sessions; in mock mode the screen applies them itself.
 * TODO(#87): the guests and attendance and the session's cancellation (niho-app#19321), the
 * guest's phone (#19311) and food wishes (#19318) are not in the host contract yet.
 */

type QueryValue = string | readonly string[] | undefined;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

/** The session `?date=&start=&experience=&offer=` names (the first of each), or null when one is missing or malformed. */
export function sessionQueryOf(query: { date?: QueryValue; start?: QueryValue; experience?: QueryValue; offer?: QueryValue }): SessionQuery | null {
  const first = (value: QueryValue) => (typeof value === "string" ? value : (value?.[0] ?? ""));
  const session = { date: first(query.date), start: first(query.start), experience: first(query.experience), offer: first(query.offer) };
  return DATE.test(session.date) && TIME.test(session.start) && session.experience && session.offer ? session : null;
}

/** The session's bookings, whatever their state. */
export function sessionBookings<T extends Pick<HostBooking, "date" | "start" | "experienceId" | "offerId">>(bookings: readonly T[], session: SessionQuery): T[] {
  return bookings.filter((booking) => booking.date === session.date && booking.start === session.start && booking.experienceId === session.experience && booking.offerId === session.offer);
}

/** The screen's title: "10/22（木）Kamakura Community Dinner with Locals". */
export function sessionHeading(session: { date: string; title: string }): string {
  return `${shortDateWithWeekdayJa(session.date)}${session.title}`;
}

/** Where a session stands at `now`: 開始前, 開催中 (from its start) or 終了 (from its end). */
export type SessionPhase = "before" | "during" | "after";

export const SESSION_PHASE_LABELS: Record<SessionPhase, string> = { before: "開始前", during: "開催中", after: "終了" };

/** When the session starts and ends (YYYY-MM-DDTHH:MM in Japan); one that ends at or past midnight ends the next day. */
export function sessionSpan(session: { date: string; start: string; end: string }): { startAt: string; endAt: string } {
  return { startAt: `${session.date}T${session.start}`, endAt: `${session.end > session.start ? session.date : addDays(session.date, 1)}T${session.end}` };
}

export function sessionPhase(session: { date: string; start: string; end: string }, now: string): SessionPhase {
  const { startAt, endAt } = sessionSpan(session);
  if (now < startAt) return "before";
  return now < endAt ? "during" : "after";
}

/** The line under the times: "開始まであと 26 時間", "開催中（20:00 まで）" or "終了しました". */
export function sessionPhaseLine(session: { date: string; start: string; end: string }, now: string): string {
  const phase = sessionPhase(session, now);
  if (phase === "before") return `開始まで${remainingJa(sessionSpan(session).startAt, now)}`;
  return phase === "during" ? `開催中（${session.end} まで）` : "終了しました";
}

const seated = (status: HostBookingStatus) => status === "pending" || status === "confirmed";
const guestsOf = (bookings: readonly Pick<HostBooking, "guests">[]) => bookings.reduce((sum, booking) => sum + booking.guests, 0);

/** The guests: "参加 2 名 · 定員 8" counts the bookings (確定); the requests (承認待ち) follow apart, or null when there are none. */
export function sessionCountLines(bookings: readonly Pick<HostBooking, "status" | "guests">[], capacity: number | null): { main: string; pending: string | null } {
  const confirmed = guestsOf(bookings.filter((booking) => booking.status === "confirmed"));
  const pending = guestsOf(bookings.filter((booking) => booking.status === "pending"));
  return { main: capacity ? `参加 ${confirmed} 名 · 定員 ${capacity}` : `参加 ${confirmed} 名`, pending: pending ? `ほかに承認待ち ${pending} 名` : null };
}

/** Each word once, with how many times it comes, in the order first met. */
function tally(words: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts.entries()];
}

/**
 * 食べものの希望 of everyone who keeps a seat (承認待ち・確定, as the list's "4 / 8名" counts):
 * "ベジタリアン 1 名 · 甲殻類なし 1 名", or "" when no one has one.
 */
export function dietarySummary(bookings: readonly Pick<HostBooking, "status" | "dietary">[]): string {
  return tally(bookings.filter((booking) => seated(booking.status)).flatMap((booking) => booking.dietary))
    .map(([word, count]) => `${word} ${count} 名`)
    .join(" · ");
}

export const NO_DIETARY_TEXT = "食べものの希望はありません";

/** "大人 2・子ども 1" */
export function peopleShort(booking: Pick<HostBooking, "adults" | "children">): string {
  return `大人 ${booking.adults}${booking.children ? `・子ども ${booking.children}` : ""}`;
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["ja"], { type: "region" });
  } catch {
    return null;
  }
})();

/** "GB" → "イギリス"; a code without a Japanese name stays as it is. */
export function countryLabel(code: string): string {
  try {
    return regionNames?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** "イギリス · 英語": where the guest lives (when they said) and the language they booked in. */
export function guestOrigin(booking: Pick<HostBooking, "country" | "language">): string {
  return [booking.country ? countryLabel(booking.country) : null, guestLanguageLabel(booking.language)].filter(Boolean).join(" · ");
}

/** "+44 7700 900123" → "tel:+447700900123". */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

/** A tag of a guest's row: a food wish, or 支払い済み. */
export interface GuestTag {
  label: string;
  tone: "food" | "paid";
}

/** The row's tags: each food wish once ("ベジタリアン", or "ベジタリアン 2 名" for two), then 支払い済み for a booking paid and not refunded. */
export function guestTags(booking: Pick<HostBooking, "dietary" | "status" | "paidAt" | "refundedYen">): GuestTag[] {
  const food = tally(booking.dietary).map(([word, count]): GuestTag => ({ label: count > 1 ? `${word} ${count} 名` : word, tone: "food" }));
  const paid = booking.status === "confirmed" && booking.paidAt !== null && booking.refundedYen === 0;
  return paid ? [...food, { label: "支払い済み", tone: "paid" }] : food;
}

/** 申込メモ and the answers, for the row: what the guest wrote, without the empty ones. */
export function guestWords(booking: Pick<HostBooking, "note" | "answers">): { note: string; answers: readonly HostBookingAnswer[] } {
  return { note: booking.note.trim(), answers: booking.answers.filter((answer) => answer.answer.trim()) };
}

/**
 * 参加者 (確定, and this site's payments under review: the guest paid and may come, #285) and 承認待ち as the
 * screen opened. A booking this screen cancels (この回を中止) stays where it was, with its new state, so the host
 * still sees and can write to everyone.
 */
export interface SessionSections {
  participants: HostBooking[];
  requests: HostBooking[];
}

const PARTICIPANTS: ReadonlySet<HostBookingStatus> = new Set(["confirmed", "payment_review"]);
const REQUESTS: ReadonlySet<HostBookingStatus> = new Set(["pending"]);

export function sessionSections(opened: readonly Pick<HostBooking, "id" | "status">[], current: readonly HostBooking[]): SessionSections {
  const asNow = (statuses: ReadonlySet<HostBookingStatus>) => opened.filter((booking) => statuses.has(booking.status)).flatMap((booking) => current.filter((item) => item.id === booking.id));
  return { participants: asNow(PARTICIPANTS), requests: asNow(REQUESTS) };
}

// 出欠

export const ATTENDANCE_CHOICES: readonly { value: HostAttendance; label: string }[] = [
  { value: "attended", label: "来た" },
  { value: "no_show", label: "来なかった" },
];

export function attendanceLabel(value: HostAttendance | null): string {
  return ATTENDANCE_CHOICES.find((choice) => choice.value === value)?.label ?? "未記録";
}

/** Said in place of the buttons' use before the start. */
export const ATTENDANCE_LOCKED_TEXT = "開始後に付けられます";
/** Said under a guest marked 来なかった. */
export const NO_SHOW_NOTE = "お礼とレビュー依頼は届きません";

/** A booking (確定) of a session that has started; after its end too, so a mistake can be put right. */
export function canRecordAttendance(booking: Pick<HostBooking, "status">, phase: SessionPhase): boolean {
  return booking.status === "confirmed" && phase !== "before";
}

/** 来た / 来なかった (mock mode: on this screen only). Nothing changes before the start or for a booking that is not 確定. */
export function recordAttendance(booking: HostBooking, value: HostAttendance, phase: SessionPhase): HostBooking {
  if (!canRecordAttendance(booking, phase) || booking.attendance === value) return booking;
  return { ...booking, attendance: value };
}

/** What role=status says after a change: "Emma Larsson さん: 来た". */
export function attendanceNotice(booking: Pick<HostBooking, "guest">, value: HostAttendance): string {
  return `${booking.guest} さん: ${attendanceLabel(value)}`;
}

export interface AttendanceCounts {
  attended: number;
  noShow: number;
  unrecorded: number;
}

/** Bookings (確定) by their attendance. */
export function attendanceCounts(bookings: readonly Pick<HostBooking, "status" | "attendance">[]): AttendanceCounts {
  const confirmed = bookings.filter((booking) => booking.status === "confirmed");
  return {
    attended: confirmed.filter((booking) => booking.attendance === "attended").length,
    noShow: confirmed.filter((booking) => booking.attendance === "no_show").length,
    unrecorded: confirmed.filter((booking) => booking.attendance === null).length,
  };
}

/** "来た 1 件 · 来なかった 0 件 · 未記録 1 件" */
export function attendanceSummary(counts: AttendanceCounts): string {
  return `来た ${counts.attended} 件 · 来なかった ${counts.noShow} 件 · 未記録 ${counts.unrecorded} 件`;
}

// この回を中止

/** 中止の理由: the host picks one; NIHO adds its fixed words to the cancellation email (no free text). */
export type SessionCancelReason = "weather" | "illness" | "other";

export const SESSION_CANCEL_REASONS: readonly { value: SessionCancelReason; label: string }[] = [
  { value: "weather", label: "雨・荒天" },
  { value: "illness", label: "急病・けが" },
  { value: "other", label: "その他の事情" },
];

const SESSION_CANCEL_MESSAGES: Record<HostGuestLanguage, Record<SessionCancelReason, string>> = {
  en: {
    weather: "We’re very sorry, but this session has been called off because of the weather.",
    illness: "We’re very sorry, but this session has been called off because the host has suddenly fallen ill or been injured.",
    other: "We’re very sorry, but this session has been called off for reasons on the host’s side.",
  },
  ja: {
    weather: "申し訳ありませんが、天候のため、この回は中止になりました。",
    illness: "申し訳ありませんが、主催者の急病・けがのため、この回は中止になりました。",
    other: "申し訳ありませんが、主催者の都合により、この回は中止になりました。",
  },
};

/** The fixed words the cancellation email carries, in the language the guest booked in. */
export function sessionCancelMessage(language: HostGuestLanguage, reason: SessionCancelReason): string {
  return SESSION_CANCEL_MESSAGES[language][reason];
}

/** What 中止 cancels: the bookings (確定) and the requests (承認待ち). */
export function sessionCancelTargets<T extends Pick<HostBooking, "status">>(bookings: readonly T[]): T[] {
  return bookings.filter((booking) => seated(booking.status));
}

/** 中止 is offered before the start only, once, and when there is something to cancel. */
export function canCancelSession(bookings: readonly Pick<HostBooking, "status">[], phase: SessionPhase, cancelled: boolean): boolean {
  return phase === "before" && !cancelled && sessionCancelTargets(bookings).length > 0;
}

export interface SessionCancelPlan {
  confirmed: number;
  pending: number;
  /** What goes back to the bookings (確定) in full; a request was never charged, its card hold is released. */
  refundYen: number;
}

export function sessionCancelPlan(bookings: readonly Pick<HostBooking, "status" | "amountYen" | "refundedYen">[]): SessionCancelPlan {
  const confirmed = bookings.filter((booking) => booking.status === "confirmed");
  return {
    confirmed: confirmed.length,
    pending: bookings.filter((booking) => booking.status === "pending").length,
    refundYen: confirmed.reduce((sum, booking) => sum + refundNowYen(booking, "full"), 0),
  };
}

/** The dialog's summary: "確定 2 件・承認待ち 1 件を取り消し、¥150,000 を全額返金します。承認待ちはカードの仮押さえを解除します。" */
export function sessionCancelSummary(plan: SessionCancelPlan): string {
  const counts = [plan.confirmed ? `確定 ${plan.confirmed} 件` : null, plan.pending ? `承認待ち ${plan.pending} 件` : null].filter(Boolean).join("・");
  if (!plan.confirmed) return `${counts}を取り消し、カードの仮押さえを解除します。`;
  return `${counts}を取り消し、${yen(plan.refundYen)} を全額返金します。${plan.pending ? "承認待ちはカードの仮押さえを解除します。" : ""}`;
}

/** The dialog's button: "3 件を取り消して ¥150,000 を返金する", or "1 件を取り消す" when nothing is refunded. */
export function sessionCancelConfirmLabel(plan: SessionCancelPlan): string {
  const count = plan.confirmed + plan.pending;
  return plan.refundYen > 0 ? `${count} 件を取り消して ${yen(plan.refundYen)} を返金する` : `${count} 件を取り消す`;
}

/**
 * One booking of a called-off session, with the fixed reason in the guest's language: a booking
 * (確定) is cancelled as 予約 cancels one (cancelBooking: 全額, 運営者の都合); a request's card hold
 * is released and it is cancelled too, not declined (お断り is the host's answer to a request).
 */
export function cancelSessionBooking(booking: HostBooking, reason: SessionCancelReason, at: string): HostBooking {
  const message = sessionCancelMessage(booking.language, reason);
  if (booking.status === "pending") {
    return { ...booking, status: "cancelled", meetingGuide: null, cancelledAt: at, cancelReason: "host", cancelMessage: message, timeline: [...booking.timeline, { at, text: "取消 · 与信を取り消し" }] };
  }
  return cancelBooking(booking, { refund: "full", reason: "host", message }, at);
}

/** What happened to one booking: cancelled (refunded, or its card hold released), or not, and why. */
export type SessionCancelResult =
  | { bookingId: string; guest: string; ok: true; refundYen: number; released: boolean }
  | { bookingId: string; guest: string; ok: false; error: string };

/**
 * この回を中止: every booking and request of the session, one at a time. One that fails stays as
 * it was and does not stop the others; `failure` says why one failed (NIHO's answer; none fails
 * in mock mode). Run again on what it returned, it only tries what is still to cancel, so a
 * booking already cancelled is never refunded twice.
 */
export function cancelSession(
  bookings: readonly HostBooking[],
  reason: SessionCancelReason,
  at: string,
  failure: (booking: HostBooking) => string | null = () => null,
): { bookings: HostBooking[]; results: SessionCancelResult[] } {
  const results: SessionCancelResult[] = [];
  const next = bookings.map((booking) => {
    if (!seated(booking.status)) return booking;
    const error = failure(booking);
    if (error) {
      results.push({ bookingId: booking.id, guest: booking.guest, ok: false, error });
      return booking;
    }
    const after = cancelSessionBooking(booking, reason, at);
    results.push({ bookingId: booking.id, guest: booking.guest, ok: true, refundYen: after.refundedYen - booking.refundedYen, released: booking.status === "pending" });
    return after;
  });
  return { bookings: next, results };
}

/** The results so far: a later try replaces a booking's earlier result, which keeps its place. */
export function mergeCancelResults(previous: readonly SessionCancelResult[], latest: readonly SessionCancelResult[]): SessionCancelResult[] {
  const merged = previous.map((result) => latest.find((next) => next.bookingId === result.bookingId) ?? result);
  return [...merged, ...latest.filter((next) => !previous.some((result) => result.bookingId === next.bookingId))];
}

/** A result's line: "取り消して ¥60,000 を返金", "取り消してカードの仮押さえを解除", or the failure and its reason. */
export function cancelResultText(result: SessionCancelResult): string {
  if (!result.ok) return `取り消せませんでした: ${result.error}`;
  if (result.released) return "取り消してカードの仮押さえを解除";
  return result.refundYen > 0 ? `取り消して ${yen(result.refundYen)} を返金` : "取り消し（返金なし）";
}

/** What role=status says: "この回を中止しました。2 件を取り消し、¥60,000 を返金しました", and what failed. */
export function cancelOutcomeText(results: readonly SessionCancelResult[]): string {
  const done = results.filter((result) => result.ok);
  const refunded = done.reduce((sum, result) => sum + (result.ok ? result.refundYen : 0), 0);
  const failed = results.length - done.length;
  const parts = ["この回を中止しました"];
  if (done.length) parts.push(`${done.length} 件を取り消し${refunded > 0 ? `、${yen(refunded)} を返金しました` : "ました"}`);
  if (failed) parts.push(`${failed} 件${done.length ? "は" : "を"}取り消せませんでした`);
  return parts.join("。");
}
