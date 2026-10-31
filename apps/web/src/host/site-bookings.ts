import type { CancellationReason, HostGuestBooking, HostGuestBookingAnswer } from "@niho-experience/experience-store";
import { actionTime, type BookingExperience } from "./bookings";
import { todayInJapan, yen } from "./format";
import type { HostBooking, HostBookingAnswer, HostBookingEvent, HostBookingStatus } from "./types";

/*
 * 予約 for the bookings travelers made on this site (#285 slice 8, docs/guest-booking.md「ホストの画面」): the
 * experience DB's booking as the bookings screen shows one (HostBooking), with who cancelled it, why and its refunds
 * (slice 7). Messages with the guest come with slice 6. Type-only use of the store: the screen's client code shares
 * these rules and texts.
 */

/** In place of the guest's name, note and answers once they were erased (a year after the experience). */
export const SITE_BOOKING_ERASED_TEXT = "保存期間を過ぎたため表示できません";
/** Beside the cancel action: the host refunds in full; anything else goes through NIHO support. */
export const SITE_BOOKING_SUPPORT_TEXT = "取り消すと予約者に全額を返金します。一部だけの返金や返金の相談は NIHO サポートへご連絡ください";
/** この回: calling it off refunds everyone in full; anything else goes through NIHO support. */
export const SITE_SESSION_SUPPORT_TEXT = "この回を中止すると、確定している予約者全員に全額を返金します。1 件だけの取消は予約の詳細から、一部だけの返金は NIHO サポートへご連絡ください";
/** A payment under review, or a booking the guest asked support to cancel: support handles it. */
export const SITE_BOOKING_SUPPORT_HANDLES_TEXT = "NIHO サポートが対応します。ご不明な点は NIHO サポートへご連絡ください";
/** The guest asked after free cancellation ended. */
export const SITE_BOOKING_REQUESTED_TEXT = "予約者が NIHO サポートに取消を依頼しています（無料取消の期限後）";

/** 取消理由 a host picks for one booking (the store's HOST_CANCELLATION_REASONS), and for a whole session. */
export const SITE_CANCEL_REASONS: readonly { value: CancellationReason; label: string }[] = [
  { value: "HOST_UNAVAILABLE", label: "ホストの都合" },
  { value: "WEATHER", label: "雨・荒天" },
  { value: "ILLNESS", label: "急病・けが" },
  { value: "GUEST_REQUEST", label: "予約者からの依頼" },
  { value: "OTHER", label: "その他" },
];
export const SITE_SESSION_CANCEL_REASONS: readonly { value: CancellationReason; label: string }[] = SITE_CANCEL_REASONS.filter((item) => item.value !== "GUEST_REQUEST");
const REASON_LABELS: Readonly<Record<string, string>> = { ...Object.fromEntries(SITE_CANCEL_REASONS.map((item) => [item.value, item.label])), LATE_PAYMENT: "支払いの遅れ" };
/** The host's own note on a cancellation: never sent to the guest. */
export const SITE_CANCEL_NOTE_MAX = 1000;

const CANCELLED_BY = { GUEST: "guest", HOST: "host", SUPPORT: "support" } as const;
const CANCELLED_BY_LABEL = { guest: "予約者", host: "ホスト", support: "NIHO サポート" } as const;

/** "11/4 に取消（ホスト · 雨・荒天）" and where the refund is: what 予約's detail says of a cancelled booking. */
export function siteCancellationLines(booking: Pick<HostBooking, "cancelledAt" | "site">): string[] {
  const cancellation = booking.site?.cancellation;
  if (!cancellation) return [];
  const lines: string[] = [];
  if (booking.cancelledAt && cancellation.by) {
    const why = [CANCELLED_BY_LABEL[cancellation.by], cancellation.reason].filter(Boolean).join(" · ");
    lines.push(`${Number(booking.cancelledAt.slice(5, 7))}/${Number(booking.cancelledAt.slice(8, 10))} に取消（${why}）`);
  }
  if (cancellation.refundedYen > 0) lines.push(`${yen(cancellation.refundedYen)} を返金済み`);
  if (cancellation.refundPendingYen > 0) lines.push(`${yen(cancellation.refundPendingYen)} を返金中（Stripe の処理待ち）`);
  if (cancellation.refundFailed) lines.push("返金に失敗しました。NIHO サポートが対応します");
  if (booking.cancelledAt && cancellation.refundedYen === 0 && cancellation.refundPendingYen === 0 && !cancellation.refundFailed) lines.push("返金なし");
  return lines;
}

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
  const by = stored.cancelledBy ? CANCELLED_BY[stored.cancelledBy] : null;
  if (cancelledAt) timeline.push({ at: cancelledAt, text: by ? `取消（${CANCELLED_BY_LABEL[by]}）` : "取消" });
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
    refundedYen: stored.refundedAmount,
    timeline,
    site: {
      fee: fee ? { amountYen: fee.amount, percent: fee.basisPoints / 100, supportEnabled: fee.supportEnabled } : null,
      payoutYen: stored.providerAmount,
      cancellationPolicy: stored.cancellationPolicy,
      cancellation: {
        by,
        reason: stored.cancellationReason ? (REASON_LABELS[stored.cancellationReason] ?? null) : null,
        note: stored.cancellationNote,
        refundedYen: stored.refundedAmount,
        refundPendingYen: stored.refundPendingAmount,
        refundFailed: stored.refundFailed,
        requested: stored.cancellationRequested,
      },
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
