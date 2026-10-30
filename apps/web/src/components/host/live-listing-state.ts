import type { ExperienceProviderPageDetail, ExperienceProviderPageListing, ExperienceProviderPageListingResponse, ExperienceProviderPagePublishBlocker } from "@niho-experience/api-client/host";
import { SITE_LISTING_STATUS, type StatusLabel } from "@/host/status";
import type { HostProviderReviewStatus } from "@/lib/host/providers";

/*
 * 体験の編集 › 掲載 (#89, OWNER): the page's one listing on the experience site as NIHO keeps it
 * (`/pages/{pageId}/experience-site-listing`). Only a published English page can be listed; 申請
 * publishes the saved page first when it is not, then sends the consent version NIHO showed.
 */

export const LISTING_TEXT = {
  requested: "掲載を申請しました。NIHO が確認します。",
  withdrawn: "申請を取り下げました。",
  stopped: "掲載を止めました。",
  consentOutdated: "同意の文言が新しくなりました。確認してからもう一度申請してください。",
  notEligible: "体験サイトに載せられるのは、公開中の英語の体験ページだけです。",
  changed: "掲載の状態が変わりました。最新の状態を確認してください。",
  requestUncertain: "申請の結果を確認できません。再送せず、最新の状態を確認してください。",
  withdrawUncertain: "取り下げの結果を確認できません。再送せず、最新の状態を確認してください。",
  unreadable: "掲載の状態を読めませんでした。",
} as const;

export type LiveListingView =
  /** 未申請 (or a page no longer published): 申請, unless the page is not English or not ready to publish. A listing still waiting or stopped can be withdrawn. */
  | { kind: "request"; block: "language" | "blockers" | null; withdrawable: boolean }
  | { kind: "requested" }
  /** `href` once NIHO has given the listing its slug. */
  | { kind: "active"; href: string | null }
  | { kind: "paused" };

type ListingPage = Pick<ExperienceProviderPageDetail, "status" | "language" | "publishBlockers">;

/** 公開前に確認が必要です: what NIHO's publish blockers ask of the host, never the code itself. */
export const PUBLISH_BLOCKER_TEXT: Record<ExperienceProviderPagePublishBlocker, string> = {
  TITLE_REQUIRED: "題名を入れてください。",
  COVER_REQUIRED: "表紙の写真を追加してください。",
  OFFER_PRICE_REQUIRED: "商品の料金を入れてください。",
  PRICE_BELOW_MINIMUM: "料金は 50 円以上にしてください。",
  OFFER_CAPACITY_REQUIRED: "商品の定員を入れてください。",
  OFFER_WEEKDAYS_REQUIRED: "開催曜日を選んでください。",
  OFFER_START_REQUIRED: "開始時刻を入れてください。",
  OFFER_DURATION_REQUIRED: "所要時間を入れてください。",
  OFFER_ACTIVE_REQUIRED: "受付する商品を 1 つ以上にしてください。",
  OFFER_SCHEDULE_CONFLICT: "商品どうしの開催時間が重ならないようにしてください。",
  OFFER_ZONE_INVALID: "商品の利用範囲を確認してください。",
  STRIPE_NOT_READY: "設定で売上受取口座の準備を済ませてください。",
  OPS_EMAIL_REQUIRED: "予約の通知先メールが未設定です。NIHO サポートへご連絡ください。",
};

export function publishBlockerText(blocker: string): string {
  return PUBLISH_BLOCKER_TEXT[blocker as ExperienceProviderPagePublishBlocker] ?? "NIHO で確認が必要な項目があります。";
}

/** The pill: 未申請 (none or withdrawn) / 審査待ち / 掲載中 / 停止中. */
export function liveListingStatus(listing: ExperienceProviderPageListing | null): StatusLabel {
  return SITE_LISTING_STATUS[listing?.status ?? "NONE"];
}

/** What the panel offers for the listing and the saved page. */
export function liveListingView(listing: ExperienceProviderPageListing | null, page: ListingPage, siteUrl: string): LiveListingView {
  const status = listing?.status ?? "WITHDRAWN";
  if (status === "ACTIVE") return { kind: "active", href: listing?.slug ? `${siteUrl}/experiences/${encodeURIComponent(listing.slug)}` : null };
  if (status === "WITHDRAWN" || page.status !== "PUBLISHED") {
    const block = page.language !== "EN" ? "language" : page.publishBlockers.length ? "blockers" : null;
    return { kind: "request", block, withdrawable: status === "REQUESTED" || status === "PAUSED" };
  }
  return status === "REQUESTED" ? { kind: "requested" } : { kind: "paused" };
}

/** The provider's own review, when it is not 審査済み: one line, and whether 設定 is where to act. */
export function providerReviewLine(reviewStatus: HostProviderReviewStatus | null): { text: string; link: string | null } | null {
  if (reviewStatus === "DRAFT") return { text: "提供者の審査をまだ申請していません。", link: "設定で審査を申請" };
  if (reviewStatus === "REQUESTED") return { text: "提供者の審査を NIHO が確認しています。", link: null };
  if (reviewStatus === "SUSPENDED") return { text: "提供者情報の確認が必要です。", link: "設定で確認" };
  return null;
}

/**
 * A refused or unanswered 申請 (the publish before it included) / 取り下げ. `uncertain`: nothing is
 * resent until the latest state is read; `reload`: the listing (and the page) are read again.
 */
export type ListingRefusal = { kind: "uncertain" | "reload" | "error"; tone: "error" | "notice"; text: string };
export function listingRefusal(step: "request" | "withdraw", status: number, error: string | null): ListingRefusal {
  if (status === 0 || status >= 500) return { kind: "uncertain", tone: "error", text: step === "request" ? LISTING_TEXT.requestUncertain : LISTING_TEXT.withdrawUncertain };
  if (error === "EXPERIENCE_LISTING_CONSENT_OUTDATED") return { kind: "reload", tone: "notice", text: LISTING_TEXT.consentOutdated };
  if (error === "EXPERIENCE_LISTING_PAGE_NOT_ELIGIBLE") return { kind: "reload", tone: "error", text: LISTING_TEXT.notEligible };
  if (status === 409) return { kind: "reload", tone: "error", text: LISTING_TEXT.changed };
  if (status === 401) return { kind: "error", tone: "error", text: "ログインの有効期限が切れました。" };
  if (status === 403 || status === 404) return { kind: "error", tone: "error", text: "この体験を操作する権限が終了しています。" };
  if (status === 422) return { kind: "error", tone: "error", text: "公開前に確認が必要な項目があります。" };
  return { kind: "error", tone: "error", text: step === "request" ? "申請できませんでした。" : "取り下げられませんでした。" };
}

/** The listing BFF's answer, or null when it is not that shape. */
export function readListingResponse(value: unknown): ExperienceProviderPageListingResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const { listing, consent } = value as { listing?: unknown; consent?: unknown };
  if (typeof consent !== "object" || consent === null) return null;
  const { version, text } = consent as { version?: unknown; text?: unknown };
  if (typeof version !== "string" || !version || typeof text !== "string") return null;
  if (listing !== null && (typeof listing !== "object" || !["REQUESTED", "ACTIVE", "PAUSED", "WITHDRAWN"].includes((listing as { status?: unknown }).status as string))) return null;
  return value as ExperienceProviderPageListingResponse;
}
