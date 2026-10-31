import { HOST_EXPERIENCES_PATH } from "@/lib/host/routes";
import { bookingSessions, bookingsHref, seatsLabel, sessionHref, type BookingDialogSubject, type BookingExperience, type BookingSession, type SessionQuery } from "./bookings";
import { addDays, agoJa, dateWithWeekdayJa, dayOfMonth, durationJa, listJa, missingLine, monthDayJa, remainingJa, shortDateWithWeekdayJa, todayInJapan, weekdayJa, yen } from "./format";
import { guestMessageView, lastGuestMessage, messagesHref, quoteJa, sortThreads, threadKind, waitingSince } from "./messages";
import { HOME_REVIEW_LIMIT, reviewerLabel, reviewReplyStage, reviewsHref, reviewsToAttend } from "./reviews";
import { salesSummary, type SalesFigure, type SalesMonth } from "./sales";
import { attendanceCounts, dietarySummary, SESSION_PHASE_LABELS, sessionBookings, sessionPhase } from "./session";
import { BOOKING_STATUS, LISTING_STATUS, REVIEW_STATUS, REVIEW_UNREPLIED, THREAD_WAITING, type StatusLabel } from "./status";
import type { HostBooking, HostExperience, HostReview, HostSale, HostThread } from "./types";

/** A request ホーム approves from its row: 承認する asks in the bookings screen's dialog first (#90). */
export interface HomeApproval {
  bookingId: string;
  booking: BookingDialogSubject;
}

/** A row of 次にすること. `href` may carry the target screen's own query (and a hash); the page adds `?providerId=`. */
export interface HomeTodo {
  key: string;
  /** null for the line after the reviews (ほかに N 件のレビュー). */
  status: StatusLabel | null;
  /** Next to the pill: the time left to answer a request (warn), or which kind of message waits. */
  aside: { text: string; tone: "warn" | "muted" } | null;
  /** A review's stars (1–5), drawn before the title. */
  rating?: number;
  title: string;
  /** Empty when there is nothing to add. */
  detail: string;
  /** 承認する, for a request. */
  approval: HomeApproval | null;
  action: { label: string; href: string; primary: boolean } | null;
}

/** A row of the sessions: one date, start time and experience. */
export interface HomeUpcoming {
  key: string;
  /** この回 (#107): the session's own screen. The page adds `?providerId=`. */
  href: string;
  /** "10月22日（木）" for screen readers; the row shows weekday and day. */
  dateLabel: string;
  weekday: string;
  day: number;
  title: string;
  detail: string;
  /** "4 / 8名" */
  seats: string;
  /** "2件" */
  bookings: string;
  /** 食べものの希望 of the guests: "ベジタリアン 1 名"; empty when no one has one. */
  dietary: string;
  /** Today's rows only: 開始前 / 開催中 / 終了, and "終了 · 出欠が未記録" (warn) while attendance is still to record. */
  phase: { text: string; tone: "warn" | "muted" } | null;
  /** Where the row's bookings come from when it is said: "このサイトの予約" beside NIHO's bookings (#285 slice 8b). */
  source?: string;
}

/** ホーム's month card: its numbers, and whose they are when that needs saying. */
export interface HomeMonth {
  label: string;
  figures: SalesFigure[];
  /** "このサイトで受けた予約の分" for this site's ledger (#91); null for the preview's. */
  note: string | null;
}

export function experiencePath(id: string): string {
  return `${HOST_EXPERIENCES_PATH}/${encodeURIComponent(id)}`;
}

/** Requests with a deadline first, the nearest first; then the others by their day. */
function byDeadline(a: HostBooking, b: HostBooking): number {
  if (Boolean(a.respondBy) !== Boolean(b.respondBy)) return a.respondBy ? -1 : 1;
  return (a.respondBy ?? "").localeCompare(b.respondBy ?? "") || `${a.date}T${a.start}`.localeCompare(`${b.date}T${b.start}`) || a.id.localeCompare(b.id);
}

/**
 * The requests waiting for an answer, one row each with the time left: "Lucas さん · 10/22（木）
 * 18:00 · Dinner · 2名 · ¥60,000". 承認する approves it here; 詳しく見る opens the booking.
 */
function requestTodos(experiences: readonly HostExperience[], bookings: readonly HostBooking[], today: string, now: string): HomeTodo[] {
  return bookings
    .filter((booking) => booking.status === "pending" && booking.date >= today)
    .sort(byDeadline)
    .map((booking) => ({
      key: `booking-${booking.id}`,
      status: BOOKING_STATUS.pending,
      aside: booking.respondBy ? { text: remainingJa(booking.respondBy, now), tone: "warn" } : null,
      title: [
        `${booking.guest} さん`,
        `${shortDateWithWeekdayJa(booking.date)}${booking.start}`,
        experiences.find((experience) => experience.id === booking.experienceId)?.title ?? booking.offer,
        `${booking.guests}名`,
        yen(booking.amountYen),
      ].join(" · "),
      detail: booking.respondBy ? "期限を過ぎると自動でお断りになります" : "",
      approval: { bookingId: booking.id, booking: { guest: booking.guest, date: booking.date, start: booking.start, end: booking.end, offer: booking.offer, amountYen: booking.amountYen } },
      action: { label: "詳しく見る", href: bookingsHref({ booking: booking.id }), primary: false },
    }));
}

/**
 * The threads waiting for the host (#106), the longest wait first: the guest's latest words in
 * Japanese (the original when NIHO could not translate them), who and how long ago.
 */
export function threadTodos(threads: readonly HostThread[], now: string): HomeTodo[] {
  return sortThreads(threads).flatMap((thread) => {
    const message = waitingSince(thread) ? lastGuestMessage(thread) : null;
    if (!message) return [];
    const view = guestMessageView(message);
    return [
      {
        key: `thread-${thread.id}`,
        status: THREAD_WAITING,
        aside: { text: threadKind(thread), tone: "muted" },
        title: quoteJa(view.text),
        detail: [`${thread.guest} さん`, agoJa(message.at, now), ...(view.note ? [view.note] : [])].join(" · "),
        approval: null,
        action: { label: "返信する", href: messagesHref({ thread: thread.id }), primary: true },
      },
    ];
  });
}

/**
 * The guests' reviews (#108): the published ones without a reply, the newest first (読んで返信する),
 * then the ones NIHO is still checking (読む), `limit` of them and one line for the rest. Each
 * opens on its own review: "★★★★★ 「…」", who and the experience.
 */
export function reviewTodos(experiences: readonly Pick<HostExperience, "id" | "title">[], reviews: readonly HostReview[], limit = HOME_REVIEW_LIMIT): HomeTodo[] {
  const attend = reviewsToAttend(reviews);
  const rows: HomeTodo[] = attend.slice(0, limit).map((review) => {
    const waiting = reviewReplyStage(review) === "waiting";
    return {
      key: `guest-review-${review.id}`,
      status: waiting ? REVIEW_STATUS.pending : REVIEW_UNREPLIED,
      aside: { text: "レビュー", tone: "muted" },
      rating: review.rating,
      title: quoteJa(guestMessageView(review.body).text),
      detail: [reviewerLabel(review), experiences.find((experience) => experience.id === review.experienceId)?.title ?? null].filter(Boolean).join(" · "),
      approval: null,
      action: { label: waiting ? "読む" : "読んで返信する", href: reviewsHref({ review: review.id }), primary: false },
    };
  });
  const rest = attend.length - rows.length;
  if (rest > 0) {
    rows.push({ key: "guest-reviews-more", status: null, aside: null, title: `ほかに ${rest} 件のレビュー`, detail: "", approval: null, action: { label: "レビューを見る", href: reviewsHref(), primary: false } });
  }
  return rows;
}

/** A draft to finish (編集する opens the editor): what it still needs, or empty when there is nothing to add. */
function draftTodo(id: string, title: string, detail: string): HomeTodo {
  return {
    key: `draft-${id}`,
    status: LISTING_STATUS.draft,
    aside: null,
    title: `${title} の原稿を仕上げる`,
    detail,
    approval: null,
    action: { label: "編集する", href: experiencePath(id), primary: false },
  };
}

/** A listing NIHO is checking for the experience site, and the day it was asked for (YYYY-MM-DD in Japan) when known. */
function listingReviewTodo(id: string, title: string, requestedOn: string | null): HomeTodo {
  return {
    key: `review-${id}`,
    status: LISTING_STATUS.review,
    aside: null,
    title,
    detail: [requestedOn ? `${monthDayJa(requestedOn)}に申請` : null, "NIHO が確認中"].filter(Boolean).join(" · "),
    approval: null,
    action: null,
  };
}

/**
 * 次にすること, the nearest deadline first: the requests (each has one), the threads waiting
 * for an answer, the reviews to answer or read, then drafts to finish and listings under review.
 */
export function homeTodos(
  experiences: readonly HostExperience[],
  bookings: readonly HostBooking[],
  threads: readonly HostThread[],
  today: string,
  now: string,
  reviews: readonly HostReview[] = [],
): HomeTodo[] {
  const drafts = experiences
    .filter((experience) => experience.status === "draft")
    .map((experience) => draftTodo(experience.id, experience.title, experience.missing.length ? missingLine(experience.missing, listJa) : "掲載を申請できます"));
  const listingReviews = experiences
    .filter((experience) => experience.status === "review")
    .map((experience) => listingReviewTodo(experience.id, experience.title, experience.requestedOn || null));
  return [...requestTodos(experiences, bookings, today, now), ...threadTodos(threads, now), ...reviewTodos(experiences, reviews), ...drafts, ...listingReviews];
}

/** One of NIHO's experience pages as 次にすること reads it (provider operations on, #89). */
export interface HomePage {
  id: string;
  title: string;
  status: "DRAFT" | "PUBLISHED" | "UNPUBLISHED";
}

/** A published page's listing on the experience site as NIHO keeps it; only one being checked (REQUESTED) is a todo. */
export interface HomePageListing {
  status: "REQUESTED" | "ACTIVE" | "PAUSED" | "WITHDRAWN";
  /** When the host asked for it (ISO 8601). */
  consentedAt: string | null;
}

/**
 * NIHO's pages as 次にすること, in the rows the preview has for its drafts and listings under review: the drafts to
 * finish (NIHO's list does not say what is missing), then the published pages NIHO is checking for the experience site.
 * `listings` holds the listings read, by page id.
 */
export function pageTodos(pages: readonly HomePage[], listings: Readonly<Record<string, HomePageListing | null>>): HomeTodo[] {
  const drafts = pages.filter((page) => page.status === "DRAFT").map((page) => draftTodo(page.id, page.title || "題名なし", ""));
  const listingReviews = pages.flatMap((page) => {
    const listing = page.status === "PUBLISHED" ? listings[page.id] : null;
    if (listing?.status !== "REQUESTED") return [];
    return [listingReviewTodo(page.id, page.title || "題名なし", listing.consentedAt ? todayInJapan(Date.parse(listing.consentedAt)) : null)];
  });
  return [...drafts, ...listingReviews];
}

/** What 次にすること reads in http mode (home-server.ts); a source that is closed or could not be read is empty. */
export interface LiveHomeSources {
  threads: readonly HostThread[];
  reviews: readonly HostReview[];
  /** The reviewed experiences' titles, by the experience DB's product id. */
  reviewExperiences: readonly Pick<HostExperience, "id" | "title">[];
  pages: readonly HomePage[];
  listings: Readonly<Record<string, HomePageListing | null>>;
  /** YYYY-MM-DDTHH:MM in Japan: what "2 時間前" counts from. */
  now: string;
}

/**
 * 次にすること in http mode, in the preview's order after its requests (this site's bookings are confirmed at once): the
 * threads waiting for an answer, the reviews to answer, the drafts to finish, the listings under review.
 */
export function liveHomeTodos(sources: LiveHomeSources): HomeTodo[] {
  return [...threadTodos(sources.threads, sources.now), ...reviewTodos(sources.reviewExperiences, sources.reviews), ...pageTodos(sources.pages, sources.listings)];
}

/** Where 次にすること reads from in http mode, each of which may fail on its own. */
export type HomeTodoSource = "messages" | "reviews" | "experiences";

const HOME_TODO_SOURCE_LABEL: Record<HomeTodoSource, string> = { messages: "メッセージ", reviews: "レビュー", experiences: "NIHO の体験" };

/** ホーム's line when sources could not be read: "メッセージとレビューを読み込めませんでした。…". */
export function homeTodosFailedText(failed: readonly HomeTodoSource[]): string {
  const names = failed.map((source) => HOME_TODO_SOURCE_LABEL[source]);
  return `${listJa(names)}を読み込めませんでした。次にすることに出ていないものがあるかもしれません。`;
}

/** The app icon's count (#177 P2): requests waiting for approval and threads waiting for an answer. */
export function homeBadgeCount(todos: readonly HomeTodo[]): number {
  return todos.filter((todo) => todo.key.startsWith("booking-") || todo.key.startsWith("thread-")).length;
}

/** Today's word for a session: where it stands, and whether attendance is still to record once it is over. */
function todayPhase(session: BookingSession, own: readonly HostBooking[], now: string): HomeUpcoming["phase"] {
  const phase = sessionPhase(session, now);
  if (phase === "after" && attendanceCounts(own).unrecorded > 0) return { text: `${SESSION_PHASE_LABELS.after} · 出欠が未記録`, tone: "warn" };
  return { text: SESSION_PHASE_LABELS[phase], tone: "muted" };
}

function upcomingRow(session: BookingSession, bookings: readonly HostBooking[], now: string | null): HomeUpcoming {
  const query: SessionQuery = { date: session.date, start: session.start, experience: session.experienceId, offer: session.offerId };
  const own = sessionBookings(bookings, query);
  return {
    key: session.key,
    href: sessionHref(query),
    dateLabel: dateWithWeekdayJa(session.date),
    weekday: weekdayJa(session.date),
    day: dayOfMonth(session.date),
    title: session.title,
    detail: [`${session.start} 開始`, session.durationMinutes ? durationJa(session.durationMinutes) : null].filter(Boolean).join(" · "),
    seats: seatsLabel(session),
    bookings: `${session.count}件`,
    dietary: dietarySummary(own),
    phase: now ? todayPhase(session, own, now) : null,
  };
}

/** The sessions ホーム shows, split by day. */
export interface HomeSessions {
  /** 今日の開催: all of today's, before, during and after them: the host opens them on the day to record who came (#107). */
  today: HomeUpcoming[];
  /** 明日の開催. */
  tomorrow: HomeUpcoming[];
  /** これからの開催: from the day after tomorrow, `limit` of them. */
  later: HomeUpcoming[];
}

/**
 * The sessions (an offer on a day at a time) with guests, counting the 承認待ち and 確定 bookings
 * as the bookings list does: today's (also once started or over, with where each stands),
 * tomorrow's, and the next ones after that. A day shown above is never repeated below.
 */
export function homeSessions(experiences: readonly BookingExperience[], bookings: readonly HostBooking[], now: string, limit = 3): HomeSessions {
  const [today = ""] = now.split("T");
  const tomorrow = addDays(today, 1);
  const sessions = bookingSessions(bookings, experiences).filter((session) => session.count > 0);
  return {
    today: sessions.filter((session) => session.date === today).map((session) => upcomingRow(session, bookings, now)),
    tomorrow: sessions.filter((session) => session.date === tomorrow).map((session) => upcomingRow(session, bookings, null)),
    later: sessions
      .filter((session) => session.date > tomorrow)
      .slice(0, limit)
      .map((session) => upcomingRow(session, bookings, null)),
  };
}

/** The month card: 売上, 返金 and 入金予定 as 売上 (#91) sums them (payouts are not sales), and how many bookings were charged. */
export function homeMonth(sales: readonly HostSale[], month: SalesMonth): HomeMonth {
  const summary = salesSummary(sales, month);
  return {
    label: `${month.month}月`,
    figures: [
      { label: "売上", value: yen(summary.salesYen) },
      { label: "返金", value: yen(-summary.refundsYen) },
      { label: "入金予定", value: yen(summary.expectedYen) },
      { label: "確定した予約", value: `${summary.bookings}件` },
    ],
    note: null,
  };
}
