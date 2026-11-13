import "server-only";
import { config } from "@/lib/config";
import { parseChannelAdapters } from "./channel-adapters";
import { Pool } from "pg";
import { AdminSessions, OperatorCliRequests, ArticleAuthorityRepository, BookingAttendance, BookingCancellations, ChannelRuntime, ExperiencePublicationRepository, ExperienceStore, ExperienceSupportRepository, GuestBookingAccess, GuestBookingMessages, GuestBookingRepository, GuestMeetingGuideRepository, GuestQuestionRepository, GuestReviewRatings, GuestReviewRepository, GuideAdminRepository, GroupInquiryRepository, PeopleListingRepository, GuideRepository, HostAccountIdentities, HostAccounts, HostInvitations, HostCalendarSettings, HostNotificationAddresses, HostOtaBookings, HostTeamRepository, ManagedBookingApprovalRepository, ManagedExperienceSalesRepository, OccurrenceAssignmentRepository, ProductClassificationRepository, ProductOperatorRepository, ProviderHostBioRepository, ProviderNotificationSettings, ProviderPayoutAccountConsents, ProviderSellerDisclosureRepository, type ChannelCapabilities, type GuestThreadKind } from "@niho-experience/experience-store";

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

export function managedExperienceSalesRepository(): ManagedExperienceSalesRepository | null {
  const pool = experiencePool();
  return pool ? new ManagedExperienceSalesRepository(pool) : null;
}

export function managedBookingApprovalRepository(): ManagedBookingApprovalRepository | null {
  const pool = experiencePool();
  return pool ? new ManagedBookingApprovalRepository(pool) : null;
}

/** 開催回の担当 (#535 v0): the people who can serve and NIHO's office. Callers check EXPERIENCE_OCCURRENCE_ASSIGNMENT_ENABLED first. */
export function occurrenceAssignmentRepository(): OccurrenceAssignmentRepository | null {
  const pool = experiencePool();
  return pool ? new OccurrenceAssignmentRepository(pool, { notifications: config.occurrenceAssignmentEnabled }) : null;
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

/** 商品の分類 (#529): category, area, だれと and こんな日に. No flag: it is listing metadata the Japanese site reads. */
export function productClassificationRepository(): ProductClassificationRepository | null {
  if (config.apiMode !== "http") return null;
  const pool = experiencePool();
  return pool ? new ProductClassificationRepository(pool) : null;
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

/**
 * 運営の CLI (#576 ⑤): the office writes articles for a provider. Built only for requests that carry a verified Admin
 * assertion (`loadWriteContext`); never the host-facing repository.
 */
export function guideOfficeRepository(): GuideRepository | null {
  if (!config.operatorCliEnabled) return null;
  const pool = experiencePool();
  return pool ? new GuideRepository(pool, { office: true }) : null;
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
 * NIHO アカウントとの結び付け (Epic #591, 0083): which NIHO account opens which host account's session. null until
 * EXPERIENCE_HOST_NIHO_LOGIN_ENABLED is on (which needs the host accounts and the experience DB).
 */
export function hostAccountIdentities(): HostAccountIdentities | null {
  if (!config.hostNihoLoginEnabled || !config.hostAccountsEnabled) return null;
  const pool = experiencePool();
  return pool ? new HostAccountIdentities(pool) : null;
}

/**
 * ホストの招待リンク (Epic #591, #596, 0084): ops invites a registered host account to bind its NIHO account. null until
 * EXPERIENCE_HOST_NIHO_LOGIN_ENABLED is on (which needs the host accounts and the experience DB).
 */
export function hostInvitations(): HostInvitations | null {
  if (!config.hostNihoLoginEnabled || !config.hostAccountsEnabled) return null;
  const pool = experiencePool();
  return pool ? new HostInvitations(pool) : null;
}

/** Native provider team and access-fingerprint repository. Closed unless every native boundary is enabled. */
export function hostTeamRepository(): HostTeamRepository | null {
  if (!config.hostTeamEnabled || !config.hostAccountsEnabled || config.apiMode !== "http") return null;
  const pool = experiencePool();
  return pool ? new HostTeamRepository(pool) : null;
}

/**
 * Admin のログイン (ADR 0003 slice 4): the sessions of admins signed in with Google. null until
 * EXPERIENCE_ADMIN_GOOGLE_LOGIN_ENABLED is on (which needs the experience DB).
 */
export function adminSessions(): AdminSessions | null {
  if (!config.adminGoogleLoginEnabled) return null;
  const pool = experiencePool();
  return pool ? new AdminSessions(pool) : null;
}

/** 運営の CLI (#576, migration 0078): the audit trail of what an admin changed from the command line. null until EXPERIENCE_OPERATOR_CLI_ENABLED is on. */
export function operatorCliRequests(): OperatorCliRequests | null {
  if (!config.operatorCliEnabled) return null;
  const pool = experiencePool();
  return pool ? new OperatorCliRequests(pool) : null;
}

/** 受取口座の利用同意 (ADR 0003 slice 3): the host-account OWNER's payout-account consent. Only with host accounts. */
export function payoutAccountConsents(): ProviderPayoutAccountConsents | null {
  if (!config.hostAccountsEnabled) return null;
  const pool = experiencePool();
  return pool ? new ProviderPayoutAccountConsents(pool) : null;
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

/** 人物ページから本人へのメッセージ (#589): null until its flag is on and the experience DB is configured. */
export function personMessageRepository(): GuestQuestionRepository | null {
  if (!config.personMessagesEnabled) return null;
  const pool = experiencePool();
  return pool ? new GuestQuestionRepository(pool) : null;
}

/**
 * The reply page's store (#105, #589): the answer to a question and the answer to a message to a person are both read and
 * answered there, so it opens with either flag. null while neither is on or without the experience DB.
 */
export function guestReplyRepository(): GuestQuestionRepository | null {
  if (!config.guestQuestionsEnabled && !config.personMessagesEnabled) return null;
  const pool = experiencePool();
  return pool ? new GuestQuestionRepository(pool) : null;
}

/** 団体・個別の相談 (#532): null until its flag is on and the experience DB is configured. */
/** 街の人 (#564): the Japanese site's people pages and their Admin list. The photos are served by the publications media route, so it needs the same flag. */
export function peopleListingRepository(): PeopleListingRepository | null {
  if (config.apiMode !== "http" || !config.experiencePublicationsEnabled) return null;
  const pool = experiencePool();
  return pool ? new PeopleListingRepository(pool) : null;
}

export function groupInquiryRepository(): GroupInquiryRepository | null {
  if (!config.groupInquiryEnabled) return null;
  const pool = experiencePool();
  return pool ? new GroupInquiryRepository(pool) : null;
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
  return pool ? new GuestBookingRepository(pool, { assignmentNotifications: config.occurrenceAssignmentEnabled }) : null;
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
  // A message sent from a person's page (#589) is a thread like a question, so either flag opens that kind.
  const questions = config.guestQuestionsEnabled || config.personMessagesEnabled;
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
export function guestHoldReleases(): Pick<GuestBookingRepository, "releaseGuestHold" | "expireGuestHoldForSalesPlanSwitch"> | null {
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
