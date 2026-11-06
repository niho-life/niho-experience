import "server-only";
import { config } from "@/lib/config";
import { parseChannelAdapters } from "./channel-adapters";
import { Pool } from "pg";
import { ArticleAuthorityRepository, BookingAttendance, BookingCancellations, ChannelRuntime, ExperiencePublicationRepository, ExperienceStore, ExperienceSupportRepository, GuestBookingAccess, GuestBookingMessages, GuestBookingRepository, GuestMeetingGuideRepository, GuestQuestionRepository, GuestReviewRatings, GuestReviewRepository, GuideAdminRepository, GuideRepository, HostAccounts, HostCalendarSettings, HostNotificationAddresses, HostOtaBookings, ProductOperatorRepository, ProviderHostBioRepository, ProviderNotificationSettings, ProviderSellerDisclosureRepository, type ChannelCapabilities, type GuestThreadKind } from "@niho-experience/experience-store";

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

/** Immutable public product snapshots and their host publication state. */
export function experiencePublicationRepository(): ExperiencePublicationRepository | null {
  const pool = experiencePool();
  return pool ? new ExperiencePublicationRepository(pool) : null;
}

/** OWNER-entered, public-only seller disclosure. It never reads NIHO profile or KYC fields. */
export function providerSellerDisclosureRepository(): ProviderSellerDisclosureRepository | null {
  const pool = experiencePool();
  return pool ? new ProviderSellerDisclosureRepository(pool) : null;
}

/** ホスト紹介文 (#146): the OWNER-written public bio, one per provider. */
export function providerHostBioRepository(): ProviderHostBioRepository | null {
  const pool = experiencePool();
  return pool ? new ProviderHostBioRepository(pool) : null;
}

/** Private owner-edited logistics captured into a booking snapshot at payment confirmation. */
export function guestMeetingGuideRepository(): GuestMeetingGuideRepository | null {
  const pool = experiencePool();
  return pool ? new GuestMeetingGuideRepository(pool) : null;
}

export function productOperatorRepository(): ProductOperatorRepository | null {
  if (config.apiMode !== "http") return null;
  const pool = experiencePool();
  return pool ? new ProductOperatorRepository(pool) : null;
}

/** A malformed allowlist grants nothing (every capability false), as an unset one does. */
function supportedChannelAdapters(): Readonly<Record<string, ChannelCapabilities>> {
  return parseChannelAdapters(process.env.EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS) ?? {};
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
    otaGuestDetailsEnabled: config.otaGuestDetailsEnabled,
    otaBookingNotificationsEnabled: config.otaBookingNotificationsEnabled,
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

export function articleAuthorityRepository(): ArticleAuthorityRepository | null {
  if (config.apiMode !== "http") return null;
  const pool = experiencePool();
  return pool ? new ArticleAuthorityRepository(pool) : null;
}

/** 設定 › 通知 (#109): null until its flag is on and the experience DB is configured. */
export function providerNotificationSettings(): ProviderNotificationSettings | null {
  if (!config.hostNotificationSettingsEnabled) return null;
  const pool = experiencePool();
  return pool ? new ProviderNotificationSettings(pool) : null;
}

/**
 * 設定 › カレンダー (#109): the Google connection's state, the bookings feed (its own flag, checked where it is used) and
 * the experiences' paths for 体験の一覧. null in mock mode and without the experience DB.
 */
export function hostCalendarSettings(): HostCalendarSettings | null {
  if (config.apiMode !== "http") return null;
  const pool = experiencePool();
  return pool ? new HostCalendarSettings(pool) : null;
}

/**
 * ホストへのメールの宛先 (#194): the sign-in's verified address and the host's choice in 設定 › 通知. null until its flag
 * (EXPERIENCE_HOST_MAIL_ENABLED) is on and the experience DB is configured.
 */
export function hostNotificationAddresses(): HostNotificationAddresses | null {
  if (!config.hostMailEnabled) return null;
  const pool = experiencePool();
  return pool ? new HostNotificationAddresses(pool) : null;
}

/**
 * ホストのアカウント (ADR 0003): Experience's own host accounts, sign-in links and sessions. null until
 * EXPERIENCE_HOST_ACCOUNTS_ENABLED is on (which needs the experience DB).
 */
export function hostAccounts(): HostAccounts | null {
  if (!config.hostAccountsEnabled) return null;
  const pool = experiencePool();
  return pool ? new HostAccounts(pool) : null;
}

/**
 * OTA の予約 (#194 PR B): the bookings made on reservation sites, read for the product's OWNER and its operators in 予約,
 * ホーム and この回. null until EXPERIENCE_OTA_GUEST_DETAILS_ENABLED is on and the experience DB is configured.
 */
export function hostOtaBookings(): HostOtaBookings | null {
  if (!config.otaGuestDetailsEnabled) return null;
  const pool = experiencePool();
  return pool ? new HostOtaBookings(pool) : null;
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
  return pool ? new GuestReviewRepository(pool, { includeNativePublications: config.experiencePublicationsEnabled }) : null;
}

/** 体験の一覧's ★ (#108): every shown review counted by experience, behind レビュー's flag and the experience DB. */
export function guestReviewRatings(): GuestReviewRatings | null {
  if (!config.guestReviewsEnabled) return null;
  const pool = experiencePool();
  return pool ? new GuestReviewRatings(pool) : null;
}

/** 旅行者の予約 (#285, docs/guest-booking.md): null until its flag is on and the experience DB is configured. */
export function guestBookingRepository(): GuestBookingRepository | null {
  if (!config.guestBookingEnabled) return null;
  const pool = experiencePool();
  return pool ? new GuestBookingRepository(pool) : null;
}

/** Existing site bookings for the host's interpreter flow; exposes only reads while guest sales are closed. */
export function translateSiteBookingRepository(): Pick<GuestBookingRepository, "listGuestBookingsForHost" | "getGuestBookingForHost"> | null {
  if (config.apiMode !== "http" || !config.hostConsoleEnabled || !config.experienceTranslateApiEnabled) return null;
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

/** Experience Admin support cases, private Admin notes, and the actual-fee settlement ledger. */
export function experienceSupportRepository(): ExperienceSupportRepository | null {
  const pool = experiencePool();
  return pool ? new ExperienceSupportRepository(pool) : null;
}
