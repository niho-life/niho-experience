import { bookingStatusLabel, type BookingExperience } from "./bookings";
import type { StatusLabel } from "./status";
import type { HostLiveBookingListItem } from "./live-bookings";
import type { HostBooking, HostBookingStatus } from "./types";

/*
 * NIHO's bookings (the provider operations BFF, live-bookings.ts) in 予約's words: the labels of NIHO's states,
 * channels and deliveries, and one of NIHO's bookings as a row of 予約's one list beside the bookings made on
 * this site (#84, both EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED and EXPERIENCE_GUEST_BOOKING_ENABLED). NIHO
 * keeps its bookings (ADR 0002): nothing here changes NIHO's contract. Client-safe.
 */

type NihoStatus = HostLiveBookingListItem["status"];

export const NIHO_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: "支払い確認中", PAYMENT_PENDING: "支払い待ち", PROVISIONAL: "承認待ち", CONFIRMED: "確定",
  DECLINED: "お断り", EXPIRED: "期限切れ", CANCELLED: "取消済み", REFUND_NEEDED: "返金対応が必要", UNKNOWN: "状態を確認中",
};
export const NIHO_CHANNEL_LABELS: Readonly<Record<string, string>> = { NIHO_PAGE: "NIHO", EMBED: "埋め込み", EXPERIENCE_SITE: "体験サイト" };
export const NIHO_DELIVERY_LABELS: Readonly<Record<string, string>> = { QUEUED: "配信待ち", SENT: "送信済み", FAILED: "送信失敗", UNKNOWN: "配信状態を確認中" };

/** A label of one of the maps, or 確認中 for a value NIHO added since. */
export function nihoLabel(map: Readonly<Record<string, string>>, value: string | null): string {
  return value !== null && map[value] ? map[value] : "確認中";
}

/** "18:00" in Japan; "--:--" for a time that is not one. */
export function japanTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date)
    : "--:--";
}

/** "10/22 18:00" in Japan; 日時未確認 for a time that is not one. */
export function japanDateTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date)
    : "日時未確認";
}

/**
 * NIHO's states as 予約's filters count them. A payment NIHO is still waiting for or checking, and a state NIHO
 * added since, hold no seat but are not over (like this site's 確認待ち): これから until their day.
 */
const STATUS: Record<NihoStatus, HostBookingStatus> = {
  PENDING: "payment_review", PAYMENT_PENDING: "payment_review", PROVISIONAL: "pending", CONFIRMED: "confirmed",
  DECLINED: "declined", EXPIRED: "expired", CANCELLED: "cancelled", REFUND_NEEDED: "refund_needed", UNKNOWN: "payment_review",
};

/** The pill of the states 予約's own words do not have. */
const OWN_LABEL: Partial<Record<NihoStatus, StatusLabel>> = {
  PENDING: { label: NIHO_STATUS_LABELS.PENDING!, tone: "wait" },
  PAYMENT_PENDING: { label: NIHO_STATUS_LABELS.PAYMENT_PENDING!, tone: "wait" },
  UNKNOWN: { label: NIHO_STATUS_LABELS.UNKNOWN!, tone: "wait" },
};

/** The channel on 予約's one list: NIHO's bookings say so, apart from this site's "体験サイト". */
export function nihoChannelLabel(channel: string | null): string {
  return channel === "NIHO_PAGE" ? "NIHO" : `NIHO（${nihoLabel(NIHO_CHANNEL_LABELS, channel)}）`;
}

/**
 * One of NIHO's bookings on 予約's one list (#84): what the row, the filters and its session's heading need. Its
 * detail, and what the host can do with it (承認・お断り・連絡), are read from NIHO when it is opened
 * (HostNihoBookingDetail). Its experience is NIHO's page, apart from this site's products.
 */
export interface NihoBookingRow extends Pick<HostBooking, "id" | "experienceId" | "offerId" | "guest" | "date" | "start" | "end" | "guests" | "amountYen" | "channel" | "status"> {
  niho: { status: NihoStatus };
}

/** NIHO's page as 予約's experience select and headings name it: its own id space beside this site's products. */
export function nihoExperienceId(pageId: string): string {
  return `niho:${pageId}`;
}

export function nihoBookingRow(item: HostLiveBookingListItem): NihoBookingRow {
  return {
    id: item.id,
    experienceId: nihoExperienceId(item.pageId),
    offerId: item.offerId,
    guest: item.guestName,
    date: item.occurrenceDate,
    start: japanTime(item.startAt),
    end: japanTime(item.endAt),
    guests: item.headCount,
    amountYen: item.totalYen,
    channel: nihoChannelLabel(item.salesChannel),
    status: STATUS[item.status] ?? "payment_review",
    niho: { status: item.status },
  };
}

/** The pages NIHO's bookings name, for the select and the headings. NIHO's list has no capacity: the headings say "4名". */
export function nihoBookingExperiences(items: readonly HostLiveBookingListItem[]): BookingExperience[] {
  const pages = new Map<string, { title: string; offers: Map<string, number | null> }>();
  for (const item of items) {
    const id = nihoExperienceId(item.pageId);
    const page = pages.get(id) ?? { title: item.pageTitle, offers: new Map<string, number | null>() };
    const minutes = Math.round((Date.parse(item.endAt) - Date.parse(item.startAt)) / 60_000);
    page.offers.set(item.offerId, Number.isFinite(minutes) && minutes > 0 ? minutes : null);
    pages.set(id, page);
  }
  return [...pages].map(([id, { title, offers }]) => ({ id, title, offers: [...offers].map(([offerId, durationMinutes]) => ({ id: offerId, capacity: null, durationMinutes: durationMinutes ?? 0 })) }));
}

/** 続きを見る: the next page joins NIHO's rows; a booking already on the list takes NIHO's newer state. */
export function mergeNihoRows(current: readonly NihoBookingRow[], next: readonly NihoBookingRow[]): NihoBookingRow[] {
  const merged = new Map(current.map((row) => [row.id, row]));
  for (const row of next) merged.set(row.id, row);
  return [...merged.values()];
}

/** The pill: 予約's own for the states it shares with NIHO (a passed 確定 in the quiet tone), NIHO's words for the rest. */
export function nihoRowStatusLabel(row: Pick<NihoBookingRow, "status" | "date" | "niho">, today: string): StatusLabel {
  return OWN_LABEL[row.niho.status] ?? bookingStatusLabel(row, today);
}
