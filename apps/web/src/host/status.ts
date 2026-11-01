import type { ExperienceProviderPageListItem, ExperienceSiteListingStatus } from "@niho-experience/api-client/host";
import type { HostProviderReviewStatus } from "@/lib/host/providers";
import type { PageEnglishStatus } from "./page-english";
import type { HostBookingStatus, HostReviewStatus, ListingStatus, PaymentReadinessReason } from "./types";

/**
 * Pill tones: ok = leaf-pale, wait = warn-pale, draft = sand, stop = danger-pale.
 * The words always carry the meaning; the color only repeats it.
 */
export type PillTone = "ok" | "wait" | "draft" | "stop";

export interface StatusLabel {
  label: string;
  tone: PillTone;
}

export const LISTING_STATUS: Record<ListingStatus, StatusLabel> = {
  live: { label: "掲載中", tone: "ok" },
  review: { label: "審査待ち", tone: "wait" },
  draft: { label: "下書き", tone: "draft" },
  paused: { label: "停止中", tone: "stop" },
};

/** 体験の編集 › 掲載 in http mode (#89), as NIHO keeps the experience-site listing: none, or withdrawn, reads 未申請. */
export const SITE_LISTING_STATUS: Record<ExperienceSiteListingStatus | "NONE", StatusLabel> = {
  NONE: { label: "未申請", tone: "draft" },
  REQUESTED: { label: "審査待ち", tone: "wait" },
  ACTIVE: { label: "掲載中", tone: "ok" },
  PAUSED: { label: "停止中", tone: "stop" },
  WITHDRAWN: { label: "未申請", tone: "draft" },
};

/** 体験の一覧 in http mode (provider operations on): NIHO's page itself, beside the preview's listing states. */
export const PROVIDER_PAGE_STATUS: Record<ExperienceProviderPageListItem["status"], StatusLabel> = {
  DRAFT: LISTING_STATUS.draft,
  PUBLISHED: { label: "公開中", tone: "ok" },
  UNPUBLISHED: LISTING_STATUS.paused,
};

/** The English of a page written in Japanese (#110): 未作成 / 下書き / 確定済み / 古い (the Japanese changed since). */
export const PAGE_ENGLISH_STATUS: Record<PageEnglishStatus, StatusLabel> = {
  none: { label: "未作成", tone: "draft" },
  draft: { label: "下書き", tone: "draft" },
  confirmed: { label: "確定済み", tone: "ok" },
  stale: { label: "古い", tone: "wait" },
};

export const BOOKING_STATUS: Record<HostBookingStatus, StatusLabel> = {
  pending: { label: "承認待ち", tone: "wait" },
  confirmed: { label: "確定", tone: "ok" },
  refund_needed: { label: "要返金", tone: "wait" },
  cancelled: { label: "取消済み", tone: "stop" },
  declined: { label: "お断り", tone: "draft" },
  expired: { label: "期限切れ", tone: "draft" },
  payment_review: { label: "確認待ち", tone: "wait" },
};

/** A booking whose day has passed stays 確定, in the quiet tone (mock v2). */
export const PAST_CONFIRMED_BOOKING: StatusLabel = { label: "確定", tone: "draft" };

/** A thread whose last word is the guest's (メッセージ, #106). */
export const THREAD_WAITING: StatusLabel = { label: "返信待ち", tone: "wait" };

/** A guest's review (#108): NIHO checks it before it is published. */
export const REVIEW_STATUS: Record<HostReviewStatus, StatusLabel> = {
  pending: { label: "公開前", tone: "wait" },
  published: { label: "公開中", tone: "ok" },
};

/** A published review the host has not replied to (ホーム). Replying is the host's choice: the quiet tone. */
export const REVIEW_UNREPLIED: StatusLabel = { label: "未返信", tone: "draft" };

/** A part NIHO cannot keep yet (設定's カレンダー・通知 in http mode): shown, but not to be filled in. */
export const PREPARING_STATUS: StatusLabel = { label: "準備中", tone: "draft" };

/** The provider's own review, shown beside 設定 › 提供者情報 (NIHO's provider screen calls SUSPENDED 確認が必要). */
export const PROVIDER_REVIEW_STATUS: Record<HostProviderReviewStatus, StatusLabel> = {
  DRAFT: { label: "未申請", tone: "draft" },
  REQUESTED: { label: "審査待ち", tone: "wait" },
  APPROVED: { label: "審査済み", tone: "ok" },
  SUSPENDED: { label: "確認が必要", tone: "stop" },
};

/** The payout account's state beside 設定 › 売上受取口座. */
export function payoutStatus(reason: PaymentReadinessReason): StatusLabel {
  if (reason === "READY") return { label: "準備済み", tone: "ok" };
  if (reason === "NOT_CONNECTED") return { label: "未接続", tone: "wait" };
  return { label: "確認が必要", tone: "wait" };
}
