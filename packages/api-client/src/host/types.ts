// ホスト API の型の別名。正は src/generated/host-openapi.ts（NIHO の書き出したホスト契約から生成）。
// schema 名は NIHO 側の命名（`ExperienceProvider*`）。画面はこの別名だけを使い、契約の名前の変更に追従しない。
import type { components, operations } from "../generated/host-openapi.ts";

type Schemas = components["schemas"];

export type ExperienceHostAuthMe = Schemas["ExperienceHostAuthMe"];
export type ExperienceProvider = Schemas["ExperienceProvider"];
export type ExperienceProviderWithMemberRole = Schemas["ExperienceProviderWithMemberRole"];
export type ExperienceProviderKind = Schemas["ExperienceProviderKind"];
export type ExperienceProviderMemberRole = Schemas["ExperienceProviderMemberRole"];
export type ExperienceProviderReviewStatus = Schemas["ExperienceProviderReviewStatus"];
export type ExperienceProviderConsent = Schemas["ExperienceProviderConsent"];
export type ExperienceProviderListResponse = Schemas["ExperienceProviderListResponse"];
export type ExperienceProviderDetailResponse = Schemas["ExperienceProviderDetailResponse"];
export type ExperienceProviderRegisterRequest = Schemas["ExperienceProviderRegisterRequest"];
export type ExperienceProviderRegisterResponse = Schemas["ExperienceProviderRegisterResponse"];
export type ExperienceProviderUpdateRequest = Schemas["ExperienceProviderUpdateRequest"];
export type ExperienceProviderResponse = Schemas["ExperienceProviderResponse"];
export type ExperienceProviderSubmitResponse = Schemas["ExperienceProviderSubmitResponse"];
export type ExperienceProviderPaymentReadinessReason = Schemas["ExperienceProviderPaymentReadinessReason"];
export type ExperienceProviderPaymentReadinessResponse = Schemas["ExperienceProviderPaymentReadinessResponse"];
export type ExperienceProviderPaymentReuseCandidate = Schemas["ExperienceProviderPaymentReuseCandidate"];
export type ExperienceProviderPaymentReuseCandidatesResponse = Schemas["ExperienceProviderPaymentReuseCandidatesResponse"];
export type ExperienceProviderPaymentReuseRequest = Schemas["ExperienceProviderPaymentReuseRequest"];
export type ExperienceProviderPaymentConnectResponse = Schemas["ExperienceProviderPaymentConnectResponse"];

// 失敗の本文（閉じた形）。`details` は理由ごとの組の oneOf。
export type ExperienceHostErrorResponse = Schemas["ExperienceHostErrorResponse"];
export type ExperienceHostErrorBody = Schemas["ExperienceHostError"];
export type ExperienceHostErrorCode = Schemas["ExperienceHostErrorCode"];
export type ExperienceHostErrorDetails = Schemas["ExperienceHostErrorDetails"];
export type ExperienceHostErrorReason = Schemas["ExperienceHostErrorReason"];

// 集合場所（提供者の既定・体験ページの上書き）
export type ExperienceProviderMeetingPoint = Schemas["ExperienceProviderMeetingPoint"];
export type ExperienceProviderMeetingPointResponse = Schemas["ExperienceProviderMeetingPointResponse"];
export type ExperienceProviderPageMeetingPointMode = Schemas["ExperienceProviderPageMeetingPointMode"];
export type ExperienceProviderPageMeetingPointResponse = Schemas["ExperienceProviderPageMeetingPointResponse"];
export type ExperienceProviderPageMeetingPointUpdateRequest = Schemas["ExperienceProviderPageMeetingPointUpdateRequest"];
export type ExperienceProviderPageMeetingPointUpdateResponse = Schemas["ExperienceProviderPageMeetingPointUpdateResponse"];

// 体験ページ（NIHO の拠点の企画ページと同じ項目。schema 名の `AdminCampaignPage*`・`SpotCampaignPage*` は NIHO 側の命名）
export type ExperienceProviderPageKind = Schemas["SpotCampaignPageKind"];
export type ExperienceProviderPageLanguage = Schemas["SpotCampaignPageLanguage"];
export type ExperienceProviderPageStatus = Schemas["SpotCampaignPageStatus"];
export type ExperienceProviderPagePublishBlocker = Schemas["SpotCampaignPagePublishBlocker"];
export type ExperienceProviderPageListResponse = Schemas["AdminCampaignPageListResponse"];
export type ExperienceProviderPageListItem = Schemas["AdminCampaignPageListItem"];
export type ExperienceProviderPageBookingCounts = Schemas["AdminCampaignPageBookingCounts"];
export type ExperienceProviderPageCreateRequest = Schemas["AdminCampaignPageCreateRequest"];
export type ExperienceProviderPageDeleteResponse = Schemas["AdminCampaignPageDeleteResponse"];
export type ExperienceProviderPageDetail = Schemas["ExperienceProviderPageDetail"];
export type ExperienceProviderPagePhoto = Schemas["AdminCampaignPagePhoto"];
export type ExperienceProviderPageContent = Schemas["SpotCampaignPageExperienceContent"];
export type ExperienceProviderPageTimelineItem = Schemas["SpotCampaignPageTimelineItem"];
export type ExperienceProviderPagePatchRequest = Schemas["ExperienceProviderPagePatchRequest"];
export type ExperienceProviderPageContentInput = Schemas["ExperienceProviderPageContentInput"];
export type ExperienceProviderPageOffer = Schemas["SpotCampaignPageOffer"];
export type ExperienceProviderPageOfferPatch = Schemas["SpotCampaignPageOfferPatch"];
export type ExperienceProviderPageCancellationPolicy = Schemas["SpotCampaignPageCancellationPolicy"];
export type ExperienceProviderPageAcceptanceMode = Schemas["SpotCampaignPageAcceptanceMode"];
export type ExperienceProviderPageBookingQuestion = Schemas["SpotCampaignPageBookingQuestion"];
export type ExperienceProviderPageBookingQuestionInput = Schemas["SpotCampaignPageBookingQuestionInput"];
export type ExperienceProviderPageBookingQuestionInputType = Schemas["SpotCampaignPageBookingQuestionInputType"];
export type ExperienceProviderPageBookingQuestionOption = Schemas["SpotCampaignPageBookingQuestionOption"];
export type ExperienceProviderPageBookingQuestionOptionInput = Schemas["SpotCampaignPageBookingQuestionOptionInput"];

// 体験ページのプレビュー（NIHO の公開ページと同じ組み立て）
export type ExperienceProviderPagePreviewResponse = Schemas["ExperienceProviderPagePreviewResponse"];
export type ExperienceProviderPagePreviewPage = Schemas["PublicLivingCampaignPage"];
export type ExperienceProviderPagePreviewContent = Schemas["PublicLivingCampaignPageContent"];
export type ExperienceProviderPagePreviewTimelineItem = Schemas["PublicLivingCampaignPageTimelineItem"];
export type ExperienceProviderPagePreviewPhoto = Schemas["PublicLivingCampaignPagePhoto"];
export type ExperienceProviderPagePreviewHost = Schemas["PublicLivingCampaignPageHost"];
export type ExperienceProviderPagePreviewSpot = Schemas["ExperienceProviderPagePreviewSpot"];
export type ExperienceProviderPagePreviewOffer = Schemas["ExperienceProviderPagePreviewOffer"];
export type ExperienceProviderPagePreviewOfferSummary = Schemas["ExperienceProviderPagePreviewOfferSummary"];
export type ExperienceProviderPagePreviewOccurrence = Schemas["ExperienceProviderPagePreviewOccurrence"];

// 体験サイトへの掲載
export type ExperienceSiteListingStatus = Schemas["ExperienceSiteListingStatus"];
export type ExperienceProviderPageListing = Schemas["ExperienceProviderPageListing"];
export type ExperienceProviderPageListingResponse = Schemas["ExperienceProviderPageListingResponse"];
export type ExperienceProviderPageListingConsent = Schemas["AdminExperienceSiteListingConsent"];
export type ExperienceProviderPageListingRequest = Schemas["AdminExperienceSiteListingRequestBody"];

// 写真（提供者の上げ口）
export type ExperienceProviderUploadPolicyRequest = Schemas["ExperienceProviderUploadPolicyRequest"];
export type ExperienceProviderUploadPolicyResponse = Schemas["ExperienceProviderUploadPolicyResponse"];
export type ExperienceProviderUploadPolicyFields = Schemas["ExperienceProviderUploadPolicyFields"];
export type ExperienceProviderUploadSignedUrlRequest = Schemas["UploadSignedUrlRequest"];
export type ExperienceProviderUploadSignedUrlResponse = Schemas["UploadSignedUrlResponse"];
export type ExperienceProviderPhotoContentType = ExperienceProviderUploadPolicyRequest["contentType"];

/**
 * 写真の上げ方: このサイトのサーバーが `createExperienceProviderUploadPolicy` で受け取った値のうち、ブラウザへ渡すもの
 * （署名つき POST は ID token を持たないので、ブラウザから GCS へ直接送ってよい）。ブラウザは `fields` を**全部そのまま**
 * multipart/form-data に入れ、最後に `file`（`EXPERIENCE_PROVIDER_PHOTO_FILE_FIELD`）を足して `url` へ POST する。
 * 送れたら `objectKey` を体験ページの `photoObjectKeys` に入れて保存する。`expiresAt` を過ぎたら発行し直す。
 * 型だけなので、ブラウザのコードからも `import type` できる。
 */
export type ExperienceProviderPhotoUploadForm = {
  url: string;
  fields: ExperienceProviderUploadPolicyFields;
  objectKey: string;
  expiresAt: string;
  maxSizeBytes: number;
};

export type ExperienceHostOperationId = keyof operations;

export const EXPERIENCE_PROVIDER_KINDS: readonly ExperienceProviderKind[] = ["INDIVIDUAL", "BUSINESS"];
/** Canonical role enum is experience-provider-operations v1.0.0; the host draft reuses it for page access. */
export const EXPERIENCE_PROVIDER_MEMBER_ROLES: readonly ExperienceProviderMemberRole[] = ["OWNER", "EDITOR", "COHOST"];
export const EXPERIENCE_PROVIDER_REVIEW_STATUSES: readonly ExperienceProviderReviewStatus[] = ["DRAFT", "REQUESTED", "APPROVED", "SUSPENDED"];
export const EXPERIENCE_PROVIDER_PAYMENT_READINESS_REASONS: readonly ExperienceProviderPaymentReadinessReason[] = [
  "NOT_CONNECTED",
  "VERIFICATION_REQUIRED",
  "CHARGES_DISABLED",
  "PAYOUTS_DISABLED",
  "RESTRICTED",
  "READY",
];

export const EXPERIENCE_PROVIDER_PAGE_PUBLISH_BLOCKERS: readonly ExperienceProviderPagePublishBlocker[] = [
  "TITLE_REQUIRED",
  "COVER_REQUIRED",
  "OFFER_PRICE_REQUIRED",
  "PRICE_BELOW_MINIMUM",
  "OFFER_CAPACITY_REQUIRED",
  "OFFER_WEEKDAYS_REQUIRED",
  "OFFER_START_REQUIRED",
  "OFFER_DURATION_REQUIRED",
  "OFFER_ACTIVE_REQUIRED",
  "OFFER_SCHEDULE_CONFLICT",
  "OFFER_ZONE_INVALID",
  "STRIPE_NOT_READY",
  "OPS_EMAIL_REQUIRED",
];

/** 写真の上げ口が受け付ける形式と 1 枚の上限（契約の ExperienceProviderUploadPolicyRequest と同じ）。 */
export const EXPERIENCE_PROVIDER_PHOTO_CONTENT_TYPES: readonly ExperienceProviderPhotoContentType[] = ["image/jpeg", "image/png", "image/webp"];
export const EXPERIENCE_PROVIDER_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
/** 署名つき POST の form で、写真のファイルを入れる項目の名前（`fields` の後に足す）。 */
export const EXPERIENCE_PROVIDER_PHOTO_FILE_FIELD = "file";

/** 体験ページの保存・公開で、読んだときの `updatedAt` を送る header（違えば 409 `PAGE_UPDATED`）。 */
export const EXPERIENCE_PROVIDER_PAGE_UPDATED_AT_HEADER = "x-niho-page-updated-at";

/** `error.code`（契約の ExperienceHostErrorCode と同じ並び。test が契約と照合する）。 */
export const EXPERIENCE_HOST_ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "ACCOUNT_DELETED",
  "NOT_FOUND",
  "CONFLICT",
  "UNPROCESSABLE_ENTITY",
  "SERVICE_UNAVAILABLE",
] as const satisfies readonly ExperienceHostErrorCode[];

/**
 * `error.details.reason`（契約の ExperienceHostErrorReason と同じ並び。test が契約と照合する）。どの操作がどの理由を返すかは
 * 契約の各操作の説明に書かれている。NIHO が契約に無い理由を返すこともあるので、クライアントは文字列のまま渡す
 * （画面は知っている理由だけで分岐する）。
 */
export const EXPERIENCE_HOST_ERROR_REASONS = [
  "invalid_token",
  "anonymous_provider_not_allowed",
  "directory_only_account",
  "app_connect_disabled",
  "app_connection_revoked",
  "user_not_found",
  "app_client_scope",
  "auth_user_lookup_failed",
  "app_connection_lookup_failed",
  "PROVIDER_CONSENT_OUTDATED",
  "PROVIDER_EMAIL_REQUIRED",
  "PROVIDER_REVIEW_STATE_CONFLICT",
  "PROVIDER_NOT_FOUND",
  "PROVIDER_PAYMENT_SOURCE_FORBIDDEN",
  "PROVIDER_PAYMENT_LOCKED",
  "PROVIDER_PAYMENT_CONSENT_OUTDATED",
  "PROVIDER_PAYMENT_SOURCE_NOT_READY",
  "PROVIDER_CONNECT_UNAVAILABLE",
  "PROVIDER_PAYMENT_SHARED_ACCOUNT",
  "PROVIDER_PAYMENT_NOT_CONNECTED",
  "PROVIDER_PAGE_NOT_FOUND",
  "PROVIDER_PAGE_CONFLICT",
  "PAGE_REQUEST_INVALID",
  "PAGE_TITLE_INVALID",
  "PAGE_SLUG_INVALID",
  "PAGE_CONTENT_INVALID",
  "PAGE_PHOTOS_INVALID",
  "PAGE_OFFER_INVALID",
  "PAGE_OFFER_QUESTIONS_INVALID",
  "PAGE_NOT_FOUND",
  "PAGE_SLUG_TAKEN",
  "PAGE_SLUG_LOCKED",
  "PAGE_UPDATED",
  "PAGE_OFFER_HAS_BOOKINGS",
  "PAGE_NOT_PUBLISHED",
  "PAGE_DELETE_PUBLISHED",
  "PAGE_DELETE_HAS_BOOKINGS",
  "PAGE_PUBLISH_BLOCKED",
  "EXPERIENCE_LISTING_NOT_FOUND",
  "EXPERIENCE_LISTING_CONSENT_OUTDATED",
  "EXPERIENCE_LISTING_PAGE_NOT_ELIGIBLE",
  "EXPERIENCE_LISTING_STATUS_CONFLICT",
  "uploads_disabled",
  "upload_expired",
  "object_missing",
  "object_lookup_failed",
  "signing_circuit_open",
  "signing_transient_failure",
] as const satisfies readonly ExperienceHostErrorReason[];

// 並びの漏れを型で検出する（契約に理由・コードが増えたら、ここで型検査が失敗する）。
type ListsEvery<Missing extends never> = Missing;
type _EveryHostErrorCodeListed = ListsEvery<Exclude<ExperienceHostErrorCode, (typeof EXPERIENCE_HOST_ERROR_CODES)[number]>>;
type _EveryHostErrorReasonListed = ListsEvery<Exclude<ExperienceHostErrorReason, (typeof EXPERIENCE_HOST_ERROR_REASONS)[number]>>;
