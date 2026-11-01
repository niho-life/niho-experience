import type { HostOtaBooking } from "@niho-experience/experience-store";
import { actionTime, bookingStatusLabel, type BookingExperience, type SessionQuery } from "./bookings";
import type { HostSessionView } from "./console-data";
import { shortDateWithWeekdayJa, todayInJapan } from "./format";
import type { HomeTodo } from "./home";
import { otaSiteLabel } from "./ota-sites";
import type { StatusLabel } from "./status";
import type { HostBooking } from "./types";
import { HOST_BOOKINGS_PATH, withQuery } from "@/lib/host/routes";

/*
 * OTA の予約の画面 (#194 PR B, owner decision 2026-11-01): a booking made on a reservation site (Airbnb, GetYourGuide, …) as
 * 予約, ホーム and この回 show one, from the experience DB's external ledger (HostOtaBookings). The host sees where it came
 * from, who booked and how to reach them; the site keeps the booking itself: cancelling, refunding and writing to the guest
 * happen there, so nothing here changes it. No amount: the ledger keeps none. Type-only use of the store: the screen's
 * client code shares these rules and texts.
 */

/** Under the detail: the site is where the booking is changed. */
export const otaBookingOnSiteText = (site: string) => `取消・返金・予約者とのやりとりは ${site} で行ってください。この画面からは変えられません。`;
/** A booking the site has not confirmed yet (it keeps its seat). */
export const OTA_BOOKING_PENDING_TEXT = "予約サイトで確定待ちです。席は押さえています。";
/** Kept for NIHO's staff: a double booking, or a time that matched no session. */
export const OTA_BOOKING_REVIEW_TEXT = "NIHO が確認しています（ほかの予約と重なっているか、開催の回と時刻が合っていません）。";
/** The guest's details went a year after the experience. */
export const OTA_BOOKING_ERASED_TEXT = "保存期間を過ぎたため、予約者の情報は表示できません。";
/** The site's reader gave no guest details. */
export const OTA_BOOKING_NO_DETAILS_TEXT = "予約サイトから予約者の情報を受け取っていません。";
export const OTA_BOOKING_NO_NAME = "（名前なし）";
export const OTA_BOOKING_ERASED_NAME = "保存期間を過ぎたため表示できません";
export const OTA_BOOKING_LOAD_FAILED_TEXT = "予約サイトで受けた予約を読み込めませんでした。時間をおいて、ページを読み込み直してください。";
/** 予約's line over the list where OTA bookings are on it. */
export const OTA_BOOKINGS_LIST_TEXT = "予約サイト（Airbnb・GetYourGuide など）で受けた予約も並べています。予約サイトの名前で見分けられます";

const BANDS: Readonly<Record<string, string>> = { ADULT: "大人", SENIOR: "シニア", YOUTH: "ユース", STUDENT: "学生", CHILD: "子ども", INFANT: "幼児" };
const CHILD_BANDS: ReadonlySet<string> = new Set(["CHILD", "INFANT"]);

const PENDING_STATUS: StatusLabel = { label: "確定待ち", tone: "wait" };
const REVIEW_STATUS: StatusLabel = { label: "確認中", tone: "wait" };

/** YYYY-MM-DDTHH:MM in Japan, as the console dates things. */
function japanMinute(utc: string): string {
  const at = Date.parse(utc);
  return actionTime(todayInJapan(at), at);
}

/** "大人 2・子ども 1" by the site's age bands, or null when it gave none. */
export function otaPartyLabel(breakdown: HostOtaBooking["partyBreakdown"]): string | null {
  return breakdown?.length ? breakdown.map(({ band, count }) => `${BANDS[band] ?? band} ${count}`).join("・") : null;
}

/**
 * One OTA booking as 予約 shows it. The session's own time where the ledger placed it, else the site's. A booking the site
 * has not confirmed yet counts as one with its seat (確定待ち on its pill), one waiting for staff says so. The guest's
 * contact is in `ota` only: the detail and この回 show it (owner decision 2026-11-01), the list never does.
 */
export function otaBooking(stored: HostOtaBooking): HostBooking {
  const start = japanMinute(stored.occurrenceStartUtc ?? stored.sourceStartUtc);
  const end = japanMinute(stored.occurrenceEndUtc ?? stored.sourceEndUtc);
  const siteLabel = otaSiteLabel(stored.site);
  const breakdown = stored.partyBreakdown ?? [];
  const children = breakdown.filter((entry) => CHILD_BANDS.has(entry.band)).reduce((sum, entry) => sum + entry.count, 0);
  const guest = stored.guest;
  return {
    id: stored.ref,
    experienceId: stored.productId,
    // A booking waiting for staff has no session: its own heading, with no この回.
    offerId: stored.offerId ?? "",
    offer: stored.productTitle,
    guest: guest?.name ?? (stored.erased ? OTA_BOOKING_ERASED_NAME : OTA_BOOKING_NO_NAME),
    language: guest?.language?.toLowerCase().startsWith("ja") ? "ja" : "en",
    country: null,
    dietary: [],
    phone: null,
    attendance: null,
    date: start.slice(0, 10),
    start: start.slice(11),
    end: end.slice(11),
    adults: breakdown.length ? stored.seats - children : stored.seats,
    children: breakdown.length ? children : 0,
    guests: stored.seats,
    adultPriceYen: 0,
    childPriceYen: null,
    amountYen: 0,
    status: stored.status === "CANCELLED" ? "cancelled" : "confirmed",
    channel: siteLabel,
    // What the guest wrote to the site: この回 shows it with the guest, as a note.
    note: guest?.notes ?? "",
    answers: [],
    meetingGuide: null,
    authorizedAt: null,
    paidAt: null,
    respondBy: null,
    cancelRequestedAt: null,
    cancelledAt: null,
    cancelReason: null,
    cancelMessage: null,
    refundedYen: 0,
    timeline: [{ at: japanMinute(stored.firstSeenAtUtc), text: `${siteLabel} から取り込み` }],
    ota: {
      ref: stored.ref,
      site: stored.site,
      siteLabel,
      bookingReference: stored.bookingReference,
      email: guest?.email ?? null,
      phone: guest?.phone ?? null,
      languageTag: guest?.language ?? null,
      notes: guest?.notes ?? null,
      party: otaPartyLabel(stored.partyBreakdown),
      pending: stored.status === "PENDING",
      needsReview: stored.needsReview,
      erased: stored.erased,
      hasDetails: guest !== null,
    },
  };
}

/** The pill of an OTA booking: 確定待ち and 確認中 before the plain states. */
export function otaStatusLabel(booking: Pick<HostBooking, "status" | "date" | "ota">, today: string): StatusLabel {
  if (booking.status === "confirmed" && booking.ota?.needsReview) return REVIEW_STATUS;
  if (booking.status === "confirmed" && booking.ota?.pending) return PENDING_STATUS;
  return bookingStatusLabel(booking, today);
}

/** The experiences OTA bookings name, for the list's select and headings (no capacity: the headings say "4名"). */
export function otaBookingExperiences(bookings: readonly HostOtaBooking[]): BookingExperience[] {
  const experiences = new Map<string, { title: string; offers: Map<string, number> }>();
  for (const booking of bookings) {
    const experience = experiences.get(booking.productId) ?? { title: booking.productTitle, offers: new Map<string, number>() };
    if (booking.offerId && booking.occurrenceStartUtc && booking.occurrenceEndUtc) {
      experience.offers.set(booking.offerId, Math.round((Date.parse(booking.occurrenceEndUtc) - Date.parse(booking.occurrenceStartUtc)) / 60_000));
    }
    experiences.set(booking.productId, experience);
  }
  return [...experiences].map(([id, { title, offers }]) => ({ id, title, offers: [...offers].map(([offerId, durationMinutes]) => ({ id: offerId, capacity: null, durationMinutes })) }));
}

/** ホーム shows an OTA booking as new for this long after this site first read it. */
export const OTA_HOME_NEW_HOURS = 72;
/** And at most this many of them. */
export const OTA_HOME_TODOS_MAX = 5;

/**
 * 次にすること's new OTA bookings (#194 PR B): those read in the last three days whose session is still ahead and that are
 * not cancelled, the newest first, each leading to its detail (`?ota=`, the push's link too).
 */
export function otaHomeTodos(bookings: readonly HostOtaBooking[], now: number): HomeTodo[] {
  return bookings
    .filter((booking) => booking.status !== "CANCELLED" && Date.parse(booking.occurrenceStartUtc ?? booking.sourceStartUtc) > now
      && now - Date.parse(booking.firstSeenAtUtc) <= OTA_HOME_NEW_HOURS * 3_600_000)
    .sort((a, b) => Date.parse(b.firstSeenAtUtc) - Date.parse(a.firstSeenAtUtc) || (a.ref < b.ref ? -1 : 1))
    .slice(0, OTA_HOME_TODOS_MAX)
    .map((stored) => {
      const booking = otaBooking(stored);
      const site = booking.ota!.siteLabel;
      return {
        key: `ota-new/${stored.ref}`,
        status: { label: "新しい予約", tone: "ok" },
        aside: { text: site, tone: "muted" },
        title: `${site} で新しい予約`,
        detail: [`${shortDateWithWeekdayJa(booking.date)}${booking.start}`, stored.productTitle, stored.guest?.name ? `${stored.guest.name} 様` : null, `${stored.seats}名`]
          .filter(Boolean).join(" · "),
        approval: null,
        action: { label: "予約を見る", href: withQuery(HOST_BOOKINGS_PATH, { ota: stored.ref }), primary: false },
      } satisfies HomeTodo;
    });
}

/**
 * この回 with the session's OTA bookings (#194 PR B): beside this site's or the preview's guests, or the whole session when
 * it has only OTA bookings (no capacity or meeting line is known then). null when there is nothing to show.
 */
export function withOtaGuests(view: HostSessionView | null, ota: readonly HostBooking[], query: SessionQuery): HostSessionView | null {
  if (!ota.length) return view;
  if (view) return { ...view, bookings: [...view.bookings, ...ota.filter((booking) => !view.bookings.some((item) => item.id === booking.id))] };
  const first = ota[0]!;
  return {
    date: query.date, start: query.start, end: first.end, experienceId: query.experience, offerId: query.offer,
    title: first.offer, offer: first.offer, capacity: null, meetingArea: "", bookings: [...ota],
  };
}
