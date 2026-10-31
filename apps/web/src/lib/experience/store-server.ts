import "server-only";
import { config } from "@/lib/config";
import { Pool } from "pg";
import { BookingAttendance, BookingCancellations, ChannelRuntime, ExperienceStore, GuestBookingAccess, GuestBookingMessages, GuestBookingRepository, GuestQuestionRepository, GuestReviewRepository, GuideAdminRepository, GuideRepository, ProductOperatorRepository, ProviderNotificationSettings, type ChannelCapabilities, type GuestThreadKind } from "@niho-experience/experience-store";

const globalPool = globalThis as typeof globalThis & { __nihoExperiencePool?: Pool };

/** No database URL means the new calendar stays unavailable during the migration. */
export function experiencePool(): Pool | null {
  const connectionString = process.env.EXPERIENCE_DATABASE_URL;
  if (!connectionString) return null;
  if (!globalPool.__nihoExperiencePool) {
    globalPool.__nihoExperiencePool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 });
  }
  return globalPool.__nihoExperiencePool;
}

export function experienceStore(): ExperienceStore | null {
  const pool = experiencePool();
  return pool ? new ExperienceStore(pool) : null;
}

export function productOperatorRepository(): ProductOperatorRepository | null {
  if (config.apiMode !== "http") return null;
  const pool = experiencePool();
  return pool ? new ProductOperatorRepository(pool) : null;
}

function supportedChannelAdapters(): Readonly<Record<string, ChannelCapabilities>> {
  const raw = process.env.EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, ChannelCapabilities> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value) || key.length > 300) return {};
      const record = value as Record<string, unknown>;
      if (Object.keys(record).some((name) => !["canObserve", "canReadReservations", "canClose", "canOpen", "canCreate"].includes(name))) return {};
      if (Object.values(record).some((item) => typeof item !== "boolean")) return {};
      result[key] = record as ChannelCapabilities;
    }
    return result;
  } catch {
    return {};
  }
}

export function googleAirbnbObservationEnabled(): boolean {
  return config.apiMode === "http"
    && process.env.EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED === "true"
    && process.env.EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED === "true";
}

export function channelRuntime(): ChannelRuntime | null {
  const pool = experiencePool();
  return pool ? new ChannelRuntime(pool, {
    supportedAdapters: supportedChannelAdapters(),
    googleAirbnbObservationEnabled: googleAirbnbObservationEnabled(),
  }) : null;
}

export function guideRepository(): GuideRepository | null {
  const pool = experiencePool();
  return pool ? new GuideRepository(pool) : null;
}

export function guideAdminRepository(): GuideAdminRepository | null {
  const pool = experiencePool();
  return pool ? new GuideAdminRepository(pool) : null;
}

/** 設定 › 通知 (#109): null until its flag is on and the experience DB is configured. */
export function providerNotificationSettings(): ProviderNotificationSettings | null {
  if (!config.hostNotificationSettingsEnabled) return null;
  const pool = experiencePool();
  return pool ? new ProviderNotificationSettings(pool) : null;
}

/** 予約前の質問 (#105/#106): null until its flag is on and the experience DB is configured. */
export function guestQuestionRepository(): GuestQuestionRepository | null {
  if (!config.guestQuestionsEnabled) return null;
  const pool = experiencePool();
  return pool ? new GuestQuestionRepository(pool) : null;
}

/** 予約者のレビュー (#104/#108): null until its flag is on and the experience DB is configured. */
export function guestReviewRepository(): GuestReviewRepository | null {
  if (!config.guestReviewsEnabled) return null;
  const pool = experiencePool();
  return pool ? new GuestReviewRepository(pool) : null;
}

/** 旅行者の予約 (#285, docs/guest-booking.md): null until its flag is on and the experience DB is configured. */
export function guestBookingRepository(): GuestBookingRepository | null {
  if (!config.guestBookingEnabled) return null;
  const pool = experiencePool();
  return pool ? new GuestBookingRepository(pool) : null;
}

/** 出欠 (#107): null until its flag (and so booking on this site) is on and the experience DB is configured. */
export function bookingAttendance(): BookingAttendance | null {
  if (!config.hostAttendanceEnabled) return null;
  const pool = experiencePool();
  return pool ? new BookingAttendance(pool) : null;
}

/**
 * 売上 (#91): the payment ledger of bookings made on this site, read for the OWNER. Its own flag: the sales stay
 * readable after booking here is turned off. null until the flag is on and the experience DB is configured.
 */
export function hostSalesRepository(): GuestBookingRepository | null {
  if (!config.hostSalesLedgerEnabled) return null;
  const pool = experiencePool();
  return pool ? new GuestBookingRepository(pool) : null;
}

/**
 * 予約者の予約ページ (#285 slice 6, docs/guest-booking.md): null until both its flags are on (booking on this site
 * and the mail job that sends the links) and the experience DB is configured.
 */
export function guestBookingAccess(): GuestBookingAccess | null {
  if (!config.guestBookingEnabled || !config.guestMailEnabled) return null;
  const pool = experiencePool();
  return pool ? new GuestBookingAccess(pool) : null;
}

/**
 * 予約ごとのメッセージ (#285 slice 6b), the guest's side: open with the guest's booking page (both its flags) and the
 * experience DB.
 */
export function guestBookingMessages(): GuestBookingMessages | null {
  if (!config.guestBookingEnabled || !config.guestMailEnabled) return null;
  const pool = experiencePool();
  return pool ? new GuestBookingMessages(pool) : null;
}

/**
 * メッセージ's threads kept in the experience DB, for the host: questions (their flag, #106) and the messages of
 * bookings made on this site (with the guest's booking page, #285 slice 6b). `kind` keeps the one that is open when
 * only one is; null when both are. null while neither is open or without the experience DB.
 */
export function siteThreadRepository(): { repository: GuestQuestionRepository; kind: GuestThreadKind | null } | null {
  const questions = config.guestQuestionsEnabled;
  const bookings = config.guestBookingEnabled && config.guestMailEnabled;
  if (!questions && !bookings) return null;
  const pool = experiencePool();
  if (!pool) return null;
  return { repository: new GuestQuestionRepository(pool), kind: questions && bookings ? null : questions ? "QUESTION" : "BOOKING" };
}

/**
 * The Stripe webhook's view of 旅行者の予約 (#285 slice 4). A Session this service created can end after the
 * flag is turned off, so releasing its hold needs only the experience DB, like confirming its payment.
 */
export function guestHoldReleases(): Pick<GuestBookingRepository, "releaseGuestHold"> | null {
  const pool = experiencePool();
  return pool ? new GuestBookingRepository(pool) : null;
}

/**
 * 取消と返金 (#285 slice 7, docs/guest-booking.md). Each caller checks its own flag and actor (the guest's page, the
 * host console, Admin); the Stripe webhook needs only the experience DB, since a refund Stripe finishes after a flag
 * was turned off must still be recorded.
 */
export function bookingCancellations(): BookingCancellations | null {
  const pool = experiencePool();
  return pool ? new BookingCancellations(pool) : null;
}
