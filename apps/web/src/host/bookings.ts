import { HOST_BOOKING_SESSION_PATH, HOST_BOOKINGS_PATH, withQuery } from "@/lib/host/routes";
import { dateWithWeekdayJa, monthDayJa, yen } from "./format";
import { BOOKING_STATUS, PAST_CONFIRMED_BOOKING, type StatusLabel } from "./status";
import type {
  HostBooking,
  HostBookingAnswer,
  HostBookingStatus,
  HostCancelReason,
  HostGuestLanguage,
  HostMeetingGuideCopy,
  HostOffer,
  HostRefundChoice,
  HostSiteBookingTerms,
} from "./types";

/*
 * The bookings screen's rules (#90), apart from the screen so they can be tested: what each
 * filter shows, how bookings group into sessions and count seats, what the host can do in
 * each state, how much a cancellation refunds and what each action changes. NIHO decides
 * these for real bookings; in mock mode the screen applies them itself. Messages to the guest
 * are the booking's thread in メッセージ (messages.ts, #106); one session's guests and attendance
 * are この回 (session.ts, #107).
 * TODO(#87): send the actions to the provider API and show the booking NIHO reads back.
 */

export const BOOKING_FILTERS = [
  { value: "upcoming", label: "これから" },
  { value: "pending", label: "承認待ち" },
  { value: "past", label: "過去" },
  { value: "cancelled", label: "取消済み" },
] as const;

export type BookingFilter = (typeof BOOKING_FILTERS)[number]["value"];

/** `?filter=`: これから unless it names another one. */
export function bookingFilterOf(value: string | null | undefined): BookingFilter {
  return BOOKING_FILTERS.find((filter) => filter.value === value)?.value ?? "upcoming";
}

/** Bookings that still lead to their session. A payment under review (this site's, #285) keeps no seat but is not over. */
const ONGOING: ReadonlySet<HostBookingStatus> = new Set(["pending", "confirmed", "refund_needed", "payment_review"]);
/** Bookings that keep seats on their session: the 4 of "4 / 8名". */
const SEATED: ReadonlySet<HostBookingStatus> = new Set(["pending", "confirmed"]);

/**
 * これから: what is still ahead. 承認待ち: the requests to answer. 取消済み: the cancelled
 * bookings. 過去: the rest, i.e. the sessions that have passed and the requests that ended
 * without a booking (お断り・期限切れ), whatever their day. Every booking is in exactly one
 * of これから, 過去 and 取消済み.
 */
export function matchesBookingFilter(booking: Pick<HostBooking, "status" | "date">, filter: BookingFilter, today: string): boolean {
  const ahead = ONGOING.has(booking.status) && booking.date >= today;
  if (filter === "pending") return booking.status === "pending";
  if (filter === "cancelled") return booking.status === "cancelled";
  if (filter === "past") return booking.status !== "cancelled" && !ahead;
  return ahead;
}

/** What the bookings screen needs of an experience: its title and its offers' capacity and length. */
export interface BookingExperience {
  id: string;
  title: string;
  offers: readonly Pick<HostOffer, "id" | "capacity" | "durationMinutes">[];
}

/** One session: an offer of an experience on one day at one time. */
export interface BookingSession {
  key: string;
  /** YYYY-MM-DD and HH:MM in Japan. */
  date: string;
  start: string;
  /** HH:MM in Japan, as its bookings have it. */
  end: string;
  experienceId: string;
  offerId: string;
  /** The experience's title; empty when it is not among the provider's experiences. */
  title: string;
  capacity: number | null;
  durationMinutes: number | null;
  /** The guests of the bookings that keep seats (承認待ち・確定), and how many such bookings. */
  guests: number;
  count: number;
}

/** Sorts by date, then start, then experience and offer. */
export function sessionKey(booking: Pick<HostBooking, "date" | "start" | "experienceId" | "offerId">): string {
  return `${booking.date}T${booking.start}/${booking.experienceId}/${booking.offerId}`;
}

const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Every session that has a booking, in date and time order, with the seats its 承認待ち and 確定 bookings keep. */
export function bookingSessions(bookings: readonly HostBooking[], experiences: readonly BookingExperience[]): BookingSession[] {
  const sessions = new Map<string, BookingSession>();
  for (const booking of bookings) {
    const key = sessionKey(booking);
    let session = sessions.get(key);
    if (!session) {
      const experience = experiences.find((item) => item.id === booking.experienceId);
      const offer = experience?.offers.find((item) => item.id === booking.offerId);
      session = {
        key,
        date: booking.date,
        start: booking.start,
        end: booking.end,
        experienceId: booking.experienceId,
        offerId: booking.offerId,
        title: experience?.title ?? "",
        capacity: offer?.capacity ?? null,
        durationMinutes: offer?.durationMinutes ?? null,
        guests: 0,
        count: 0,
      };
      sessions.set(key, session);
    }
    if (SEATED.has(booking.status)) {
      session.guests += booking.guests;
      session.count += 1;
    }
  }
  return [...sessions.values()].sort(byKey);
}

/** "4 / 8名", or "4名" when the offer has no capacity. */
export function seatsLabel(session: Pick<BookingSession, "guests" | "capacity">): string {
  return session.capacity ? `${session.guests} / ${session.capacity}名` : `${session.guests}名`;
}

/** A heading of the list and the bookings under it. The heading opens the session (この回, #107). */
export interface BookingGroup extends SessionQuery {
  key: string;
  /** "10月22日（木）18:00" */
  label: string;
  title: string;
  /** "4 / 8名": every 承認待ち and 確定 booking of the session, whatever the filter shows. */
  seats: string;
  bookings: HostBooking[];
}

export interface BookingListQuery {
  filter: BookingFilter;
  /** `?experience=`; null shows every experience. */
  experienceId: string | null;
}

/**
 * The list: the bookings the filter and the experience select let through, under one heading
 * per session. これから and 承認待ち start from the nearest day, 過去 and 取消済み from the latest.
 */
export function bookingGroups(bookings: readonly HostBooking[], experiences: readonly BookingExperience[], query: BookingListQuery, today: string): BookingGroup[] {
  const sessions = new Map(bookingSessions(bookings, experiences).map((session) => [session.key, session]));
  const groups = new Map<string, BookingGroup>();
  for (const booking of bookings) {
    if (query.experienceId && booking.experienceId !== query.experienceId) continue;
    if (!matchesBookingFilter(booking, query.filter, today)) continue;
    const key = sessionKey(booking);
    let group = groups.get(key);
    if (!group) {
      const session = sessions.get(key);
      group = {
        key,
        ...sessionOfBooking(booking),
        label: `${dateWithWeekdayJa(booking.date)}${booking.start}`,
        title: session?.title ?? "",
        seats: session ? seatsLabel(session) : "",
        bookings: [],
      };
      groups.set(key, group);
    }
    group.bookings.push(booking);
  }
  const latestFirst = query.filter === "past" || query.filter === "cancelled";
  return [...groups.values()].sort((a, b) => (latestFirst ? byKey(b, a) : byKey(a, b)));
}

export interface BookingActions {
  approve: boolean;
  decline: boolean;
  cancel: boolean;
  message: boolean;
}

/**
 * 承認・お断り: requests only. 取消（と返金）: bookings (確定・要返金). メッセージ (a thread
 * to start, #106): everyone who booked, except requests that ended without a booking
 * (お断り・期限切れ).
 */
export function bookingActions(status: HostBookingStatus): BookingActions {
  return {
    approve: status === "pending",
    decline: status === "pending",
    cancel: status === "confirmed" || status === "refund_needed",
    message: status !== "declined" && status !== "expired",
  };
}

export const REFUND_CHOICES: readonly { value: HostRefundChoice; label: string }[] = [
  { value: "full", label: "全額" },
  { value: "half", label: "半額" },
  { value: "none", label: "返金なし" },
];

/** A traveler's own cancellation (要返金) is refunded in full; for the others the host chooses. */
export function refundChoicesFor(status: HostBookingStatus): readonly HostRefundChoice[] {
  return status === "refund_needed" ? ["full"] : ["full", "half", "none"];
}

/** What the guest has back in all after the refund: the whole payment, half of it (rounded down) or nothing. */
export function refundTargetYen(amountYen: number, choice: HostRefundChoice): number {
  if (choice === "full") return amountYen;
  if (choice === "half") return Math.floor(amountYen / 2);
  return 0;
}

/** 今回の返金: up to that, less what was refunded before. */
export function refundNowYen(booking: Pick<HostBooking, "amountYen" | "refundedYen">, choice: HostRefundChoice): number {
  return Math.max(0, refundTargetYen(booking.amountYen, choice) - booking.refundedYen);
}

/** The cancel dialog's button: "¥60,000 を返金して取り消す", or "予約を取り消す" when nothing goes back. */
export function cancelConfirmLabel(refundYen: number): string {
  return refundYen > 0 ? `${yen(refundYen)} を返金して取り消す` : "予約を取り消す";
}

export const CANCEL_REASONS: readonly { value: HostCancelReason; label: string }[] = [
  { value: "host", label: "運営者の都合" },
  { value: "guest", label: "旅行者からの依頼" },
  { value: "other", label: "その他" },
];

export function cancelReasonLabel(reason: HostCancelReason): string {
  return CANCEL_REASONS.find((item) => item.value === reason)?.label ?? "";
}

/** The reason the cancel dialog starts with: a traveler's own request is theirs; for the others the host chooses one. */
export function defaultCancelReason(status: HostBookingStatus): HostCancelReason | null {
  return status === "refund_needed" ? "guest" : null;
}

const CANCEL_MESSAGES: Record<HostGuestLanguage, { host: string; guest: string }> = {
  en: {
    host: "We’re very sorry, but we have to cancel your booking: we are unable to host on this date.",
    guest: "As you asked, we have cancelled your booking. The full amount will go back to your card.",
  },
  ja: {
    host: "誠に申し訳ありませんが、この日は開催できなくなったため、ご予約を取り消します。",
    guest: "ご依頼のとおり、ご予約を取り消しました。お支払いの全額をカードへ返金します。",
  },
};

/** 旅行者へのメッセージ to start from, in the language the guest booked in. */
export function defaultCancelMessage(booking: Pick<HostBooking, "status" | "language">): string {
  const messages = CANCEL_MESSAGES[booking.language];
  return booking.status === "refund_needed" ? messages.guest : messages.host;
}

/** Lengths the forms accept (NIHO's booking messages; #87's contract replaces them). `body` is a message of a thread. */
export const BOOKING_TEXT_LIMITS = { cancelMessage: 2000, body: 4000 } as const;

/** 承認: the card is charged and the booking confirmed; NIHO sends the meeting guide with the confirmation. */
export function approveBooking(booking: HostBooking, at: string): HostBooking {
  if (!bookingActions(booking.status).approve) return booking;
  return {
    ...booking,
    status: "confirmed",
    paidAt: at,
    meetingGuide: booking.meetingGuide ? { ...booking.meetingGuide, sentAt: at } : null,
    timeline: [...booking.timeline, { at, text: "承認 · 確定" }, { at, text: "支払い" }],
  };
}

/** お断り: the card hold is released and the seats free up. */
export function declineBooking(booking: HostBooking, at: string): HostBooking {
  if (!bookingActions(booking.status).decline) return booking;
  return { ...booking, status: "declined", meetingGuide: null, timeline: [...booking.timeline, { at, text: "お断り · 与信を取り消し" }] };
}

export interface BookingCancellation {
  refund: HostRefundChoice;
  reason: HostCancelReason;
  /** 旅行者へのメッセージ. */
  message: string;
}

/** 取消: the refund chosen (in full for a traveler's own request), the reason, and what the guest is told. */
export function cancelBooking(booking: HostBooking, cancellation: BookingCancellation, at: string): HostBooking {
  if (!bookingActions(booking.status).cancel) return booking;
  const choice = refundChoicesFor(booking.status).includes(cancellation.refund) ? cancellation.refund : "full";
  const refund = refundNowYen(booking, choice);
  return {
    ...booking,
    status: "cancelled",
    cancelledAt: at,
    cancelReason: cancellation.reason,
    cancelMessage: cancellation.message.trim(),
    refundedYen: booking.refundedYen + refund,
    timeline: [...booking.timeline, { at, text: refund > 0 ? `取消 · 返金 ${yen(refund)}` : "取消 · 返金なし" }],
  };
}

/** When an action happens: the screen's day (mock mode keeps its own) at the current time in Japan. */
export function actionTime(today: string, now: number): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(now));
  return `${today}T${time}`;
}

/** "10月20日（火）14:02" */
export function dateTimeJa(at: string): string {
  const [date = "", time = ""] = at.split("T");
  return `${dateWithWeekdayJa(date)}${time}`;
}

/** 時系列: "10/20 14:02". */
export function shortDateTime(at: string): string {
  const [date = "", time = ""] = at.split("T");
  const [, month = "", day = ""] = date.split("-");
  return `${Number(month)}/${Number(day)} ${time}`;
}

/** A request's deadline: "今日 22:00", or its day and time when that is not today. */
export function respondByLabel(respondBy: string, today: string): string {
  const [date = "", time = ""] = respondBy.split("T");
  return date === today ? `今日 ${time}` : `${dateWithWeekdayJa(date)}${time}`;
}

/** The pill: a confirmed booking whose day has passed keeps 確定, in the quiet tone. */
export function bookingStatusLabel(booking: Pick<HostBooking, "status" | "date">, today: string): StatusLabel {
  return booking.status === "confirmed" && booking.date < today ? PAST_CONFIRMED_BOOKING : BOOKING_STATUS[booking.status];
}

/** A row's second line: "2名 · ¥60,000 · 体験サイト". */
export function bookingRowDetail(booking: Pick<HostBooking, "guests" | "amountYen" | "channel">): string {
  return [`${booking.guests}名`, yen(booking.amountYen), booking.channel].join(" · ");
}

/** What the approval and cancel dialogs show of a booking (ホーム approves from its row too). */
export type BookingDialogSubject = Pick<HostBooking, "guest" | "date" | "start" | "end" | "offer" | "amountYen">;

/** Under the guest's name: "10月22日（木）18:00–20:00 · Dinner". */
export function bookingWhen(booking: Pick<HostBooking, "date" | "start" | "end" | "offer">): string {
  return `${dateWithWeekdayJa(booking.date)}${booking.start}–${booking.end} · ${booking.offer}`;
}

/** "3名（大人 2・子ども 1）" */
export function peopleLabel(booking: Pick<HostBooking, "guests" | "adults" | "children">): string {
  return `${booking.guests}名（大人 ${booking.adults}${booking.children ? `・子ども ${booking.children}` : ""}）`;
}

/** 内訳: "大人 ¥30,000 × 2 ＋ 子ども ¥12,000 × 1". */
export function priceBreakdown(booking: Pick<HostBooking, "adults" | "children" | "adultPriceYen" | "childPriceYen">): string {
  const parts = [`大人 ${yen(booking.adultPriceYen)} × ${booking.adults}`];
  if (booking.children && booking.childPriceYen !== null) parts.push(`子ども ${yen(booking.childPriceYen)} × ${booking.children}`);
  return parts.join(" ＋ ");
}

const LANGUAGE_LABELS: Record<HostGuestLanguage, string> = { en: "英語", ja: "日本語" };

/** The language the guest booked in, in Japanese: "英語". */
export function guestLanguageLabel(language: HostGuestLanguage): string {
  return LANGUAGE_LABELS[language];
}

/** 集合案内: "v2 · 10月18日に送付", or "v2 · 承認後に送付" while the booking is not confirmed yet. */
export function meetingGuideLabel(guide: HostMeetingGuideCopy): string {
  return `v${guide.version} · ${guide.sentAt ? `${monthDayJa(guide.sentAt.slice(0, 10))}に送付` : "承認後に送付"}`;
}

/** One row of 申込内容 or 状態: a value, or the answers to the offer's questions. */
export type BookingRow = { label: string; value: string; multiline?: boolean } | { label: string; answers: readonly HostBookingAnswer[] };

/** The rows that have something to show (`condition && row` leaves out the others). */
function rows(items: readonly (BookingRow | false | "" | null | undefined)[]): BookingRow[] {
  return items.filter((item): item is BookingRow => Boolean(item));
}

const CANCELLATION_POLICY_LABELS: Record<NonNullable<HostSiteBookingTerms["cancellationPolicy"]>, string> = {
  FREE_UNTIL_24H: "24時間前まで無料",
  FREE_UNTIL_48H: "48時間前まで無料",
  NONE: "無料取消なし",
};

/** 手数料 of a booking made on this site: "¥1,000（10%・サポートOFF）". */
export function siteFeeLabel(fee: NonNullable<HostSiteBookingTerms["fee"]>): string {
  return `${yen(fee.amountYen)}（${fee.percent}%・サポート${fee.supportEnabled ? "ON" : "OFF"}）`;
}

/**
 * 申込内容: what the guest booked and wrote (never their email: NIHO keeps it). Rows with nothing to show are left out.
 * A booking made on this site (#285) adds NIHO's fee, what the host receives and the cancellation policy it was
 * made under; its offer is the experience itself, so 商品 is left out.
 */
export function bookingRequestRows(booking: HostBooking, experienceTitle: string): BookingRow[] {
  const site = booking.site;
  return rows([
    Boolean(experienceTitle) && { label: "体験", value: experienceTitle },
    !site && { label: "商品", value: booking.offer },
    { label: "人数", value: peopleLabel(booking) },
    { label: "金額", value: yen(booking.amountYen) },
    { label: "内訳", value: priceBreakdown(booking) },
    site?.fee && { label: "手数料", value: siteFeeLabel(site.fee) },
    site && { label: "受取額", value: yen(site.payoutYen) },
    { label: "言語", value: guestLanguageLabel(booking.language) },
    { label: "申込経路", value: booking.channel },
    site?.cancellationPolicy && { label: "取消条件", value: CANCELLATION_POLICY_LABELS[site.cancellationPolicy] },
    Boolean(booking.note.trim()) && { label: "申込メモ", value: booking.note, multiline: true },
    booking.answers.length > 0 && { label: "回答", answers: booking.answers },
    booking.meetingGuide && { label: "集合案内", value: meetingGuideLabel(booking.meetingGuide) },
  ]);
}

/**
 * 状態: where the booking stands and what happened to the money. Rows for what has not happened are left out.
 * This site's bookings (#285) record no refund until slice 7, so they show no 累計返金.
 */
export function bookingStateRows(booking: HostBooking): BookingRow[] {
  const settled = !booking.site && (booking.status === "cancelled" || booking.status === "refund_needed" || booking.refundedYen > 0);
  return rows([
    { label: "予約", value: BOOKING_STATUS[booking.status].label },
    booking.authorizedAt && { label: "与信", value: dateTimeJa(booking.authorizedAt) },
    booking.paidAt && { label: "支払い", value: dateTimeJa(booking.paidAt) },
    booking.status === "pending" && booking.respondBy && { label: "承認期限", value: dateTimeJa(booking.respondBy) },
    booking.cancelRequestedAt && { label: "取消依頼", value: dateTimeJa(booking.cancelRequestedAt) },
    booking.cancelledAt && { label: "取消", value: dateTimeJa(booking.cancelledAt) },
    booking.cancelReason && { label: "取消理由", value: cancelReasonLabel(booking.cancelReason) },
    booking.cancelMessage && { label: "取消連絡", value: booking.cancelMessage, multiline: true },
    settled && { label: "累計返金", value: yen(booking.refundedYen) },
  ]);
}

export interface BookingsQuery {
  providerId?: string | null;
  /** `site`: the bookings made on this site, where NIHO's list is the screen's own (#285 slice 8). */
  source?: "site" | null;
  filter?: BookingFilter;
  experience?: string | null;
  booking?: string | null;
}

/** The bookings screen's address: `?providerId=`, the source, the filter (これから, the default, stays out), the experience and the booking. */
export function bookingsHref({ providerId, source, filter, experience, booking }: BookingsQuery = {}): string {
  return withQuery(HOST_BOOKINGS_PATH, { providerId, source, filter: filter === "upcoming" ? null : filter, experience, booking });
}

/** One session as its screen's address names it (この回, #107): the day, the start, the experience and the offer. */
export interface SessionQuery {
  /** YYYY-MM-DD and HH:MM in Japan. */
  date: string;
  start: string;
  /** The experience's and the offer's ids. */
  experience: string;
  offer: string;
}

/** この回's address, under 予約: `?providerId=`, then the session. */
export function sessionHref({ providerId, ...session }: SessionQuery & { providerId?: string | null }): string {
  return withQuery(HOST_BOOKING_SESSION_PATH, { providerId, date: session.date, start: session.start, experience: session.experience, offer: session.offer });
}

/** The session a booking belongs to, as この回's address names it. */
export function sessionOfBooking(booking: Pick<HostBooking, "date" | "start" | "experienceId" | "offerId">): SessionQuery {
  return { date: booking.date, start: booking.start, experience: booking.experienceId, offer: booking.offerId };
}
