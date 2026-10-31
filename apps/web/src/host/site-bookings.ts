import type { HostGuestBooking, HostGuestBookingAnswer } from "@niho-experience/experience-store";
import { actionTime, type BookingExperience } from "./bookings";
import { todayInJapan } from "./format";
import type { HostBooking, HostBookingAnswer, HostBookingEvent, HostBookingStatus } from "./types";

/*
 * 予約 for the bookings travelers made on this site (#285 slice 8, docs/guest-booking.md「ホストの画面」): the
 * experience DB's booking as the bookings screen shows one (HostBooking). Read only until cancellation and
 * refunds (slice 7) and messages with the guest (slice 6) come here. Type-only use of the store: the
 * screen's client code shares these rules and texts.
 */

/** In place of the guest's name, note and answers once they were erased (a year after the experience). */
export const SITE_BOOKING_ERASED_TEXT = "保存期間を過ぎたため表示できません";
/** Where nothing on the screen changes a booking yet. */
export const SITE_BOOKING_READ_ONLY_TEXT = "取消・返金は NIHO サポートへご連絡ください";
/** A payment under review (確認待ち): it arrived after the hold was released. */
export const SITE_BOOKING_PAYMENT_REVIEW_TEXT = "仮押さえの期限のあとに支払いが届きました。席は確保されていません";
export const SITE_BOOKING_LOAD_FAILED_TEXT = "予約を読み込めませんでした。時間をおいて、もう一度お試しください。";
/** 申込経路 of every booking made here. */
export const SITE_BOOKING_CHANNEL = "体験サイト";
/** An answer whose question, or choice, the sale terms no longer have: the booking keeps only the answer. */
const DROPPED_QUESTION = "（削除された質問）";
const DROPPED_OPTION = "（削除された選択肢）";

const STATUS: Record<HostGuestBooking["status"], HostBookingStatus> = { CONFIRMED: "confirmed", PAYMENT_REVIEW: "payment_review", CANCELLED: "cancelled" };

/** YYYY-MM-DDTHH:MM in Japan, as the console dates things. */
function japanMinute(utc: string): string {
  const at = Date.parse(utc);
  return actionTime(todayInJapan(at), at);
}

function answerOf(answer: HostGuestBookingAnswer): HostBookingAnswer {
  const choices = answer.options.map((option) => option.label ?? DROPPED_OPTION);
  return { question: answer.prompt ?? DROPPED_QUESTION, answer: [answer.text ?? "", ...choices].filter(Boolean).join("、") };
}

/**
 * One booking made here as 予約 shows it. Never the guest's address (the store has none to give) and, as for
 * NIHO's bookings, never their phone: only この回 shows it (owner decision 2026-10-22, #103).
 */
export function siteBooking(stored: HostGuestBooking): HostBooking {
  const status = STATUS[stored.status];
  const bookedAt = japanMinute(stored.bookedAtUtc);
  const paidAt = stored.paidAtUtc ? japanMinute(stored.paidAtUtc) : null;
  const cancelledAt = stored.cancelledAtUtc ? japanMinute(stored.cancelledAtUtc) : null;
  const timeline: HostBookingEvent[] = [{ at: bookedAt, text: "申込" }];
  if (paidAt) timeline.push({ at: paidAt, text: status === "payment_review" ? "支払い · 確認待ち" : "支払い" });
  if (cancelledAt) timeline.push({ at: cancelledAt, text: "取消" });
  const fee = stored.platformFee;
  return {
    id: stored.publicBookingId,
    experienceId: stored.productId,
    offerId: stored.offerId,
    // Every offer of an experience sold here carries the experience's own title.
    offer: stored.productTitle,
    guest: stored.guest?.name ?? SITE_BOOKING_ERASED_TEXT,
    language: stored.language === "JA" ? "ja" : "en",
    country: null,
    dietary: [],
    phone: null,
    attendance: null,
    date: stored.localDate,
    start: stored.localStartTime,
    end: japanMinute(stored.endUtc).slice(11),
    adults: stored.adultCount,
    children: stored.childCount,
    guests: stored.adultCount + stored.childCount,
    adultPriceYen: stored.adultUnitAmount,
    childPriceYen: stored.childUnitAmount,
    amountYen: stored.totalAmount,
    status,
    channel: SITE_BOOKING_CHANNEL,
    note: stored.guest?.note ?? "",
    answers: stored.guest?.answers.map(answerOf) ?? [],
    meetingGuide: null,
    authorizedAt: null,
    paidAt,
    respondBy: null,
    cancelRequestedAt: null,
    cancelledAt,
    cancelReason: null,
    cancelMessage: null,
    refundedYen: 0,
    timeline,
    site: {
      fee: fee ? { amountYen: fee.amount, percent: fee.basisPoints / 100, supportEnabled: fee.supportEnabled } : null,
      payoutYen: stored.providerAmount,
      cancellationPolicy: stored.cancellationPolicy,
    },
  };
}

/**
 * The experiences the bookings name, for the list's select and headings: each offer's length from its
 * bookings. The capacity stays unknown (the headings say "4名"): a booking records the occurrence's
 * capacity only as it was when it was made.
 */
export function siteBookingExperiences(bookings: readonly HostGuestBooking[]): BookingExperience[] {
  const experiences = new Map<string, { title: string; offers: Map<string, number> }>();
  for (const booking of bookings) {
    const experience = experiences.get(booking.productId) ?? { title: booking.productTitle, offers: new Map<string, number>() };
    experience.offers.set(booking.offerId, Math.round((Date.parse(booking.endUtc) - Date.parse(booking.startUtc)) / 60_000));
    experiences.set(booking.productId, experience);
  }
  return [...experiences].map(([id, { title, offers }]) => ({ id, title, offers: [...offers].map(([offerId, durationMinutes]) => ({ id: offerId, capacity: null, durationMinutes })) }));
}

/** 続きを見る: the next page joins the list; a booking already on it is kept as it is. */
export function mergeSiteBookings(current: readonly HostBooking[], next: readonly HostBooking[]): HostBooking[] {
  const known = new Set(current.map((booking) => booking.id));
  return [...current, ...next.filter((booking) => !known.has(booking.id))];
}

/** 続きを見る: the next page's experiences join the select, and their offers the ones already known. */
export function mergeSiteExperiences(current: readonly BookingExperience[], next: readonly BookingExperience[]): BookingExperience[] {
  const merged = new Map(current.map((experience) => [experience.id, experience]));
  for (const experience of next) {
    const known = merged.get(experience.id);
    merged.set(experience.id, known ? { ...known, offers: [...known.offers, ...experience.offers.filter((offer) => !known.offers.some((item) => item.id === offer.id))] } : experience);
  }
  return [...merged.values()];
}
