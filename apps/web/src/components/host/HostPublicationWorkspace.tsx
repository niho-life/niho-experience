"use client";

import Link from "next/link";
import { ProductMemberSelection } from "./ProductMemberSelection";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HOST_SURFACE, consoleButtonClass } from "./host-ui";
import { MapboxLocationMap, type MapArea, type MapCoordinate } from "@/components/MapboxLocationMap";
import { HostPageBody, PageHead } from "./ui";
import { HostSharedPhotoOffer } from "./HostSharedPhoto";
import { HostConfirmDialog } from "./HostConfirmDialog";
import { HostErrorMessage } from "./HostProviderRequired";
import { withProvider } from "@/lib/host/routes";
import { PROVIDER_REQUIRED_CODE, PROVIDER_REQUIRED_MESSAGE, hostApiPath } from "@/lib/host/api-path";
import {
  asPublicationPrice,
  publicationTermsForm,
  publicationTermsPayload,
  withBlankOfferPricesFilled,
  type PublicationTermsForm,
} from "./publication-terms";
import { publicationBlockerDestination, publicationCanPublish, publicationNextAction } from "./publication-workflow";
import { HostPublicationStages } from "./HostPublicationStages";
import { PUBLICATION_ACTION_NOTICE, PUBLICATION_ACTION_PATH, SECTION_NEED_LABEL, publicationConfirmCopy, publicationStages, splitBlockers, type PublicationAction, type SectionNeed } from "./publication-stages";
import { canonicalPublicationJson as canonicalJson, confirmPublicationEnglish, englishIsConfirmed, englishPublicationManuscript, liveEnglishStaleNote, publicationManuscriptFingerprint } from "./publication-confirmation";
import { photoRightsConfirmed, type PhotoRightsConfirmation } from "./photo-rights";
import { reapplyProviderMediaEdits } from "./publication-conflict";
import { HostBookingLinkCopy } from "./HostBookingLinkCopy";
import { providerBookingLinkAvailable } from "@/lib/provider-booking-link";
import { ProductClassificationFields, useProductClassification } from "./ProductClassificationPanel";
import { HostInfoTip } from "./HostInfoTip";
import { EDITOR_INPUT, EditorCheckList, EditorChoice, EditorDialog, EditorField, EditorReference, EditorRows, EditorSubheading, EditorSwitch, EditorUnitField } from "./HostEditorParts";
import { BLANK_JAPANESE_MANUSCRIPT, fillUnlistedAlt, languageSyncFollower, languageSyncOutOfSync, manuscriptHasContent, publicationEnglishTitle, publicationListing, readLanguageSync, savedLanguageSync, withLanguageSync, withPublicationListing, withoutEmptyRows, type PublicationListing } from "./publication-language";
import { publicationSlugFromTitle, publicationSlugRetry } from "./publication-slug";
import { PUBLICATION_FAQ_LIMITS, publicationContentFaqProblem, publicationFaqProblem, publicationFaqRows, withPublicationFaq, type PublicationFaqRow } from "./publication-faq";

type Status = "DRAFT" | "PUBLISHED" | "STOPPED" | "RESTART_REQUIRED" | "SUSPENDED";
type SaleTerms = {
  offerPrices?: readonly { offerId: string; adultPriceYen: number }[] | null;
  childPricing: { priceYen: number; minAge: number; maxAge: number; adultRequired: boolean } | null;
  minimumParticipants: number;
  minimumChargeableParticipants: number;
  maxPartySize: number;
  cancellationPolicy: "FREE_UNTIL_24H" | "FREE_UNTIL_48H" | "NONE" | "CUSTOM";
  cancellationWindowMinutesBeforeStart: number | null;
  cancellationRefundBasisPoints: number;
  minimumAttendance: number | null;
  bookingQuestions: readonly unknown[];
  conditionsVersion: string | null;
  version: number;
  updatedAtUtc: string;
};
type Media = { id: string; position: number; sourcePosition: number; placement: "GALLERY"; width: number; height: number; byteSize: number; altText: string; altTextJa: string; publicCredit: string | null; previewUrl: string };
type ProviderMedia = { id: string; placement: "PROVIDER_PHOTO" | "BUSINESS_LOGO"; width: number; height: number; byteSize: number; altText: string; altTextJa: string; publicCredit: string | null; previewUrl: string };
type Product = {
  id: string;
  version: string;
  status: Status;
  publicationNeedsUpdate: boolean;
  publicationBlockers: string[];
  /** The same reasons split in two (#705): what stops the public page, and what only stops bookings from opening. */
  pageBlockers?: string[];
  bookingBlockers?: string[];
  /** Bookings are actually being taken (a booking version, and not stopped or suspended). */
  bookingOpen?: boolean;
  acceptanceMode?: "INSTANT" | "APPROVAL";
  adminEnglishReview?: {
    reviewed: boolean;
    reviewedAtUtc: string | null;
    contentFingerprint: string;
    japaneseFingerprint: string | null;
    englishFingerprint: string | null;
  };
  draft: { slug: string; publicTitle: string; content: Record<string, unknown>; currency: "JPY"; unitAmount: number };
  sellerDisplayName: string | null;
  saleTerms: SaleTerms | null;
  salesPlan: {
    current: { revision: number; plan: "MANAGED_20" | "SUPPORTED_15" | "INDEPENDENT_10"; feeBasisPoints: 1000 | 1500 | 2000; agreementVersion: string };
    phase: "ACTIVE" | "EXPIRING_OLD_CHECKOUTS" | "RECONCILING";
    pending: { revision: number; plan: "SUPPORTED_15" | "INDEPENDENT_10"; feeBasisPoints: 1000 | 1500; agreementVersion: string } | null;
    transitionCommandId: string | null;
    version: number;
  } | null;
  ownerSalesPlanAgreementVersion: string | null;
  offers: { id: string; localStartTime: string; durationMinutes: number; capacity: number; recurrence: { kind: string; weekdays?: readonly string[] } }[];
  media: Media[];
};
type ProductResponse = { product: Product; publicationConsentVersion?: string; managedSalesAvailable?: boolean };
type TimelineItem = { time: string; title: string; text: string; photoIndex: number | null };
type LocaleManuscript = { title: string; lead: string; description: string; language: string; highlights: string[]; included: string[]; notIncluded: string[]; knowBeforeYouGo: string[]; notSuitableFor: string[]; timeline: TimelineItem[]; faq?: PublicationFaqRow[] };
type Props = {
  membersProviderId?: string;
  /**
   * The host this screen is for (#709). Sent as `?providerId=` on every host API call (lib/host/api-path.ts), so an owner of two
   * or more hosts never gets 409. Not set in admin-draft (the admin API names the provider in its path).
   */
  providerId?: string | null;
  productId?: string;
  create?: boolean;
  bookingGuideHref?: string;
  paymentConsentHref?: string;
  /** The button to the payment consent: NIHO's page by default; 設定 › 受取口座 with Experience host accounts. */
  paymentConsentLabel?: string;
  mode?: "host" | "admin-draft";
  apiBase?: string;
  experiencesBase?: string;
  createHref?: string;
  /** 予約リンクをコピー (#531): the public site's origin the copied link points to; without it the button is not shown. */
  publicSiteOrigin?: string;
  /** 自分のサイトに貼る (#638): EXPERIENCE_EMBED_ENABLED, read on the server. Off by default and never in admin-draft. */
  embedEnabled?: boolean;
};

const blankContent = {
  lead: "", description: "", facts: { language: "" }, highlights: [], included: [], notIncluded: [],
  knowBeforeYouGo: [], notSuitableFor: [], timeline: [], meetingOverview: null,
  meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null, publicMapPoint: null, publicMapArea: null,
};
const blankJapanese: LocaleManuscript = { title: "", lead: "", description: "", language: "", highlights: [], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [] };
const emptyTerms = publicationTermsForm(null, []);
const STATUS_COPY: Record<Status, string> = { DRAFT: "下書き", PUBLISHED: "公開中", STOPPED: "停止中", RESTART_REQUIRED: "再公開が必要", SUSPENDED: "運営停止中" };
const readError: Record<string, string> = {
  [PROVIDER_REQUIRED_CODE]: PROVIDER_REQUIRED_MESSAGE,
  SESSION_ENDED: "ログイン状態が切れました。入力はこのブラウザーに保持しています。再ログインして再読み込みしてください。",
  SESSION_REFRESH_REQUIRED: "ログイン状態を更新できませんでした。入力を保持しました。再読み込みしてください。",
  FORBIDDEN: "この商品を操作する権限がありません。入力は保持しています。",
  SELLER_SETUP_REQUIRED: "販売者または受取口座の設定を完了してから商品を保存してください。入力は保持しています。",
  SELLER_PROFILE_AMBIGUOUS: "販売者の選択が必要です。NIHO側の本人情報を確認してください。入力は保持しています。",
  OPERATIONS_SUSPENDED: "運営がこの商品の販売を停止しています。運営停止は本人の操作では解除できません。入力は保持しています。",
  PUBLICATION_BLOCKED: "公開条件を満たしていません。必要項目と開催枠を確認してください。",
  VERSION_CONFLICT: "別の更新が先に保存されました。最新状態を確認できます。入力は保持しています。",
  UNAVAILABLE: "保存結果を確認できませんでした。入力は保持しています。最新状態を読み直してから続けてください。",
  TRANSLATION_UNAVAILABLE: "英語案を作成できませんでした。入力はそのまま保持しています。",
  PAYOUT_CHECK_UNAVAILABLE: "Stripeで販売者の受取口座を確認できませんでした。時間をおいて再度お試しください。",
};

const BLOCKER_COPY: Record<string, string> = {
  ACCOUNT_NOT_USABLE: "ログインしているアカウントが利用できる状態か確認してください。",
  CANCELLATION_TERMS_REQUIRED: "取消期限と返金割合を入力してください。",
  CONNECT_NOT_READY: "販売者の受取口座を確認してください。",
  CONSENT_OUTDATED: "掲載条件が更新されました。最新の条件を確認して公開してください。",
  FEE_SETTINGS_REQUIRED: "運営側の手数料設定が完了するまで公開できません。",
  SUPPORT_CONSENT_REQUIRED: "NIHOサポートの利用範囲と合計手数料を確認し、現在の条件に同意してください。",
  MANUSCRIPT_REQUIRED: "日本語原稿と確認済みの英語原稿を完成させてください（日本語のみで公開する場合は、日本語原稿を完成させてください）。",
  NOTIFICATION_ADDRESS_REQUIRED: "設定の通知で、連絡用メールアドレスを確認してください。確認のメールのリンクを開くと、公開できます。",
  OPERATIONS_SUSPENDED: "運営停止中のため再開できません。",
  PROVIDER_SUSPENDED: "運営がこのホストの公開と受付を止めています。運営が解除するまで、公開も再開もできません。",
  OWNER_NOT_CURRENT: "最新のOWNER権限を確認できません。ログインし直してください。",
  PAYMENT_REUSE_CONSENT_REQUIRED: "受取口座で売上を受け取ることへの同意を確認してください。",
  PHOTOS_REQUIRED: "商品写真を追加し、日本語と英語の説明を入力してください。",
  PRICE_REQUIRED: "有効な商品価格を入力してください。",
  PUBLIC_CONTENT_INVALID: "公開原稿の入力内容を確認してください。",
  READINESS_EXPIRED: "販売者と受取口座の確認が期限切れです。販売者本人がHost画面で最新状態を確認した後、再度読み込んでください。",
  READINESS_MISSING: "販売者の最新状態を確認できません。販売者本人がHost画面で最新状態を確認した後、再度読み込んでください。",
  SCHEDULE_REQUIRED: "販売できる開催枠をカレンダーに追加してください。",
  SELLER_MISMATCH: "販売者情報と受取口座が、登録されている販売者と一致しません。",
  SELLER_REQUIRED: "予約を受けるには、受取口座の登録が必要です。",
  SLUG_IN_USE: "この公開URLはすでに使われています。別のURLを入力してください。",
};

function apiErrorMessage(body: unknown, status: number): string {
  const error = typeof body === "object" && body !== null && "error" in body ? (body as { error?: unknown }).error : null;
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "PUBLICATION_BLOCKED" && typeof error === "object" && error !== null && "blockers" in error && Array.isArray((error as { blockers: unknown }).blockers)) {
    const blockers = ((error as { blockers: unknown[] }).blockers).filter((item): item is string => typeof item === "string");
    const details = blockers.map((item) => BLOCKER_COPY[item]).filter(Boolean);
    if (details.length) return details.join(" ");
  }
  return readError[code] ?? (status === 404 ? "商品が見つかりません。" : "処理できませんでした。入力を保持しています。時間をおいて再試行してください。");
}
function writeOutcomeNeedsReconciliation(status: number): boolean {
  return status === 408 || status === 409 || status >= 500;
}

function contentFrom(product: Product): Record<string, unknown> {
  return {
    ...blankContent, ...product.draft.content,
    facts: { ...blankContent.facts, ...(isRecord(product.draft.content.facts) ? product.draft.content.facts : {}) },
    ja: { ...blankJapanese, ...(isRecord(product.draft.content.ja) ? product.draft.content.ja : {}) },
    timeline: Array.isArray(product.draft.content.timeline) ? product.draft.content.timeline : [],
    translation: isRecord(product.draft.content.translation) ? product.draft.content.translation : { sourceFingerprint: null, confirmedSourceFingerprint: null },
  };
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function mapCoordinate(value: unknown): MapCoordinate | null {
  if (!isRecord(value) || typeof value.lat !== "number" || !Number.isFinite(value.lat) || typeof value.lng !== "number" || !Number.isFinite(value.lng)) return null;
  return value.lat < -90 || value.lat > 90 || value.lng < -180 || value.lng > 180 ? null : { lat: value.lat, lng: value.lng };
}
function mapArea(value: unknown): MapArea | null {
  const point = mapCoordinate(value);
  if (!point || !isRecord(value) || !Number.isSafeInteger(value.radiusMeters) || Number(value.radiusMeters) < 50 || Number(value.radiusMeters) > 10_000) return null;
  return { ...point, radiusMeters: Number(value.radiusMeters) };
}
function lines(value: unknown): string { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join("\n") : ""; }
/** The Japanese manuscript being edited: `content.ja`, or the draft `content.jaDraft` while the page is English-only. */
function japaneseManuscript(content: Record<string, unknown>): LocaleManuscript {
  const stored = content.englishOnly === true ? content.jaDraft : content.ja;
  const source = isRecord(stored) ? stored : {};
  // FAQ is optional: no key unless rows exist, so a pre-FAQ manuscript keeps its exact shape and fingerprint.
  const faq = publicationFaqRows(source.faq);
  return {
    ...(faq.length ? { faq } : {}),
    title: typeof source.title === "string" ? source.title : "", lead: typeof source.lead === "string" ? source.lead : "",
    description: typeof source.description === "string" ? source.description : "", language: typeof source.language === "string" ? source.language : "",
    highlights: Array.isArray(source.highlights) ? source.highlights.filter((item): item is string => typeof item === "string") : [],
    included: Array.isArray(source.included) ? source.included.filter((item): item is string => typeof item === "string") : [],
    notIncluded: Array.isArray(source.notIncluded) ? source.notIncluded.filter((item): item is string => typeof item === "string") : [],
    knowBeforeYouGo: Array.isArray(source.knowBeforeYouGo) ? source.knowBeforeYouGo.filter((item): item is string => typeof item === "string") : [],
    notSuitableFor: Array.isArray(source.notSuitableFor) ? source.notSuitableFor.filter((item): item is string => typeof item === "string") : [],
    timeline: Array.isArray(source.timeline) ? source.timeline.filter((item): item is TimelineItem => isRecord(item)
      && typeof item.time === "string" && typeof item.title === "string" && typeof item.text === "string"
      && (item.photoIndex === null || Number.isSafeInteger(item.photoIndex))).map((item) => ({
        time: item.time, title: item.title, text: item.text, photoIndex: item.photoIndex as number | null,
      })) : [],
  };
}
function timelineItems(value: unknown): TimelineItem[] {
  return Array.isArray(value) ? value.filter((item): item is TimelineItem => isRecord(item)
    && typeof item.time === "string" && typeof item.title === "string" && typeof item.text === "string"
    && (item.photoIndex === null || Number.isSafeInteger(item.photoIndex))).map((item) => ({
      time: item.time, title: item.title, text: item.text, photoIndex: item.photoIndex as number | null,
    })) : [];
}
function mediaForm(items: readonly Media[]) {
  return items.map(({ id, altText, altTextJa, publicCredit }) => ({ id, altText, altTextJa, publicCredit }));
}
function storedMedia(value: unknown, fallback: Media[]): Media[] {
  return Array.isArray(value) && value.every((item) => isRecord(item)
    && typeof item.id === "string" && item.placement === "GALLERY"
    && typeof item.altText === "string" && typeof item.altTextJa === "string") ? value as Media[] : fallback;
}
function providerMediaForm(items: readonly ProviderMedia[]) {
  return items.map(({ id, placement, altText, altTextJa, publicCredit }) => ({ id, placement, altText, altTextJa, publicCredit }));
}
function storedProviderMedia(value: unknown, fallback: ProviderMedia[]): ProviderMedia[] {
  return Array.isArray(value) && value.every((item) => isRecord(item)
    && typeof item.id === "string" && ["PROVIDER_PHOTO", "BUSINESS_LOGO"].includes(String(item.placement))
    && typeof item.altText === "string" && typeof item.altTextJa === "string") ? value as ProviderMedia[] : fallback;
}
function storedTerms(value: unknown, fallback: PublicationTermsForm): PublicationTermsForm {
  if (!isRecord(value)) return fallback;
  const restoredPrices = new Map((Array.isArray(value.offerPrices) ? value.offerPrices : []).filter(isRecord)
    .map((price) => [String(price.offerId ?? ""), typeof price.adultPriceYen === "string" ? price.adultPriceYen : ""]));
  return {
    ...fallback,
    ...value,
    offerPrices: fallback.offerPrices.map((price) => ({ ...price, adultPriceYen: restoredPrices.get(price.offerId) ?? price.adultPriceYen })),
  } as PublicationTermsForm;
}
function base64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
function parseBaseline(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch { return null; }
}

function saveLocal(namespace: string, productId: string, form: unknown) {
  try { window.sessionStorage.setItem(`${namespace}:${productId}`, JSON.stringify(form)); } catch { /* Storage may be disabled; live component state still protects input. */ }
}
function clearLocal(namespace: string, productId: string) { try { window.sessionStorage.removeItem(`${namespace}:${productId}`); } catch { /* Best effort. */ } }

const ROW_KEYS = ["highlights", "included", "notIncluded", "knowBeforeYouGo", "notSuitableFor"] as const;
/** The draft content as saved: the rows of both languages without the empty ones the host left while typing. */
function withoutEmptyRowsIn(source: Record<string, unknown>): Record<string, unknown> {
  const clean = (record: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...record };
    for (const key of ROW_KEYS) {
      const rows = next[key];
      if (Array.isArray(rows)) next[key] = withoutEmptyRows(rows.filter((row): row is string => typeof row === "string"));
    }
    return next;
  };
  const next = clean(source);
  if (isRecord(next.ja)) next.ja = clean(next.ja);
  if (isRecord(next.jaDraft)) next.jaDraft = clean(next.jaDraft);
  return next;
}
function stringRows(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }

function offerLabel(offer: Product["offers"][number]): string {
  const recurrence = offer.recurrence.kind === "DAILY" ? "毎日"
    : offer.recurrence.kind === "WEEKENDS" ? "土日"
      : offer.recurrence.kind === "SELECTED_WEEKDAYS" ? "曜日指定" : "毎週";
  return `${offer.localStartTime}開始・${offer.durationMinutes}分・定員${offer.capacity}人（${recurrence}）`;
}

function Field({ label, value, onChange, onBlur, multiline = false, rows = 3, placeholder }: { label: string; value: string; onChange: (value: string) => void; onBlur?: () => void; multiline?: boolean; rows?: number; placeholder?: string }) {
  const common = "mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-ink outline-none focus-visible:border-moss focus-visible:ring-2 focus-visible:ring-moss/20";
  return <label className="block text-sm font-bold text-ink-soft">{label}{multiline ? <textarea value={value} onChange={(event) => onChange(event.target.value)} onBlur={onBlur} rows={rows} placeholder={placeholder} className={`${common} resize-y font-normal`} /> : <input value={value} onChange={(event) => onChange(event.target.value)} onBlur={onBlur} placeholder={placeholder} className={`${common} font-normal`} />}</label>;
}

function MeetingCoordinatesEditor({ value, onChange, radius, onRadiusChange, approximate }: {
  value: MapCoordinate | null;
  onChange: (value: MapCoordinate | null) => void;
  radius: number;
  onRadiusChange: (radius: number) => void;
  approximate: boolean;
}) {
  const sourceLat = value?.lat ?? null;
  const sourceLng = value?.lng ?? null;
  const [coordinates, setCoordinates] = useState(() => ({
    sourceLat,
    sourceLng,
    lat: sourceLat === null ? "" : String(sourceLat),
    lng: sourceLng === null ? "" : String(sourceLng),
  }));
  if (coordinates.sourceLat !== sourceLat || coordinates.sourceLng !== sourceLng) {
    setCoordinates({
      sourceLat,
      sourceLng,
      lat: sourceLat === null ? "" : String(sourceLat),
      lng: sourceLng === null ? "" : String(sourceLng),
    });
  }
  const { lat, lng } = coordinates;
  const edit = (nextLat: string, nextLng: string) => {
    const parsedLat = Number(nextLat);
    const parsedLng = Number(nextLng);
    if (nextLat.trim() === "" || nextLng.trim() === "") { onChange(null); return; }
    if (Number.isFinite(parsedLat) && parsedLat >= -90 && parsedLat <= 90 && Number.isFinite(parsedLng) && parsedLng >= -180 && parsedLng <= 180) {
      onChange({ lat: parsedLat, lng: parsedLng });
    }
  };
  const input = "mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 font-normal text-ink outline-none focus-visible:border-moss focus-visible:ring-2 focus-visible:ring-moss/20";
  return <div className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block text-sm font-bold text-ink-soft">緯度<input inputMode="decimal" value={lat} onChange={(event) => setCoordinates((current) => ({ ...current, lat: event.target.value }))} onBlur={() => edit(lat, lng)} className={input} /></label>
      <label className="block text-sm font-bold text-ink-soft">経度<input inputMode="decimal" value={lng} onChange={(event) => setCoordinates((current) => ({ ...current, lng: event.target.value }))} onBlur={() => edit(lat, lng)} className={input} /></label>
    </div>
    {approximate ? <label className="block text-sm font-bold text-ink-soft">公開する半径: {radius} m
      <input type="range" min={50} max={10_000} step={50} value={radius} disabled={!value} onChange={(event) => onRadiusChange(Number(event.target.value))} className="mt-2 w-full accent-moss disabled:opacity-45" />
    </label> : null}
  </div>;
}

export function HostPublicationWorkspace({
  productId,
  membersProviderId,
  providerId = null,
  create = false,
  bookingGuideHref,
  paymentConsentHref,
  paymentConsentLabel = "NIHOで受取口座を確認",
  mode = "host",
  apiBase = "/host/api/products",
  experiencesBase = "/host/experiences",
  createHref = "/host/experiences/new",
  publicSiteOrigin,
  embedEnabled = false,
}: Props) {
  const router = useRouter();
  const api = useCallback((path: string) => hostApiPath(path, providerId), [providerId]);
  /** A link to another host screen keeps the host this one is for (the address carries `?providerId=`). */
  const page = useCallback((path: string) => withProvider(path, providerId), [providerId]);
  const adminDraft = mode === "admin-draft";
  /** The 代理登録 form. A host creates from the dialog on the list instead. */
  const adminCreate = create && adminDraft;
  const hostCreate = create && !adminDraft;
  // A host's unsent work is kept per host (#709): a new experience typed for one host never comes back under another.
  const storageNamespace = adminDraft ? `admin-product-draft:${apiBase}` : providerId ? `experience-product-draft:${providerId}` : "experience-product-draft";
  const [products, setProducts] = useState<Product[]>([]);
  const [product, setProduct] = useState<Product | null>(null);
  const [consentVersion, setConsentVersion] = useState("");
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [unitAmount, setUnitAmount] = useState("");
  const [managedSalesAvailable, setManagedSalesAvailable] = useState(false);
  const [createManagedSales, setCreateManagedSales] = useState(false);
  const [createManagedAcceptanceMode, setCreateManagedAcceptanceMode] = useState<"" | "INSTANT" | "APPROVAL">("");
  const [createManagedPrivateGroup, setCreateManagedPrivateGroup] = useState(false);
  const [createManagedAgreementConfirmed, setCreateManagedAgreementConfirmed] = useState(false);
  const managedDraftReady = managedSalesAvailable && (createManagedAcceptanceMode === "INSTANT" || createManagedAcceptanceMode === "APPROVAL") && createManagedAgreementConfirmed;
  const [content, setContent] = useState<Record<string, unknown>>(blankContent);
  const [terms, setTerms] = useState<PublicationTermsForm>(emptyTerms);
  const [baseline, setBaseline] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflictProduct, setConflictProduct] = useState<Product | null>(null);
  const [photoAlt, setPhotoAlt] = useState("");
  const [photoAltJa, setPhotoAltJa] = useState("");
  const [photoCredit, setPhotoCredit] = useState("");
  const [photoPlacement, setPhotoPlacement] = useState<"GALLERY" | "PROVIDER_PHOTO" | "BUSINESS_LOGO">("GALLERY");
  const [mediaDraft, setMediaDraft] = useState<Media[]>([]);
  const [providerMediaDraft, setProviderMediaDraft] = useState<ProviderMedia[]>([]);
  const [providerMediaVersion, setProviderMediaVersion] = useState<number | null>(null);
  const [providerMediaBaseline, setProviderMediaBaseline] = useState("");
  const [photoRights, setPhotoRights] = useState<PhotoRightsConfirmation<File> | null>(null);
  const [selectedPhoto, setSelectedPhoto] = useState<File | null>(null);
  // The photo came from Android's share sheet (#177 P3): the file input cannot show it, so its name is shown beside it.
  const [sharedPhotoName, setSharedPhotoName] = useState<string | null>(null);
  const rightsConfirmed = photoRightsConfirmed(photoRights, selectedPhoto, product?.id ?? null, photoPlacement);
  const [translationBusy, setTranslationBusy] = useState(false);
  const [workspaceSection, setWorkspaceSection] = useState<"page" | "pricing" | "schedule" | "settings">("page");
  /** null: the default, English when it is published and Japanese when it is not. */
  const [editorLocale, setEditorLocale] = useState<"ja" | "en" | null>(null);
  // 通常 host mode only: the editor's own screen state.
  const [compare, setCompare] = useState(false);
  const [activePhotoId, setActivePhotoId] = useState<string | null>(null);
  const [photoDialog, setPhotoDialog] = useState<null | "gallery" | "provider">(null);
  const [createOpen, setCreateOpen] = useState(create && !adminDraft);
  const [createListing, setCreateListing] = useState<PublicationListing>({ en: true, ja: false });
  const [listingNotice, setListingNotice] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [createPrice, setCreatePrice] = useState("");
  /** Which tab's translation waits for its confirmation: the one that would be replaced. */
  const [translateConfirm, setTranslateConfirm] = useState<"en" | "ja" | null>(null);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [blockerDialog, setBlockerDialog] = useState(false);
  /** Which button's reasons the blocker dialog lists: the page's, or the start of bookings'. */
  const [blockerScope, setBlockerScope] = useState<"page" | "booking">("booking");
  /** The blocker dialog was shown: until the page is published, the tabs it names carry a small mark. */
  const [blockersShown, setBlockersShown] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [slugEditing, setSlugEditing] = useState(false);
  /** null: open when a slot already has its own price. */
  const [perOfferOpen, setPerOfferOpen] = useState<boolean | null>(null);
  /** The Japanese manuscript's fingerprint now (computed after each edit); null until the first one. */
  const [japaneseFingerprint, setJapaneseFingerprint] = useState<string | null>(null);
  const [englishFingerprint, setEnglishFingerprint] = useState<string | null>(null);
  const [sellerConfirmationMethod, setSellerConfirmationMethod] = useState<"" | "VERBAL" | "WRITTEN">("");
  const [sellerConfirmed, setSellerConfirmed] = useState(false);
  const [publicationPhotoRightsConfirmed, setPublicationPhotoRightsConfirmed] = useState(false);
  const [ownerSalesPlan, setOwnerSalesPlan] = useState<"SUPPORTED_15" | "INDEPENDENT_10">("SUPPORTED_15");
  const [ownerSalesPlanAccepted, setOwnerSalesPlanAccepted] = useState(false);
  const [salesPlanCommandId, setSalesPlanCommandId] = useState<string | null>(null);
  const [createDraftRestored, setCreateDraftRestored] = useState(false);
  /** 公開・停止 waiting for its confirmation in the page's dialog. */
  const [stateConfirm, setStateConfirm] = useState<"publish" | PublicationAction | null>(null);
  const stateConfirmStay = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const japaneseSourceRef = useRef<LocaleManuscript>(blankJapanese);
  const englishDraftRef = useRef<{ title: string; content: Record<string, unknown> }>({ title: "", content: blankContent });

  const baselineForm = useMemo(() => parseBaseline(baseline), [baseline]);
  // jsonb may return object keys in a different order; only content changes are unsaved.
  const draftFormJson = useMemo(() => canonicalJson({ slug, title, unitAmount, content }), [slug, title, unitAmount, content]);
  const baselineDraftJson = baselineForm ? canonicalJson({ slug: baselineForm.slug, title: baselineForm.title, unitAmount: baselineForm.unitAmount, content: baselineForm.content }) : "";
  const draftDirty = !!product && (!baselineForm || draftFormJson !== baselineDraftJson);
  const termsDirty = !!product && (!baselineForm || JSON.stringify(terms) !== JSON.stringify(baselineForm.terms));
  const listing = publicationListing(content);
  // A language that is not published takes the published one's photo descriptions when it has none (the upload API wants both).
  const effectiveMedia = adminDraft ? mediaDraft : fillUnlistedAlt(mediaDraft, listing);
  const effectiveProviderMedia = adminDraft ? providerMediaDraft : fillUnlistedAlt(providerMediaDraft, listing);
  // What the host changed (shown as unsaved)…
  const mediaEdited = !!product && (!baselineForm || JSON.stringify(mediaForm(mediaDraft)) !== JSON.stringify(baselineForm.media));
  const providerMediaEdited = !adminDraft && !!product && JSON.stringify(providerMediaForm(providerMediaDraft)) !== providerMediaBaseline;
  // …and what a save sends, the filled descriptions included. A page that only needs the fill is not shown as unsaved:
  // the next save, or 「同意して公開」, writes it.
  const mediaDirty = mediaEdited || (!!product && effectiveMedia !== mediaDraft);
  const providerMediaDirty = providerMediaEdited || (!adminDraft && !!product && effectiveProviderMedia !== providerMediaDraft);
  // 分類 is saved on its own route, but the host edits it with the page: it counts as one of the unsaved changes.
  const classification = useProductClassification(!adminDraft && productId ? { kind: "host", productId, providerId } : null);
  const classificationDirty = !adminDraft && !!product && classification.dirty;
  const dirty = adminCreate ? Boolean(slug || title || unitAmount) : !!product && (draftDirty || termsDirty || mediaEdited || providerMediaEdited || classificationDirty);
  const needsSave = dirty || mediaDirty || providerMediaDirty;
  const updateContent = useCallback((key: string, value: unknown) => setContent((current) => ({ ...current, [key]: value })), []);

  // 英語と日本語のずれ: the Japanese manuscript's fingerprint now, computed after each edit (an older answer is dropped).
  const japaneseKey = useMemo(() => canonicalJson(japaneseManuscript(withoutEmptyRowsIn(content))), [content]);
  useEffect(() => {
    if (adminDraft || !product) return;
    let active = true;
    void publicationManuscriptFingerprint(JSON.parse(japaneseKey) as unknown).then((value) => { if (active) setJapaneseFingerprint(value); }).catch(() => { if (active) setJapaneseFingerprint(null); });
    return () => { active = false; };
  }, [adminDraft, japaneseKey, product]);

  const englishKey = useMemo(() => canonicalJson(englishPublicationManuscript(title.trim(), withoutEmptyRowsIn(content))), [content, title]);
  useEffect(() => {
    if (adminDraft || !product) return;
    let active = true;
    void publicationManuscriptFingerprint(JSON.parse(englishKey) as unknown).then((value) => { if (active) setEnglishFingerprint(value); }).catch(() => { if (active) setEnglishFingerprint(null); });
    return () => { active = false; };
  }, [adminDraft, englishKey, product]);

  function updateJapanese(key: keyof LocaleManuscript, value: string | string[] | TimelineItem[]) {
    const next = { ...japaneseSourceRef.current, [key]: value } as LocaleManuscript;
    japaneseSourceRef.current = next;
    // 日本語のみの商品は、公開上の商品名＝日本語の商品名（英語の商品名は無い）。
    if (key === "title" && typeof value === "string" && content.japaneseOnly === true) setTitle(value);
    setContent((current) => ({ ...current, [current.englishOnly === true ? "jaDraft" : "ja"]: next, translation: { sourceFingerprint: null, confirmedSourceFingerprint: null } }));
  }

  /** 掲載言語 (host): the unpublished language keeps its draft. At least one language stays published. */
  function changeListing(next: PublicationListing) {
    if (!next.en && !next.ja) { setListingNotice("掲載言語は1つ以上必要です"); return; }
    setListingNotice("");
    const converted = withPublicationListing({ content, title }, next);
    setTitle(converted.title);
    setContent(converted.content);
    japaneseSourceRef.current = japaneseManuscript(converted.content);
    englishDraftRef.current = { title: publicationEnglishTitle(converted.content, converted.title), content: converted.content };
  }

  /** 「日本語のみで公開する」（#59）。英語の原稿・確認が要らなくなり、英語のページは作られない。 */
  function changeJapaneseOnly(on: boolean) {
    if (on) setTitle(japaneseManuscript(content).title);
    else setTitle(englishDraftRef.current.title);
    setContent((current) => {
      const rest = Object.fromEntries(Object.entries(current).filter(([key]) => key !== "japaneseOnly"));
      return { ...rest, ...(on ? { japaneseOnly: true } : {}), translation: { sourceFingerprint: null, confirmedSourceFingerprint: null } };
    });
  }

  function updateFaq(locale: "en" | "ja", rows: PublicationFaqRow[]) {
    if (locale === "ja") {
      const next = withPublicationFaq(japaneseSourceRef.current, rows);
      japaneseSourceRef.current = next;
      setContent((current) => ({ ...current, [current.englishOnly === true ? "jaDraft" : "ja"]: next, translation: { sourceFingerprint: null, confirmedSourceFingerprint: null } }));
      return;
    }
    englishDraftRef.current = { ...englishDraftRef.current, content: withPublicationFaq(englishDraftRef.current.content, rows) };
    setContent((current) => withPublicationFaq({ ...current, translation: { ...(isRecord(current.translation) ? current.translation : {}), confirmedSourceFingerprint: null, confirmedEnglishFingerprint: null } }, rows));
  }

  function updateEnglishTitle(value: string) {
    englishDraftRef.current = { ...englishDraftRef.current, title: value };
    // A Japanese-only page's public title is the Japanese one: its English title is only a draft.
    if (content.japaneseOnly !== true) setTitle(value);
    setContent((current) => ({ ...current, ...(current.japaneseOnly === true ? { enTitleDraft: value } : {}), translation: { ...(isRecord(current.translation) ? current.translation : {}), confirmedSourceFingerprint: null, confirmedEnglishFingerprint: null } }));
  }

  function updateEnglishContent(key: string, value: unknown) {
    englishDraftRef.current = { ...englishDraftRef.current, content: { ...englishDraftRef.current.content, [key]: value } };
    setContent((current) => ({ ...current, [key]: value, translation: { ...(isRecord(current.translation) ? current.translation : {}), confirmedSourceFingerprint: null, confirmedEnglishFingerprint: null } }));
  }

  function updateTimeline(locale: "en" | "ja", index: number, key: keyof TimelineItem, value: string | number | null) {
    const current = locale === "ja" ? japaneseManuscript(content).timeline : timelineItems(content.timeline);
    const next = current.map((item, at) => at === index ? { ...item, [key]: value } as TimelineItem : item);
    if (locale === "ja") updateJapanese("timeline", next);
    else updateEnglishContent("timeline", next);
  }

  function addTimeline(locale: "en" | "ja") {
    const current = locale === "ja" ? japaneseManuscript(content).timeline : timelineItems(content.timeline);
    const next = [...current, { time: "", title: "", text: "", photoIndex: null }];
    if (locale === "ja") updateJapanese("timeline", next);
    else updateEnglishContent("timeline", next);
  }

  function removeTimeline(locale: "en" | "ja", index: number) {
    const current = locale === "ja" ? japaneseManuscript(content).timeline : timelineItems(content.timeline);
    const next = current.filter((_, at) => at !== index);
    if (locale === "ja") updateJapanese("timeline", next);
    else updateEnglishContent("timeline", next);
  }

  const refresh = useCallback(async (restoreLocal = true, preserveEditorDraft = false) => {
    const response = await fetch(api(`${apiBase}/${encodeURIComponent(productId ?? "")}`), { cache: "no-store", credentials: "same-origin" });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
    const result = body as ProductResponse;
    if (!isRecord(result) || !isRecord(result.product)) throw new Error("商品を読み込めませんでした。");
    const current = result.product;
    if (preserveEditorDraft) {
      // A write may have succeeded even when its response was lost. Keep the live form untouched;
      // the fetched version is only a comparison point until the owner chooses to replace it.
      setConflictProduct(current);
      return current;
    }
    let currentProviderMedia: ProviderMedia[] = [];
    let providerVersion: number | null = null;
    if (!adminDraft) {
      const providerResponse = await fetch(api("/host/api/provider-media"), { cache: "no-store", credentials: "same-origin" });
      const providerBody: unknown = await providerResponse.json().catch(() => null);
      if (!providerResponse.ok) throw new Error(apiErrorMessage(providerBody, providerResponse.status));
      if (!isRecord(providerBody) || !isRecord(providerBody.providerMedia) || !Array.isArray(providerBody.providerMedia.assets)
        || !Number.isSafeInteger(providerBody.providerMedia.version)) throw new Error("販売者プロフィールを読み込めませんでした。");
      currentProviderMedia = providerBody.providerMedia.assets as ProviderMedia[];
      providerVersion = providerBody.providerMedia.version as number;
    }
    setProduct(current); setConsentVersion(result.publicationConsentVersion ?? "");
    if (adminDraft) {
      setSellerConfirmed(false);
      setSellerConfirmationMethod("");
      setPublicationPhotoRightsConfirmed(false);
    }
    setProviderMediaVersion(providerVersion);
    const restored = (() => { try { const saved = window.sessionStorage.getItem(`${storageNamespace}:${current.id}`); return saved ? JSON.parse(saved) as Record<string, unknown> : null; } catch { return null; } })();
    const nextContent = contentFrom(current);
    japaneseSourceRef.current = japaneseManuscript(nextContent);
    englishDraftRef.current = { title: publicationEnglishTitle(nextContent, current.draft.publicTitle), content: nextContent };
    const nextTerms = publicationTermsForm(current.saleTerms, current.offers);
    const serverForm = { slug: current.draft.slug, title: current.draft.publicTitle, unitAmount: String(current.draft.unitAmount), content: nextContent, terms: nextTerms, media: mediaForm(current.media), providerMedia: providerMediaForm(currentProviderMedia) };
    if (restoreLocal && restored && isRecord(restored) && typeof restored.slug === "string" && typeof restored.title === "string" && isRecord(restored.content) && isRecord(restored.terms)) {
      const restoredProviderMedia = storedProviderMedia(restored.providerMedia, currentProviderMedia);
      const restoredTerms = storedTerms(restored.terms, nextTerms);
      const restoredMedia = storedMedia(restored.media, current.media);
      const restoredForm = { slug: restored.slug, title: restored.title, unitAmount: String(restored.unitAmount ?? ""), content: restored.content, terms: restoredTerms, media: mediaForm(restoredMedia), providerMedia: providerMediaForm(restoredProviderMedia) };
      setSlug(restoredForm.slug); setTitle(restoredForm.title); setUnitAmount(restoredForm.unitAmount); setContent(restoredForm.content); setTerms(restoredTerms); setMediaDraft(restoredMedia); setProviderMediaDraft(restoredProviderMedia);
      setBaseline(JSON.stringify(serverForm));
      setProviderMediaBaseline(JSON.stringify(providerMediaForm(currentProviderMedia)));
      if (canonicalJson(restoredForm) !== canonicalJson(serverForm)) setNotice("保存していない入力を復元しました。");
      japaneseSourceRef.current = japaneseManuscript(restored.content);
      englishDraftRef.current = { title: publicationEnglishTitle(restored.content, restored.title), content: restored.content };
    } else {
      setSlug(current.draft.slug); setTitle(current.draft.publicTitle); setUnitAmount(String(current.draft.unitAmount)); setContent(nextContent); setTerms(nextTerms); setMediaDraft(current.media);
      setProviderMediaDraft(currentProviderMedia);
      setBaseline(JSON.stringify(serverForm));
      setProviderMediaBaseline(JSON.stringify(providerMediaForm(currentProviderMedia)));
      japaneseSourceRef.current = japaneseManuscript(nextContent);
      englishDraftRef.current = { title: publicationEnglishTitle(nextContent, current.draft.publicTitle), content: nextContent };
    }
    setError(""); setConflictProduct(null);
    return current;
  }, [adminDraft, api, apiBase, productId, storageNamespace]);

  useEffect(() => {
    if (create) return;
    if (!productId) return;
    let active = true;
    queueMicrotask(() => { if (active) void refresh().catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "商品を読み込めませんでした。"); }); });
    return () => { active = false; };
  }, [create, productId, refresh]);

  useEffect(() => {
    if (!adminCreate) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const saved = window.sessionStorage.getItem(`${storageNamespace}:new`);
        if (saved) {
          const draft = JSON.parse(saved) as Record<string, unknown>;
          if (typeof draft.slug === "string") setSlug(draft.slug);
          if (typeof draft.title === "string") setTitle(draft.title);
          if (typeof draft.unitAmount === "string") setUnitAmount(draft.unitAmount);
          if (isRecord(draft.content)) {
            setContent(draft.content);
            japaneseSourceRef.current = japaneseManuscript(draft.content);
            englishDraftRef.current = { title: typeof draft.title === "string" ? draft.title : "", content: draft.content };
          }
          if (isRecord(draft.terms)) setTerms(storedTerms(draft.terms, emptyTerms));
          setNotice("作成前の入力を復元しました。");
        }
      } catch { /* Keep the live form usable when session storage is unavailable. */ }
      setCreateDraftRestored(true);
    });
    return () => { active = false; };
  }, [adminCreate, storageNamespace]);

  useEffect(() => {
    if (!adminCreate || !createDraftRestored) return;
    try { window.sessionStorage.setItem(`${storageNamespace}:new`, JSON.stringify({ slug, title, unitAmount, content, terms })); }
    catch { /* The current form still protects input in memory. */ }
  }, [adminCreate, content, createDraftRestored, slug, storageNamespace, terms, title, unitAmount]);

  useEffect(() => {
    if (adminCreate) {
      let active = true;
      queueMicrotask(() => { if (active) void fetch(api(apiBase), { cache: "no-store", credentials: "same-origin" }).then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
        if (active && isRecord(body)) {
          if (typeof body.publicationConsentVersion === "string") setConsentVersion(body.publicationConsentVersion);
          setManagedSalesAvailable(body.managedSalesAvailable === true);
        }
      }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "販売者情報を読み込めませんでした。"); }); });
      return () => { active = false; };
    }
    if (productId) return;
    let active = true;
    queueMicrotask(() => { if (active) void fetch(api(apiBase), { cache: "no-store", credentials: "same-origin" }).then(async (response) => {
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      if (active && isRecord(body) && Array.isArray(body.products)) setProducts(body.products as Product[]);
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "商品を読み込めませんでした。"); }); });
    return () => { active = false; };
  }, [adminCreate, api, apiBase, productId]);

  useEffect(() => {
    if (dirty && product) saveLocal(storageNamespace, product.id, { slug, title, unitAmount, content, terms, media: mediaDraft, providerMedia: providerMediaDraft });
  }, [content, dirty, mediaDraft, product, providerMediaDraft, slug, storageNamespace, terms, title, unitAmount]);

  // A host's notice is one line above the save bar and goes by itself; an error stays.
  useEffect(() => {
    if (adminDraft || !notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [adminDraft, notice]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [menuOpen]);

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  async function createProduct(event: React.FormEvent) {
    event.preventDefault(); if (busy || !slug.trim() || !title.trim() || asPublicationPrice(unitAmount) === null) return;
    if (adminDraft && createManagedSales && !managedDraftReady) {
      setError("完全代行の受付方法と、提供者との書面での合意を確認してください。");
      return;
    }
    const faqProblem = publicationContentFaqProblem(content);
    if (faqProblem) { setError(faqProblem); return; }
    setBusy(true); setError(""); setNotice("");
    const draftContent = { ...blankContent, ...content };
    try {
      const managedSales = adminDraft && createManagedSales
        ? {
          enabled: true, acceptanceMode: createManagedAcceptanceMode, privateGroup: createManagedPrivateGroup,
          sellerConfirmationMethod: "WRITTEN",
        }
        : undefined;
      const response = await fetch(api(apiBase), { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: slug.trim(), publicTitle: title.trim(), content: draftContent, currency: "JPY", unitAmount: asPublicationPrice(unitAmount), ...(managedSales ? { managedSales } : {}) }) });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      const created = (body as ProductResponse).product;
      saveLocal(storageNamespace, created.id, { slug, title, unitAmount, content: draftContent, terms, media: [] });
      try { window.sessionStorage.removeItem(`${storageNamespace}:new`); } catch { /* Best effort. */ }
      router.replace(page(`${experiencesBase}/${encodeURIComponent(created.id)}`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "作成結果を確認できませんでした。入力を保持しています。");
      // A lost response can still have created the product. Reconcile by the unique seller slug before retry.
      try {
        const listResponse = await fetch(api(apiBase), { cache: "no-store", credentials: "same-origin" });
        const listBody = await listResponse.json().catch(() => null);
        const found = isRecord(listBody) && Array.isArray(listBody.products) ? (listBody.products as Product[]).find((item) => item.draft.slug === slug.trim()) : undefined;
        if (found) {
          saveLocal(storageNamespace, found.id, { slug, title, unitAmount, content: draftContent, terms, media: found.media });
          try { window.sessionStorage.removeItem(`${storageNamespace}:new`); } catch { /* Best effort. */ }
          router.replace(page(`${experiencesBase}/${encodeURIComponent(found.id)}`));
        }
      } catch { /* Keep the entered form; an explicit retry can reconcile again. */ }
    } finally { setBusy(false); }
  }

  /** Saves what changed. Resolves with the saved product, or null when something could not be saved (the reason is in `error`). */
  async function saveAll(event?: React.FormEvent, options: { confirmManuscripts?: boolean } = {}): Promise<Product | null> {
    event?.preventDefault();
    if (!product || busy) return null;
    if (conflictProduct) { setError("別の更新と競合しています。入力を保持したまま、最新状態を確認してから保存してください。"); return null; }
    const amount = asPublicationPrice(unitAmount);
    // 枠別料金を一部の枠だけ入れたときは、空欄の枠に大人1人の料金を入れて保存する（サーバーは全枠か無しかを求める）。
    const termsToSave = adminDraft ? terms : withBlankOfferPricesFilled(terms, unitAmount);
    const saleTerms = publicationTermsPayload(termsToSave, product.saleTerms);
    // 「同意して公開」 can ask for the draft to be saved as it stands, so manuscripts saved before without a confirmation get one (保存＝確認).
    const saveDraft = draftDirty || (options.confirmManuscripts === true && !adminDraft);
    if (saveDraft && amount === null) { setError("料金は無料なら0円、有料なら50円以上の整数で入力してください。"); return null; }
    const faqProblem = saveDraft ? publicationContentFaqProblem(content) : null;
    if (faqProblem) { setError(`${faqProblem}入力はこのブラウザーに保持しています。`); return null; }
    if (!saveDraft && !mediaDirty && !termsDirty && !providerMediaDirty && !classificationDirty) return product;
    if (termsDirty && !saleTerms && !saveDraft && !mediaDirty && !providerMediaDirty && !classificationDirty) {
      setError("料金・取消条件はまだ保存できません。人数と、確定した取消期限・返金割合を入力してください。入力はこのブラウザーに保持しています。");
      return null;
    }
    if (adminDraft) {
      setSellerConfirmed(false);
      setSellerConfirmationMethod("");
      setPublicationPhotoRightsConfirmed(false);
    }
    setBusy(true); setError(""); setNotice("");
    let shouldReconcile = false;
    try {
      let current = product;
      let publicationUpdated = false;
      if (mediaDirty) {
        shouldReconcile = true;
        const mediaResponse = await fetch(api(`${apiBase}/${encodeURIComponent(current.id)}/media`), {
          method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: current.version, media: mediaForm(effectiveMedia) }),
        });
        const mediaBody: unknown = await mediaResponse.json().catch(() => null);
        if (!mediaResponse.ok) {
          shouldReconcile = writeOutcomeNeedsReconciliation(mediaResponse.status);
          throw new Error(apiErrorMessage(mediaBody, mediaResponse.status));
        }
        if (!isRecord(mediaBody) || !isRecord(mediaBody.product)) throw new Error("写真の保存結果を確認できませんでした。");
        current = (mediaBody as ProductResponse).product;
        shouldReconcile = false;
        setProduct(current); setMediaDraft(current.media);
      }
      let savedContent: Record<string, unknown> | null = null;
      if (saveDraft) {
        // 保存＝確認: empty rows are dropped and, on a page in both languages, the English is confirmed against the Japanese just before saving.
        let draftContent = content;
        if (!adminDraft) {
          draftContent = withoutEmptyRowsIn(content);
          if (content.japaneseOnly !== true) {
            // An English-only page sends an empty Japanese manuscript (its Japanese is only a draft in jaDraft).
            const englishOnly = content.englishOnly === true;
            const japaneseNow: Record<string, unknown> = englishOnly ? { ...BLANK_JAPANESE_MANUSCRIPT } : japaneseManuscript(draftContent);
            if (englishOnly) draftContent = { ...draftContent, ja: japaneseNow };
            const englishNow = englishPublicationManuscript(title.trim(), draftContent);
            try {
              const translation = await confirmPublicationEnglish(() => ({ japanese: japaneseNow, english: englishPublicationManuscript(title.trim(), draftContent) }), { allowEmptyJapanese: englishOnly });
              draftContent = { ...draftContent, translation };
            } catch { /* Missing or invalid text: the server's blockers say what is still needed when publishing. */ }
            if (!englishOnly) {
              const japaneseWritten = manuscriptHasContent(japaneseNow);
              const englishWritten = manuscriptHasContent({ title, lead: draftContent.lead, description: draftContent.description });
              const [japaneseFingerprintNow, englishFingerprintNow] = await Promise.all([publicationManuscriptFingerprint(japaneseNow), publicationManuscriptFingerprint(englishNow)]);
              const sync = savedLanguageSync({ content, japaneseWritten, englishWritten, japaneseFingerprint: japaneseFingerprintNow, englishFingerprint: englishFingerprintNow });
              draftContent = withLanguageSync(draftContent, sync.source, sync.fingerprint);
            }
          }
        }
        const draft = { slug: slug.trim(), publicTitle: title.trim(), content: draftContent, currency: "JPY", unitAmount: amount! };
        savedContent = draftContent;
        shouldReconcile = true;
        const response = await fetch(api(`${apiBase}/${encodeURIComponent(current.id)}`), { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: current.version, draft }) });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          shouldReconcile = writeOutcomeNeedsReconciliation(response.status);
          throw new Error(apiErrorMessage(body, response.status));
        }
        if (!isRecord(body) || !isRecord(body.product)) throw new Error("商品情報の保存結果を確認できませんでした。");
        current = (body as ProductResponse).product;
        shouldReconcile = false;
        setProduct(current);
        if (savedContent && savedContent !== content) {
          // What was saved is the draft without its empty rows plus the confirmation: the form shows exactly that.
          japaneseSourceRef.current = japaneseManuscript(savedContent);
          englishDraftRef.current = { title: publicationEnglishTitle(savedContent, title), content: savedContent };
          setContent(savedContent);
        }
        publicationUpdated = Boolean((body as { publicationUpdated?: boolean }).publicationUpdated);
      }
      let saved = current;
      let termsSaved = false;
      let savedProviderMedia = providerMediaDraft;
      if (termsDirty && saleTerms) {
        shouldReconcile = true;
        const termsResponse = await fetch(api(`${apiBase}/${encodeURIComponent(saved.id)}/sale-terms`), { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: saved.version, saleTerms }) });
        const termsBody: unknown = await termsResponse.json().catch(() => null);
        if (!termsResponse.ok) {
          shouldReconcile = writeOutcomeNeedsReconciliation(termsResponse.status);
          throw new Error(apiErrorMessage(termsBody, termsResponse.status));
        }
        if (!isRecord(termsBody) || !isRecord(termsBody.product)) throw new Error("料金・販売条件の保存結果を確認できませんでした。");
        saved = (termsBody as ProductResponse).product;
        shouldReconcile = false;
        setProduct(saved);
        termsSaved = true;
        publicationUpdated = Boolean((termsBody as { publicationUpdated?: boolean }).publicationUpdated);
      }
      if (providerMediaDirty) {
        if (providerMediaVersion === null) throw new Error("販売者プロフィールの保存版がありません。再読み込みしてください。");
        shouldReconcile = true;
        const profileResponse = await fetch(api("/host/api/provider-media"), {
          method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: providerMediaVersion, media: providerMediaForm(effectiveProviderMedia) }),
        });
        const profileBody: unknown = await profileResponse.json().catch(() => null);
        if (!profileResponse.ok) {
          shouldReconcile = writeOutcomeNeedsReconciliation(profileResponse.status);
          throw new Error(apiErrorMessage(profileBody, profileResponse.status));
        }
        if (!isRecord(profileBody) || !isRecord(profileBody.providerMedia) || !Array.isArray(profileBody.providerMedia.assets)
          || !Number.isSafeInteger(profileBody.providerMedia.version)) throw new Error("販売者プロフィールの保存結果を確認できませんでした。");
        const savedProfile = profileBody.providerMedia;
        setProviderMediaVersion(savedProfile.version as number);
        savedProviderMedia = savedProfile.assets as ProviderMedia[];
        setProviderMediaDraft(savedProviderMedia);
        shouldReconcile = false;
      }
      const baselineContent = contentFrom(saved);
      const savedTerms = publicationTermsForm(saved.saleTerms, saved.offers);
      setMediaDraft(saved.media);
      const savedProviderMediaForm = providerMediaForm(savedProviderMedia);
      setProviderMediaBaseline(JSON.stringify(savedProviderMediaForm));
      setBaseline(JSON.stringify({ slug: saved.draft.slug, title: saved.draft.publicTitle, unitAmount: String(saved.draft.unitAmount), content: baselineContent, terms: savedTerms, media: mediaForm(saved.media), providerMedia: savedProviderMediaForm }));
      if (termsSaved) setTerms(savedTerms);
      clearLocal(storageNamespace, saved.id); setConflictProduct(null);
      // 分類 is saved last; if only it fails, everything else stays saved and the reason is shown.
      const classificationFailed = classificationDirty ? !(await classification.save()) : false;
      if (classificationFailed) setError("分類を保存できませんでした。ほかの変更は保存しています。時間をおいて、もう一度保存してください。");
      else if (publicationUpdated) setNotice("保存しました。掲載内容も更新しました。");
      else if (termsDirty && !saleTerms) setNotice("原稿・写真・販売者プロフィールを保存しました。料金・取消条件は入力途中のため、まだ保存されていません。");
      else if (saved.publicationNeedsUpdate) setNotice("下書きを保存しました。掲載中の内容は維持されています。公開条件を整えると変更を反映できます。");
      else setNotice("下書きを保存しました。");
      return classificationFailed || (termsDirty && !saleTerms) ? null : saved;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存結果を確認できませんでした。最新状態を読み直してください。");
      // Only an uncertain write outcome or an explicit version conflict needs reconciliation.
      // Fetch a comparison snapshot without hydrating the live form from storage or the server.
      if (shouldReconcile) {
        try { await refresh(true, true); } catch { /* The in-memory form and local draft remain untouched. */ }
      }
      return null;
    } finally { setBusy(false); }
  }

  async function reapplyDraftOnLatest() {
    if (!product || !conflictProduct || busy) return;
    if (!window.confirm("現在の入力を最新の商品状態に適用し直します。競合した項目は、次の保存でこの入力に更新されます。続けますか？")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(api(`${apiBase}/${encodeURIComponent(product.id)}`), { cache: "no-store", credentials: "same-origin" });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      if (!isRecord(body) || !isRecord(body.product)) throw new Error("最新の商品状態を読み込めませんでした。");
      const latest = body.product as Product;
      let latestProviderMedia: ProviderMedia[] = [];
      let latestProviderVersion: number | null = null;
      if (!adminDraft) {
        const providerResponse = await fetch(api("/host/api/provider-media"), { cache: "no-store", credentials: "same-origin" });
        const providerBody: unknown = await providerResponse.json().catch(() => null);
        if (!providerResponse.ok) throw new Error(apiErrorMessage(providerBody, providerResponse.status));
        if (!isRecord(providerBody) || !isRecord(providerBody.providerMedia) || !Array.isArray(providerBody.providerMedia.assets)
          || !Number.isSafeInteger(providerBody.providerMedia.version)) throw new Error("最新の販売者プロフィールを読み込めませんでした。");
        latestProviderMedia = providerBody.providerMedia.assets as ProviderMedia[];
        latestProviderVersion = providerBody.providerMedia.version as number;
      }
      const latestContent = contentFrom(latest);
      const latestTerms = publicationTermsForm(latest.saleTerms, latest.offers);
      const latestProviderMediaForm = providerMediaForm(latestProviderMedia);
      const latestBaseline = {
        slug: latest.draft.slug,
        title: latest.draft.publicTitle,
        unitAmount: String(latest.draft.unitAmount),
        content: latestContent,
        terms: latestTerms,
        media: mediaForm(latest.media),
        providerMedia: latestProviderMediaForm,
      };
      const retainedProviderMedia = reapplyProviderMediaEdits(latestProviderMedia, providerMediaDraft, JSON.parse(providerMediaBaseline || "[]") as ReturnType<typeof providerMediaForm>);
      const localDraft = { slug, title, unitAmount, content, terms, media: mediaDraft, providerMedia: retainedProviderMedia };
      const localComparable = { ...localDraft, media: mediaForm(mediaDraft), providerMedia: providerMediaForm(retainedProviderMedia) };
      setProduct(latest);
      setConsentVersion(isRecord(body) && typeof body.publicationConsentVersion === "string" ? body.publicationConsentVersion : consentVersion);
      setProviderMediaVersion(latestProviderVersion);
      setProviderMediaDraft(retainedProviderMedia);
      setProviderMediaBaseline(JSON.stringify(latestProviderMediaForm));
      setBaseline(JSON.stringify(latestBaseline));
      if (canonicalJson(localComparable) === canonicalJson(latestBaseline)) clearLocal(storageNamespace, latest.id);
      else saveLocal(storageNamespace, latest.id, localDraft);
      setConflictProduct(null);
      setNotice("最新の保存状態を基準に、入力を保持しました。保存すると競合した項目をこの入力で更新します。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "最新状態を確認できませんでした。入力は保持しています。");
    } finally { setBusy(false); }
  }

  async function replaceDraftWithLatest() {
    if (!product || busy) return;
    if (!window.confirm("保存していない入力を破棄し、最新の保存内容に置き換えます。続けますか？")) return;
    await discardToLatest();
  }

  /** The 保存の帯's 「元に戻す」 (confirmed in the page's own dialog): back to what the server has, 分類 included. */
  async function discardToLatest() {
    if (!product || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const latest = await refresh(false);
      clearLocal(storageNamespace, latest.id);
      if (!adminDraft) await classification.reload();
      setError("");
      setNotice("最新の保存内容を読み込みました。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "最新状態を読み込めませんでした。入力は保持しています。");
    } finally { setBusy(false); }
  }

  async function changeState(action: "publish" | PublicationAction) {
    if (conflictProduct) { setError("別の更新との競合を解決してから、公開・停止を行ってください。"); return; }
    if (!product || dirty || busy) { if (dirty) setError("公開・停止の前に、入力を保存してください。"); return; }
    if (action === "publish" && product.publicationBlockers.length > 0) {
      setError("保存済みの内容に未完了の公開条件があります。「次にすること」を確認してください。");
      return;
    }
    if (action === "publish" && adminDraft && (!sellerConfirmed || !publicationPhotoRightsConfirmed || !sellerConfirmationMethod)) {
      setError("販売者への確認方法、販売者確認済み、写真掲載権利確認済みをすべて確認してください。");
      return;
    }
    // The page's own dialog (HostConfirmDialog), not the browser's confirm(): nothing happens until its button is pressed.
    setStateConfirm(action);
  }

  async function runStateChange(action: "publish" | PublicationAction) {
    if (!product || dirty || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (adminDraft && action === "stop") throw new Error("事務局は公開済み商品の停止を操作できません。");
      const publishBody = adminDraft
        ? { version: product.version, accepted: true, sellerConfirmationMethod, photoRightsConfirmed: true, consentVersion }
        : { version: product.version, consentVersion, accepted: true };
      // While bookings are open, a change to the page is sold as shown: it goes the way of 予約の受付を始める (the same call the
      // store treats as a re-publish of the open sale), so the current conditions are agreed to; the page alone would reuse the
      // consent given earlier and be refused with CONSENT_OUTDATED once the conditions have moved on.
      const wire: "publish" | PublicationAction = action === "publish-page" && (product.bookingOpen ?? product.status === "PUBLISHED") && !adminDraft ? "open-booking" : action;
      // 予約の受付を始める takes the same consent as the old one-step publish; the page alone and the stops take only the version.
      const body_ = wire === "publish" ? publishBody : wire === "open-booking" ? { version: product.version, consentVersion, accepted: true } : { version: product.version };
      const response = await fetch(api(`${apiBase}/${encodeURIComponent(product.id)}/${wire === "publish" ? "publish" : PUBLICATION_ACTION_PATH[wire]}`), { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body_) });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      if (adminDraft) {
        setNotice("事務局の代理公開として公開しました。");
        router.push(page(experiencesBase));
        router.refresh();
        return;
      }
      const saved = (body as ProductResponse).product;
      setProduct(saved); setNotice(action === "publish" ? "公開しました。" : PUBLICATION_ACTION_NOTICE[action]);
      if (action === "publish" || action === "publish-page" || action === "open-booking") setBlockersShown(false);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "処理結果を確認できませんでした。入力は保持しています。");
      try { await refresh(); } catch { /* State remains unchanged locally; retry after refresh. */ }
    } finally { setBusy(false); }
  }

  async function confirmAdminEnglish() {
    if (!adminDraft || !product || dirty || busy || translationBusy) {
      if (dirty) setError("英語原稿の確認前に入力を保存してください。");
      return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(api(`${apiBase}/${encodeURIComponent(product.id)}/english-review`), {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: product.version, reviewed: true }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      if (!isRecord(body) || !isRecord(body.product)) throw new Error("英語原稿の確認結果を読み取れませんでした。");
      setProduct((body as ProductResponse).product);
      setNotice(product.draft.content.japaneseOnly === true ? "現在の日本語原稿を事務局レビューとして確認しました。" : "現在の日英原稿を事務局レビューとして確認しました。");
      await refresh(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "英語原稿を確認できませんでした。"); }
    finally { setBusy(false); }
  }

  async function generateEnglish() {
    if (!product || translationBusy || busy) return;
    const japanese = japaneseSourceRef.current;
    if (!japanese.title.trim() || !japanese.lead.trim() || !japanese.description.trim()) { setError("日本語の商品名・紹介文・説明を入力してください。"); return; }
    const faqProblem = publicationFaqProblem(publicationFaqRows(japanese.faq), "日本語");
    if (faqProblem) { setError(faqProblem); return; }
    const snapshot = canonicalJson(japanese);
    const englishSnapshot = canonicalJson(englishDraftRef.current);
    setTranslationBusy(true); setError(""); setNotice("");
    try {
      if (adminDraft) throw new Error("代理登録では英語原稿を手入力し、事務局レビューとして確認してください。");
      const response = await fetch(api(`${apiBase}/${encodeURIComponent(product.id)}/translation`), { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ japanese }) });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      const result = body as { sourceFingerprint?: unknown; english?: unknown };
      if (canonicalJson(japaneseSourceRef.current) !== snapshot) { setNotice("翻訳中に日本語原稿が変更されたため、結果を破棄しました。もう一度生成してください。"); return; }
      if (canonicalJson(englishDraftRef.current) !== englishSnapshot) { setNotice("翻訳中に英語原稿が編集されたため、結果を破棄しました。入力した英語は保持しています。"); return; }
      if (typeof result.sourceFingerprint !== "string" || !isRecord(result.english)) throw new Error("翻訳結果を確認できませんでした。原稿は変更していません。");
      const english = result.english as unknown as LocaleManuscript;
      const japaneseOnlyPage = content.japaneseOnly === true;
      const sourceFingerprint = result.sourceFingerprint;
      // The translation keeps the Japanese FAQ rows (the server checks the count); none removes the English FAQ.
      const apply = (base: Record<string, unknown>) => withPublicationFaq({
        ...base, lead: english.lead, description: english.description, facts: { language: english.language },
        highlights: english.highlights, included: english.included, notIncluded: english.notIncluded,
        knowBeforeYouGo: english.knowBeforeYouGo, notSuitableFor: english.notSuitableFor, timeline: english.timeline,
        // A Japanese-only page keeps the English title as a draft; its public title stays the Japanese one.
        ...(japaneseOnlyPage ? { enTitleDraft: english.title } : {}),
        translation: { sourceFingerprint, confirmedSourceFingerprint: null, confirmedEnglishFingerprint: null },
        // The English now follows this Japanese: the 「ずれ」 notice goes away.
        languageSync: { englishSourceFingerprint: sourceFingerprint },
      }, publicationFaqRows(english.faq));
      englishDraftRef.current = { title: english.title, content: apply(englishDraftRef.current.content) };
      if (!japaneseOnlyPage) setTitle(english.title);
      setContent(apply);
      setCompare(true);
      setNotice("日本語から翻訳しました。内容を確かめてから保存してください。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "翻訳できませんでした。日本語原稿は保持しています。"); }
    finally { setTranslationBusy(false); }
  }

  /** 「英語から翻訳」: the English manuscript goes in, the Japanese comes back into the Japanese manuscript being edited. */
  async function generateJapanese() {
    if (!product || translationBusy || busy || adminDraft) return;
    const cleaned = withoutEmptyRowsIn(content);
    const english = englishPublicationManuscript(publicationEnglishTitle(content, title).trim(), cleaned);
    if (["title", "lead", "description"].some((key) => typeof english[key] !== "string" || !english[key].trim())) { setError("英語の体験名・ひとこと紹介・詳しい説明を入力してください。"); return; }
    const faqProblem = publicationFaqProblem(publicationFaqRows(english.faq), "英語");
    if (faqProblem) { setError(faqProblem); return; }
    const snapshot = canonicalJson(english);
    const japaneseSnapshot = canonicalJson(japaneseSourceRef.current);
    const currentEnglish = () => canonicalJson(englishPublicationManuscript(englishDraftRef.current.title.trim(), withoutEmptyRowsIn(englishDraftRef.current.content)));
    setTranslationBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(api(`${apiBase}/${encodeURIComponent(product.id)}/translation`), { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ english }) });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      const result = body as { sourceFingerprint?: unknown; japanese?: unknown };
      if (currentEnglish() !== snapshot) { setNotice("翻訳中に英語原稿が変更されたため、結果を破棄しました。もう一度翻訳してください。"); return; }
      if (canonicalJson(japaneseSourceRef.current) !== japaneseSnapshot) { setNotice("翻訳中に日本語原稿が編集されたため、結果を破棄しました。入力した日本語は保持しています。"); return; }
      if (typeof result.sourceFingerprint !== "string" || !isRecord(result.japanese)) throw new Error("翻訳結果を確認できませんでした。原稿は変更していません。");
      const next = japaneseManuscript({ ja: result.japanese });
      const sourceFingerprint = result.sourceFingerprint;
      japaneseSourceRef.current = next;
      // A Japanese-only page's public title is its Japanese title.
      if (content.japaneseOnly === true) setTitle(next.title);
      setContent((current) => withLanguageSync({ ...current, [current.englishOnly === true ? "jaDraft" : "ja"]: next, translation: { sourceFingerprint: null, confirmedSourceFingerprint: null } }, "en", sourceFingerprint));
      setCompare(true);
      setNotice("英語から翻訳しました。内容を確かめてから保存してください。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "翻訳できませんでした。英語原稿は保持しています。"); }
    finally { setTranslationBusy(false); }
  }

  async function confirmEnglish() {
    if (adminDraft || translationBusy || busy) return;
    setError(""); setNotice("");
    try {
      const confirmation = await confirmPublicationEnglish(() => ({
        japanese: japaneseSourceRef.current,
        english: englishPublicationManuscript(englishDraftRef.current.title, englishDraftRef.current.content),
      }));
      setContent((current) => ({ ...current, translation: confirmation }));
      setNotice("現在の日英原稿を確認しました。保存後に公開できます。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "確認できませんでした。原稿は保持しています。"); }
  }

  /** 体験を作成 (host): the dialog asks the language, the name and the adult price; the address is made from the name. */
  async function createHostProduct(event: React.FormEvent) {
    event.preventDefault();
    const name = createTitle.trim();
    const price = asPublicationPrice(createPrice);
    if (busy || !name || price === null) return;
    setBusy(true); setError(""); setNotice("");
    // English-only: the Japanese stays empty. Japanese-only: the name is the Japanese title. Both: the same name until it is written in each.
    const draftContent = createListing.ja
      ? { ...blankContent, ...(createListing.en ? {} : { japaneseOnly: true }), ja: { ...blankJapanese, title: name } }
      : { ...blankContent, englishOnly: true };
    let address = publicationSlugFromTitle(name);
    const post = (slugValue: string) => fetch(api(apiBase), { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: slugValue, publicTitle: name, content: draftContent, currency: "JPY", unitAmount: price }) });
    try {
      let response = await post(address);
      if (response.status === 409) { address = publicationSlugRetry(address); response = await post(address); }
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      router.replace(page(`${experiencesBase}/${encodeURIComponent((body as ProductResponse).product.id)}`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "作成結果を確認できませんでした。入力を保持しています。");
      // A lost response can still have created the product. Reconcile by the unique seller slug before retry.
      try {
        const listResponse = await fetch(api(apiBase), { cache: "no-store", credentials: "same-origin" });
        const listBody = await listResponse.json().catch(() => null);
        const found = isRecord(listBody) && Array.isArray(listBody.products) ? (listBody.products as Product[]).find((item) => item.draft.slug === address) : undefined;
        if (found) router.replace(page(`${experiencesBase}/${encodeURIComponent(found.id)}`));
      } catch { /* Keep the entered form; an explicit retry can reconcile again. */ }
    } finally { setBusy(false); }
  }

  function closeCreateDialog() {
    if (!createOpen) return;
    setCreateOpen(false);
    if (hostCreate) router.replace(page(experiencesBase));
  }

  /**
   * 「ページを公開する」 / 「予約の受付を始める」 (#706): save first when there is something unsaved, then either say what is still
   * missing or ask for the confirmation. The page alone needs only the page's reasons (while bookings are open it needs the
   * booking's too: the store moves the page and the sale together); starting bookings needs both.
   */
  async function requestPublish(action: Extract<PublicationAction, "publish-page" | "open-booking">) {
    if (!product || busy || conflictProduct || product.status === "SUSPENDED") return;
    let current = product;
    // Manuscripts that were saved without a confirmation (the old 「英語を確認」) get it from this press: no edit is needed for it.
    const confirmManuscripts = content.japaneseOnly !== true && (current.publicationBlockers ?? []).includes("MANUSCRIPT_REQUIRED");
    if (needsSave || confirmManuscripts) {
      const savedProduct = await saveAll(undefined, { confirmManuscripts });
      if (!savedProduct) return;
      current = savedProduct;
    }
    const split = splitBlockers(current);
    const selling = current.bookingOpen ?? current.status === "PUBLISHED";
    const needs = action === "open-booking" || selling ? [...split.page, ...split.booking] : split.page;
    if (needs.length > 0) { setBlockerScope(action === "open-booking" ? "booking" : "page"); setBlockersShown(true); setBlockerDialog(true); return; }
    setStateConfirm(action);
  }

  /** 「日本語から翻訳」(into the English tab) or 「英語から翻訳」(into the Japanese tab): asks first when the tab already has something written. */
  function requestTranslation(into: "en" | "ja") {
    const written = into === "en"
      ? manuscriptHasContent({ title: publicationEnglishTitle(content, title), lead: content.lead, description: content.description })
      : manuscriptHasContent(japaneseManuscript(content));
    if (written) setTranslateConfirm(into);
    else void (into === "en" ? generateEnglish() : generateJapanese());
  }

  async function switchManagedSalesPlan() {
    const state = product?.salesPlan;
    if (!product || !state || busy) return;
    const pending = state.pending;
    if (pending ? !state.transitionCommandId : !ownerSalesPlanAccepted || ownerSalesPlan === state.current.plan) return;
    const agreementVersion = pending?.agreementVersion ?? product.ownerSalesPlanAgreementVersion;
    if (!agreementVersion) return;
    const commandId = state.transitionCommandId ?? salesPlanCommandId ?? crypto.randomUUID();
    const targetPlan = pending?.plan ?? ownerSalesPlan;
    const readBack = async () => {
      const updated = await refresh(false, dirty);
      if (dirty) setProduct((current) => current ? { ...current, salesPlan: updated.salesPlan } : current);
      if (updated.salesPlan?.phase === "ACTIVE" && updated.salesPlan.current.plan === targetPlan) {
        setSalesPlanCommandId(null); setOwnerSalesPlanAccepted(false);
      }
    };
    setSalesPlanCommandId(commandId); setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(api(`${apiBase}/${encodeURIComponent(product.id)}/sales-plan`), {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, expectedVersion: state.version, plan: targetPlan, agreementVersion }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      await readBack();
      setNotice("販売プランを切り替えました。URL・商品・開催枠・在庫は引き継ぎ、以後の新規予約は選択した料率で本人のStripe口座に決済します。");
    } catch (reason) {
      await readBack().catch(() => undefined);
      setError(reason instanceof Error ? reason.message : "切替結果を確認できませんでした。同じ操作として再確認してください。");
    } finally { setBusy(false); }
  }

  async function uploadPhoto(): Promise<boolean> {
    if (!product || !selectedPhoto || !rightsConfirmed || busy || conflictProduct) return false;
    setBusy(true); setError(""); setNotice("");
    try {
      // A Japanese-only page asks for one description: the upload API wants both, so the English one is the same sentence.
      const altEnglish = !adminDraft && !listing.en ? photoAltJa : photoAlt;
      const profileAsset = !adminDraft && photoPlacement !== "GALLERY";
      if (profileAsset && providerMediaVersion === null) throw new Error("販売者プロフィールの保存版がありません。再読み込みしてください。");
      const response = await fetch(api(profileAsset ? "/host/api/provider-media/upload" : `${apiBase}/${encodeURIComponent(product.id)}/media`), { method: "POST", credentials: "same-origin", headers: { "content-type": selectedPhoto.type, "x-experience-photo-rights-confirmed": "true", "x-experience-photo-alt-text-utf8-base64url": base64UrlUtf8(altEnglish), "x-experience-photo-alt-text-ja-utf8-base64url": base64UrlUtf8(!adminDraft && !listing.ja ? photoAlt : photoAltJa), "x-experience-media-placement": adminDraft ? "GALLERY" : photoPlacement, ...(profileAsset ? { "x-experience-provider-media-version": String(providerMediaVersion) } : {}), ...(photoCredit.trim() ? { "x-experience-photo-credit-utf8-base64url": base64UrlUtf8(photoCredit.trim()) } : {}) }, body: selectedPhoto });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      if (profileAsset) {
        if (!isRecord(body) || !isRecord(body.providerMedia) || !Array.isArray(body.providerMedia.assets) || !Number.isSafeInteger(body.providerMedia.version)) throw new Error("販売者プロフィールの保存結果を確認できませんでした。再読み込みしてください。");
        const profile = body.providerMedia;
        setProviderMediaVersion(profile.version as number);
        setProviderMediaDraft(profile.assets as ProviderMedia[]);
        setProviderMediaBaseline(JSON.stringify(providerMediaForm(profile.assets as ProviderMedia[])));
        setNotice(photoPlacement === "PROVIDER_PHOTO" ? "提供者写真を登録しました。販売する体験すべてに反映されました。" : "事業者ロゴを登録しました。販売する体験すべてに反映されました。");
      } else {
        const next = (body as ProductResponse).product;
        setProduct(next); setMediaDraft(next.media);
        setNotice("体験写真を追加しました。保存すると公開中の商品にも反映されます。");
      }
      setSelectedPhoto(null); setSharedPhotoName(null); setPhotoRights(null); setPhotoAlt(""); setPhotoAltJa(""); setPhotoCredit("");
      return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "写真を追加できませんでした。選択した写真と入力を保持しています。"); return false; }
    finally { setBusy(false); }
  }

  async function removeProviderMedia(assetId: string) {
    if (providerMediaVersion === null || busy || conflictProduct) return;
    const asset = providerMediaDraft.find((item) => item.id === assetId);
    if (!asset || !window.confirm(asset.placement === "PROVIDER_PHOTO" ? "販売中のすべての体験から提供者写真を削除しますか？" : "販売中のすべての体験から事業者ロゴを削除しますか？")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(api(`/host/api/provider-media/${encodeURIComponent(asset.id)}`), {
        method: "DELETE", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: providerMediaVersion }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      if (!isRecord(body) || !isRecord(body.providerMedia) || !Array.isArray(body.providerMedia.assets) || !Number.isSafeInteger(body.providerMedia.version)) throw new Error("削除結果を確認できませんでした。再読み込みしてください。");
      const profile = body.providerMedia;
      setProviderMediaVersion(profile.version as number);
      setProviderMediaDraft(profile.assets as ProviderMedia[]);
      setProviderMediaBaseline(JSON.stringify(providerMediaForm(profile.assets as ProviderMedia[])));
      setNotice("販売中のすべての体験から画像を削除しました。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "画像を削除できませんでした。入力は保持しています。"); }
    finally { setBusy(false); }
  }

  if (adminCreate) return <HostPageBody><PageHead title="商品の代理登録" /><form onSubmit={createProduct} className={`${HOST_SURFACE} space-y-5 p-4 md:p-6`}>
    <p className="text-sm text-ink-soft">{adminDraft ? "選択した運営登録済み販売者へ、非公開の商品下書きを作成します。販売者へ確認後、通常公開と同じ条件を満たす未公開draftだけを事務局判断で代理公開できます。" : "新しい商品をExperienceに下書き保存します。公開前の入力は公開されません。"}</p>
    {error ? <p role="alert" className="rounded-xl bg-rose-50 p-3 text-rose-900"><HostErrorMessage text={error} /></p> : null}
    <Field label="公開URL用の英数字slug" value={slug} onChange={setSlug} placeholder="kamakura-community-dinner" />
    <Field label="商品名（公開用）" value={title} onChange={setTitle} />
    <Field label="大人1人の基本料金（税込・円）" value={unitAmount} onChange={setUnitAmount} />
    {adminDraft ? <fieldset className="space-y-3 rounded-xl border border-line p-4">
      <legend className="px-1 font-extrabold">販売方式</legend>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={createManagedSales} disabled={!managedSalesAvailable} onChange={(event) => setCreateManagedSales(event.target.checked)} className="mt-1" />
        <span><strong>この体験をNIHO完全代行（20%）で販売する</strong><br />NIHO名義で決済し、提供者の口座登録は不要です。</span>
      </label>
      {createManagedSales ? <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-bold sm:col-span-2">
          予約の受付方法
          <select required className="rounded-xl border border-line bg-white px-3 py-2 font-normal"
            value={createManagedAcceptanceMode}
            onChange={(event) => setCreateManagedAcceptanceMode(event.target.value === "INSTANT" || event.target.value === "APPROVAL" ? event.target.value : "")}>
            <option value="">選択してください</option>
            <option value="INSTANT">即時決済（有料は支払い完了で予約確定）</option>
            <option value="APPROVAL">承認後に決済（申込時はカード不要・事務局が支払URLを案内）</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm font-bold sm:col-span-2">
          <input type="checkbox" checked={createManagedPrivateGroup}
            onChange={(event) => setCreateManagedPrivateGroup(event.target.checked)} />
          開催枠ごとに1組貸切にする
        </label>
        <p className="text-sm sm:col-span-2">提供報酬は開催月末締め・翌月末日払いです。銀行休業日は前営業日までに振り込みます。</p>
        <label className="flex items-start gap-2 text-sm font-bold sm:col-span-2">
          <input type="checkbox" className="mt-1" checked={createManagedAgreementConfirmed}
            onChange={(event) => setCreateManagedAgreementConfirmed(event.target.checked)} />
          提供者に書面・メッセージで条件を明示し、合意を確認しました。
        </label>
      </div> : null}
      {!managedSalesAvailable ? <p className="text-sm text-amber-900">完全代行の決済設定が揃うと選択できます。</p> : null}
    </fieldset> : null}
    <p className="text-sm text-muted">無料体験は0円、有料体験は50円以上で入力してください。作成後に開催日程と販売条件を設定します。</p>
    <button disabled={busy || !slug.trim() || !title.trim() || asPublicationPrice(unitAmount) === null || (createManagedSales && !managedDraftReady)} className={consoleButtonClass("primary")}>{busy ? "作成中…" : "下書きを作成"}</button>
  </form></HostPageBody>;

  if (!productId) return <HostPageBody><PageHead title={adminDraft ? "代理登録の商品" : "体験"}>{bookingGuideHref ? <Link className={consoleButtonClass("secondary")} href={bookingGuideHref}>予約後の集合案内</Link> : null}</PageHead><section className={`${HOST_SURFACE} p-4 md:p-6`}>
    <div className="mb-4 flex items-center justify-between gap-3"><p className="text-ink-soft">{adminDraft ? "事務局が作成した、一度も公開していない下書き" : "あなたが販売する体験"}</p>{adminDraft ? <Link className={consoleButtonClass("primary")} href={createHref}>商品を代理登録</Link> : <button type="button" className={consoleButtonClass("primary")} onClick={() => setCreateOpen(true)}>体験を作成</button>}</div>
    {error && !(createOpen && !adminDraft) ? <p role="alert" className={`mb-3 rounded-xl p-3 ${adminDraft ? "bg-rose-50 text-rose-900" : "bg-danger-pale text-danger"}`}><HostErrorMessage text={error} /></p> : null}
    {products.length ? <ul className="divide-y divide-line">{products.map((item) => <li key={item.id} className="flex items-center justify-between gap-3 py-3"><div className="min-w-0"><Link className="font-extrabold underline-offset-2 hover:underline" href={page(`${experiencesBase}/${encodeURIComponent(item.id)}`)}>{item.draft.publicTitle || "題名なし"}</Link><p className="text-sm text-muted">{item.draft.slug}</p>{!adminDraft && publicSiteOrigin && providerBookingLinkAvailable(item) ? <HostBookingLinkCopy slug={item.draft.slug} origin={publicSiteOrigin} japaneseOnly={item.draft.content.japaneseOnly === true} /> : null}{embedEnabled && !adminDraft && publicSiteOrigin && providerBookingLinkAvailable(item) && item.draft.content.japaneseOnly !== true ? <p className="mt-1.5"><Link className="text-sm font-bold text-moss underline underline-offset-4" href={page(`${experiencesBase}/${encodeURIComponent(item.id)}/embed`)}>自分のサイトに貼る</Link></p> : null}</div><span className="rounded-full bg-sand px-2.5 py-1 text-xs font-extrabold">{STATUS_COPY[item.status]}</span></li>)}</ul> : <p className="py-6 text-center text-muted">{error ? "商品を読み込めませんでした。" : "まだ商品がありません。"}</p>}
  </section>
  {!adminDraft ? <EditorDialog open={createOpen} onClose={closeCreateDialog} title="体験を作成">
    <form onSubmit={(event) => void createHostProduct(event)} className="space-y-1">
      <EditorCheckList legend="掲載言語" info="英語ページは海外からの旅行者向け、日本語ページは日本語で探す人向けです。両方作ることも、片方だけにすることもできます。選んだ言語の原稿が必要です。掲載をやめた言語のページは、次の公開から表示されなくなります。"
        onChange={(key, checked) => { const next = { ...createListing, [key]: checked }; if (!next.en && !next.ja) { setListingNotice("掲載言語は1つ以上必要です"); return; } setListingNotice(""); setCreateListing(next); }}
        options={[{ key: "en", label: "英語", checked: createListing.en }, { key: "ja", label: "日本語", checked: createListing.ja }]} />
      {listingNotice ? <p role="status" className="text-sm font-bold text-warn">{listingNotice}</p> : null}
      <EditorField label="体験名" value={createTitle} onChange={setCreateTitle} autoFocus />
      <EditorField label="大人1人の料金（税込・円）" value={createPrice} onChange={setCreatePrice} inputMode="numeric" info="無料の体験は0円にします。有料は50円以上にしてください。" />
      {error ? <p role="alert" className="rounded-xl bg-danger-pale p-3 text-danger"><HostErrorMessage text={error} /></p> : null}
      <div className="flex justify-end gap-2 pt-4">
        <button type="button" className={consoleButtonClass("secondary")} onClick={closeCreateDialog}>やめる</button>
        <button type="submit" disabled={busy || !createTitle.trim() || asPublicationPrice(createPrice) === null} className={consoleButtonClass("primary")}>{busy ? "作成中…" : "作成"}</button>
      </div>
    </form>
  </EditorDialog> : null}
  </HostPageBody>;

  if (!product) return <HostPageBody><PageHead title="体験を読み込み中" />{error ? <p role="alert" className="rounded-xl bg-rose-50 p-3 text-rose-900"><HostErrorMessage text={error} /></p> : <p>商品を読み込んでいます…</p>}<button type="button" className={consoleButtonClass("secondary")} onClick={() => void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : "読み込みに失敗しました。"))}>再読み込み</button></HostPageBody>;

  const textField = (key: string, label: string, value: string, rows = 3) => <Field label={label} value={value} multiline rows={rows} onChange={(next) => updateEnglishContent(key, next)} />;
  const listField = (key: string, label: string) => <Field label={label} value={lines(content[key])} multiline rows={3} onChange={(next) => updateEnglishContent(key, next.split("\n").filter((item) => item.trim().length > 0))} />;
  const galleryMedia = mediaDraft.filter((item) => item.placement === "GALLERY");
  const calendarHref = adminDraft ? `${experiencesBase}/${encodeURIComponent(product.id)}/calendar` : page(`/host/calendar?experience=${encodeURIComponent(product.id)}`);
  const savedBlockers = product.publicationBlockers ?? [];
  /** The two buttons (#706): what is shown, what can be pressed, and why not. */
  const stages = publicationStages({
    status: product.status, publicationBlockers: savedBlockers, pageBlockers: product.pageBlockers, bookingBlockers: product.bookingBlockers,
    bookingOpen: product.bookingOpen, publicationNeedsUpdate: product.publicationNeedsUpdate, dirty: needsSave, conflict: !!conflictProduct,
    confirmManuscriptsOnPress: content.japaneseOnly !== true,
  });
  const bookingIsOpen = product.bookingOpen ?? product.status === "PUBLISHED";
  const canPublish = !conflictProduct && publicationCanPublish({ dirty, blockers: savedBlockers, suspended: product.status === "SUSPENDED" });
  const nextAction = publicationNextAction({ dirty, blockers: savedBlockers, published: product.status === "PUBLISHED" && !product.publicationNeedsUpdate });
  // A pending draft may have a different slug from the current publication.
  const publicHref = product.status === "PUBLISHED" && !product.publicationNeedsUpdate ? `${product.draft.content.japaneseOnly === true ? "/ja" : ""}/experiences/${encodeURIComponent(product.draft.slug)}` : null;
  const nextActionControl = adminDraft
    ? (dirty ? <button type="button" disabled={busy || !!conflictProduct} className={consoleButtonClass("primary")} onClick={() => void saveAll()}>入力を保存</button>
      : !product.adminEnglishReview?.reviewed ? <button type="button" disabled={busy} className={consoleButtonClass("primary")} onClick={() => void confirmAdminEnglish()}>{product.draft.content.japaneseOnly === true ? "事務局として日本語原稿を確認" : "事務局として英語原稿を確認"}</button>
        : savedBlockers.length === 0 ? <button type="button" disabled={busy || !canPublish || !sellerConfirmed || !publicationPhotoRightsConfirmed || !sellerConfirmationMethod} className={consoleButtonClass("primary")} onClick={() => void changeState("publish")}>事務局として代理公開</button>
          : <Link className={consoleButtonClass("primary")} href={calendarHref}>開催枠を確認</Link>)
    : nextAction === "SAVE"
    ? <button type="button" disabled={busy || !!conflictProduct} className={consoleButtonClass("primary")} onClick={() => void saveAll()}>入力を保存</button>
    : nextAction === "SCHEDULE"
      ? <Link className={consoleButtonClass("primary")} href={calendarHref}>開催枠を追加</Link>
      : nextAction === "PRICING"
        ? <button type="button" className={consoleButtonClass("primary")} onClick={() => setWorkspaceSection("pricing")}>料金・取消条件を入力</button>
        : nextAction === "MANUSCRIPT"
          ? <button type="button" className={consoleButtonClass("primary")} onClick={() => setWorkspaceSection("page")}>原稿を完成</button>
          : nextAction === "PHOTOS"
            ? <button type="button" className={consoleButtonClass("primary")} onClick={() => setWorkspaceSection("page")}>写真を追加</button>
            : nextAction === "SUPPORT"
              ? <Link className={consoleButtonClass("primary")} href={page("/host/settings#settings-support")}>サポート・手数料の条件を確認</Link>
            : nextAction === "PAYMENT_CONSENT" && paymentConsentHref
              ? <a className={consoleButtonClass("primary")} href={paymentConsentHref} referrerPolicy="no-referrer">{paymentConsentLabel}</a>
            : nextAction === "PUBLISH"
              ? <button type="button" disabled={busy || !canPublish} className={consoleButtonClass("primary")} onClick={() => void changeState("publish")}>同意して公開</button>
              : nextAction === "LIVE" && publicHref
                ? <Link className={consoleButtonClass("primary")} href={publicHref}>公開ページを見る</Link>
                : null;
  const nextActionText = conflictProduct ? "競合を解消してから保存・公開できます。現在の入力は保持しています。"
    : adminDraft ? (dirty ? "代理登録中の入力を保存してください。" : !product.adminEnglishReview?.reviewed ? (product.draft.content.japaneseOnly === true ? "現在の日本語原稿を事務局レビューとして確認してください。" : "現在の日英原稿を事務局レビューとして確認してください。") : savedBlockers.length ? "通常公開と同じ未完了条件を解消してください。" : "販売者への確認方法と写真掲載権利を記録すると、事務局として代理公開できます。")
    : nextAction === "SAVE" ? "まず、現在の入力を保存してください。公開可否は保存済みの内容で判定します。"
    : nextAction === "SCHEDULE" ? "次に、旅行者が選べる開催枠をこの商品へ追加してください。"
      : nextAction === "PRICING" ? "開催枠を確認したうえで、基本料金または枠別料金、人数、取消条件を保存してください。"
        : nextAction === "MANUSCRIPT" ? "日本語と英語の公開原稿を完成し、英語原稿を確認してください。"
          : nextAction === "PHOTOS" ? "掲載許諾を確認した商品写真と、日本語・英語の説明を追加してください。"
            : nextAction === "SUPPORT" ? "予約受付の前に、NIHOサポートの利用範囲と合計手数料の条件を確認してください。"
            : nextAction === "PAYMENT_CONSENT" ? "現在の受取口座をExperienceで利用する同意を、NIHOで確認してください。"
            : nextAction === "EXTERNAL" ? "本人・受取口座・手数料・掲載条件の確認が必要です。下の未完了項目を確認してください。"
              : nextAction === "PUBLISH" ? "保存済みの公開内容と販売条件を確認し、掲載条件に同意して公開できます。"
                : "公開中です。旅行者の詳細ページと予約画面を確認できます。";
  const timelineSection = (locale: "en" | "ja", items: TimelineItem[]) => <section className="space-y-3 rounded-xl border border-line p-3">
    <div className="flex items-center justify-between gap-3"><h3 className="font-bold">{locale === "ja" ? "当日の流れ（日本語）" : "Schedule of the experience (English)"}</h3><button type="button" disabled={busy} className={consoleButtonClass("secondary", "sm")} onClick={() => addTimeline(locale)}>項目を追加</button></div>
    {items.map((item, index) => <div key={`${locale}-${index}`} className="grid gap-3 rounded-xl bg-sand/40 p-3 md:grid-cols-2">
      <Field label={locale === "ja" ? "時刻・目安（日本語）" : "Time or duration"} value={item.time} onChange={(next) => updateTimeline(locale, index, "time", next)} />
      <Field label={locale === "ja" ? "見出し（日本語）" : "Heading (English)"} value={item.title} onChange={(next) => updateTimeline(locale, index, "title", next)} />
      <Field label={locale === "ja" ? "説明（日本語）" : "Description (English)"} value={item.text} multiline rows={2} onChange={(next) => updateTimeline(locale, index, "text", next)} />
      <label className="block text-sm font-bold text-ink-soft">{locale === "ja" ? "添える写真" : "Photo"}<select value={item.photoIndex ?? ""} onChange={(event) => updateTimeline(locale, index, "photoIndex", event.target.value === "" ? null : Number(event.target.value))} className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2"><option value="">指定しない</option>{galleryMedia.map((photo) => <option key={photo.id} value={photo.sourcePosition}>{photo.altText || photo.altTextJa || "写真"}</option>)}</select></label>
      <button type="button" disabled={busy} className={`${consoleButtonClass("ghost", "sm")} justify-self-start`} onClick={() => removeTimeline(locale, index)}>この項目を削除</button>
    </div>)}
    {!items.length ? <p className="text-sm text-muted">当日の流れを表示する場合は項目を追加してください。</p> : null}
  </section>;
  const faqSection = (locale: "en" | "ja") => {
    const rows = publicationFaqRows(locale === "ja" ? (isRecord(content.ja) ? content.ja.faq : undefined) : content.faq);
    const language = locale === "ja" ? "日本語" : "英語";
    const problem = publicationFaqProblem(rows, language);
    const full = rows.length >= PUBLICATION_FAQ_LIMITS.maxItems;
    const change = (index: number, key: keyof PublicationFaqRow, value: string) => updateFaq(locale, rows.map((row, at) => at === index ? { ...row, [key]: value } : row));
    return <section className="space-y-3 rounded-xl border border-line p-3" aria-labelledby={`publication-faq-${locale}`}>
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 id={`publication-faq-${locale}`} className="font-bold">よくある質問（{language}・任意）</h3><button type="button" disabled={busy || full} className={consoleButtonClass("secondary", "md", "min-h-11")} onClick={() => updateFaq(locale, [...rows, { question: "", answer: "" }])}>質問を追加</button></div>
      <p className="text-xs text-muted">{locale === "ja" ? "予約前によく聞かれることを質問と答えの組で書きます。書かなければ公開ページに表示しません。" : "英語ページに表示する質問と答えです。日本語から英語案を作成すると翻訳案が入ります。"}最大{PUBLICATION_FAQ_LIMITS.maxItems}件、質問{PUBLICATION_FAQ_LIMITS.questionMaxLength}文字・答え{PUBLICATION_FAQ_LIMITS.answerMaxLength}文字まで。</p>
      {rows.map((row, index) => <div key={`${locale}-faq-${index}`} className="grid gap-2 rounded-xl bg-sand/40 p-3">
        <Field label={`質問${index + 1}（${language}）`} value={row.question} onChange={(next) => change(index, "question", next)} />
        <p className={`text-right text-xs ${row.question.length > PUBLICATION_FAQ_LIMITS.questionMaxLength ? "font-bold text-danger" : "text-muted"}`}>{row.question.length}/{PUBLICATION_FAQ_LIMITS.questionMaxLength}文字</p>
        <Field label={`答え${index + 1}（${language}）`} value={row.answer} multiline rows={3} onChange={(next) => change(index, "answer", next)} />
        <p className={`text-right text-xs ${row.answer.length > PUBLICATION_FAQ_LIMITS.answerMaxLength ? "font-bold text-danger" : "text-muted"}`}>{row.answer.length}/{PUBLICATION_FAQ_LIMITS.answerMaxLength}文字</p>
        <button type="button" disabled={busy} className={`${consoleButtonClass("ghost", "md", "min-h-11")} justify-self-start`} onClick={() => updateFaq(locale, rows.filter((_, at) => at !== index))}>この質問を削除</button>
      </div>)}
      {full ? <p className="text-sm text-muted">質問は{PUBLICATION_FAQ_LIMITS.maxItems}件まで追加できます。</p> : null}
      <p aria-live="polite" className="text-sm font-bold text-danger">{problem ?? ""}</p>
    </section>;
  };
  const updatePhoto = (id: string, patch: Partial<Pick<Media, "altText" | "altTextJa" | "publicCredit">>) => setMediaDraft((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  const updateProviderPhoto = (id: string, patch: Partial<Pick<ProviderMedia, "altText" | "altTextJa" | "publicCredit">>) => setProviderMediaDraft((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  const movePhoto = (id: string, direction: -1 | 1) => setMediaDraft((current) => {
    const gallery = current.filter((item) => item.placement === "GALLERY");
    const index = gallery.findIndex((item) => item.id === id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= gallery.length) return current;
    [gallery[index], gallery[nextIndex]] = [gallery[nextIndex]!, gallery[index]!];
    let cursor = 0;
    return current.map((item) => item.placement === "GALLERY" ? gallery[cursor++]! : item);
  });
  const removePhoto = (id: string) => {
    const photo = mediaDraft.find((item) => item.id === id);
    if (!photo) return;
    setMediaDraft((current) => current.filter((item) => item.id !== id));
    if (photo.placement !== "GALLERY") return;
    updateEnglishContent("timeline", timelineItems(content.timeline).map((item) => item.photoIndex === photo.sourcePosition ? { ...item, photoIndex: null } : item));
    const japanese = japaneseManuscript(content);
    updateJapanese("timeline", japanese.timeline.map((item) => item.photoIndex === photo.sourcePosition ? { ...item, photoIndex: null } : item));
    if (isRecord(content.meetingPoint) && content.meetingPoint.exteriorPhotoIndex === photo.sourcePosition) updateContent("meetingPoint", { ...content.meetingPoint, exteriorPhotoIndex: null });
  };

  if (!adminDraft) {
    const japanese = japaneseManuscript(content);
    const english = {
      title: publicationEnglishTitle(content, title),
      lead: typeof content.lead === "string" ? content.lead : "",
      description: typeof content.description === "string" ? content.description : "",
      language: isRecord(content.facts) && typeof content.facts.language === "string" ? content.facts.language : "",
      highlights: stringRows(content.highlights),
      included: stringRows(content.included),
      notIncluded: stringRows(content.notIncluded),
      knowBeforeYouGo: stringRows(content.knowBeforeYouGo),
      notSuitableFor: stringRows(content.notSuitableFor),
    };
    type TextKey = "title" | "lead" | "description" | "language";
    type RowKey = "highlights" | "included" | "notIncluded" | "knowBeforeYouGo" | "notSuitableFor";
    const NAME = { en: "英語", ja: "日本語" } as const;
    const japaneseOnly = content.japaneseOnly === true;
    const L: "en" | "ja" = editorLocale ?? (listing.en ? "en" : "ja");
    const O: "en" | "ja" = L === "en" ? "ja" : "en";
    const englishWritten = manuscriptHasContent(english);
    const japaneseWritten = manuscriptHasContent(japanese);
    const showCompare = compare && englishWritten && japaneseWritten;
    // 英語と日本語の両方を掲載するときだけ: the tab of the language that follows the other is told when the source moved on.
    const sync = readLanguageSync(content);
    const syncCurrent = sync.source === "ja" ? japaneseFingerprint : englishFingerprint;
    const languageStale = languageSyncOutOfSync({ listing, japaneseWritten, englishWritten, remembered: sync.remembered, current: syncCurrent });
    const staleTab = languageSyncFollower(sync.source);
    const manuscriptOf = (locale: "en" | "ja") => (locale === "ja" ? japanese : english);
    const setText = (key: TextKey, next: string) => {
      if (L === "ja") updateJapanese(key, next);
      else if (key === "title") updateEnglishTitle(next);
      else if (key === "language") updateEnglishContent("facts", { ...(isRecord(content.facts) ? content.facts : {}), language: next });
      else updateEnglishContent(key, next);
    };
    const setRows = (key: RowKey, next: string[]) => { if (L === "ja") updateJapanese(key, next); else updateEnglishContent(key, next); };
    const manuscriptField = (label: string, key: TextKey, options: { rows?: number; info?: string } = {}) => (
      <EditorField label={label} rows={options.rows} info={options.info} value={manuscriptOf(L)[key]} onChange={(next) => setText(key, next)}
        reference={showCompare ? <EditorReference language={NAME[O]} text={manuscriptOf(O)[key]} /> : undefined} />
    );
    const rowsEditor = (label: string, key: RowKey, small?: string) => (
      <EditorRows label={label} small={small} values={manuscriptOf(L)[key]} onChange={(next) => setRows(key, next)} disabled={busy}
        references={showCompare ? manuscriptOf(O)[key] : undefined} language={NAME[O]} />
    );
    const makeCoverPhoto = (id: string) => setMediaDraft((current) => {
      const gallery = current.filter((item) => item.placement === "GALLERY");
      const selected = gallery.find((item) => item.id === id);
      if (!selected || gallery[0]?.id === id) return current;
      const ordered = [selected, ...gallery.filter((item) => item.id !== id)];
      let cursor = 0;
      return current.map((item) => item.placement === "GALLERY" ? ordered[cursor++]! : item);
    });
    const openPhotoDialog = (kind: "gallery" | "provider") => {
      setPhotoPlacement(kind === "gallery" ? "GALLERY" : "PROVIDER_PHOTO");
      setPhotoRights(null);
      setPhotoDialog(kind);
    };
    const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

    const activeIndex = mediaDraft.findIndex((item) => item.id === activePhotoId);
    const activePhoto = activeIndex >= 0 ? mediaDraft[activeIndex]! : null;
    const timeline = L === "ja" ? japanese.timeline : timelineItems(content.timeline);
    const otherTimeline = O === "ja" ? japanese.timeline : timelineItems(content.timeline);
    const faqRows = publicationFaqRows(L === "ja" ? japanese.faq : content.faq);
    const otherFaqRows = publicationFaqRows(O === "ja" ? japanese.faq : content.faq);
    const faqProblem = publicationFaqProblem(faqRows, NAME[L]);
    const faqFull = faqRows.length >= PUBLICATION_FAQ_LIMITS.maxItems;
    const changeFaq = (index: number, key: keyof PublicationFaqRow, value: string) => updateFaq(L, faqRows.map((row, at) => at === index ? { ...row, [key]: value } : row));
    const disclosure = content.meetingPointDisclosure === "PUBLIC" ? "PUBLIC" : "AFTER_BOOKING";
    const publicMapPoint = mapCoordinate(content.publicMapPoint);
    const publicMapArea = mapArea(content.publicMapArea);

    const pillBase = "inline-flex h-[26px] items-center gap-1.5 rounded-full px-[11px] text-xs font-extrabold whitespace-nowrap before:size-1.5 before:rounded-full before:bg-current before:content-['']";
    const statusTone = product.status === "PUBLISHED" ? "bg-leaf-pale text-moss"
      : product.status === "DRAFT" ? "bg-sand text-ink-soft"
        : product.status === "RESTART_REQUIRED" ? "bg-warn-pale text-warn" : "bg-danger-pale text-danger";
    // Booking reasons are normal on a page whose bookings are not open yet: they only say "changes not shown" while bookings are open.
    const pendingChanges = product.status === "PUBLISHED" && (product.publicationNeedsUpdate || (bookingIsOpen && savedBlockers.length > 0));
    const titleText = L === "ja" ? japanese.title || english.title || "体験を編集" : english.title || japanese.title || "体験を編集";
    const dialogBlockers = blockerScope === "page" ? stages.page.blockers : stages.booking.blockers;
    const blockerGoal = blockerScope === "booking" ? (product.status === "STOPPED" || product.status === "RESTART_REQUIRED" ? "予約の受付を再開する" : "予約の受付を始める")
      : product.status === "PUBLISHED" ? "公開中のページに反映する" : product.status === "STOPPED" || product.status === "RESTART_REQUIRED" ? "ページを公開し直す" : "ページを公開する";
    const markedTabs = new Set<string>();
    if (blockersShown && !dirty) for (const blocker of savedBlockers) { const destination = publicationBlockerDestination(blocker); if (destination?.kind === "tab") markedTabs.add(destination.tab); }
    const missingAltMark = blockersShown && savedBlockers.includes("PHOTOS_REQUIRED");
    const perOffer = perOfferOpen ?? terms.offerPrices.some((price) => price.adultPriceYen !== "");
    const sectionClass = `${HOST_SURFACE} scroll-mt-4 p-4 md:p-6`;
    const headingClass = "mb-3.5 flex flex-wrap items-center text-base font-extrabold";
    /** The small tag on a section (#706): what it is needed for, and once it is saved and met, 「入力済み」. */
    const savedNeeds = new Set(savedBlockers);
    const tag = (need: SectionNeed, codes: readonly string[] = []) => {
      const met = need !== "optional" && !codes.some((code) => savedNeeds.has(code));
      const tone = met ? "bg-leaf-pale text-moss" : need === "page" ? "bg-warn-pale text-warn" : "bg-sand text-ink-soft";
      return <small data-section-need={met ? "met" : need} className={`ml-2 inline-flex h-5 items-center rounded-full px-2 text-[0.6875rem] font-extrabold ${tone}`}>{met ? "✓ 入力済み" : SECTION_NEED_LABEL[need]}</small>;
    };
    const setTermsField = <K extends keyof PublicationTermsForm>(key: K, value: PublicationTermsForm[K]) => setTerms((current) => ({ ...current, [key]: value }));
    const classificationShown = listing.ja && !classification.hidden && classification.value !== null;

    const otherWritten = L === "en" ? japaneseWritten : englishWritten;
    const currentWritten = L === "en" ? englishWritten : japaneseWritten;
    const tabButton = (locale: "en" | "ja") => (
      <button type="button" aria-pressed={L === locale} className={`inline-flex h-9 items-center gap-1.5 rounded-[9px] px-[18px] text-[0.84375rem] font-extrabold ${L === locale ? "bg-sand text-ink" : "text-muted"}`} onClick={() => setEditorLocale(locale)}>
        {NAME[locale]}
        {!listing[locale] ? <span className="rounded-full bg-sand px-2 py-px text-[0.6875rem] font-extrabold text-ink-soft">掲載しない</span> : null}
        {languageStale && staleTab === locale ? <span role="img" aria-label={`${NAME[locale === "en" ? "ja" : "en"]}のほうが新しい`} className="inline-block size-[7px] rounded-full bg-warn" /> : null}
      </button>
    );
    const languageBar = <div className="mb-4 flex flex-wrap items-center gap-1.5">
      <div className="inline-flex rounded-xl border border-line-strong bg-canvas p-[3px]" role="group" aria-label="原稿の言語">
        {tabButton("en")}
        {tabButton("ja")}
      </div>
      <HostInfoTip label="原稿の言語">「英語」は英語ページ、「日本語」は日本語ページの原稿です。直接書いても、もう一方の言語から翻訳しても作れます。翻訳はボタンを押したときだけ行われ、自動では書き換わりません。掲載しない言語は、翻訳のもとになる下書きとして使えます。写真の並び・料金・日程は共通です。</HostInfoTip>
      <span className="grow" />
      {englishWritten && japaneseWritten ? <button type="button" aria-pressed={compare} className={`${consoleButtonClass("ghost", "sm")} ${compare ? "bg-sand text-ink" : ""}`} onClick={() => setCompare((current) => !current)}>{compare ? "✓ " : ""}{NAME[O]}と見比べる</button> : null}
      <button type="button" disabled={busy || translationBusy || !otherWritten} className={consoleButtonClass(!currentWritten && otherWritten ? "primary" : "secondary", "sm")} onClick={() => requestTranslation(L)}>{translationBusy ? "翻訳中…" : `${NAME[O]}から翻訳`}</button>
    </div>;
    const staleNotice = languageStale && L === staleTab ? <section className="flex flex-wrap items-center justify-between gap-3.5 rounded-2xl bg-warn-pale px-[18px] py-3.5 text-ink">
      <p className="flex min-w-40 flex-1 items-center font-bold">{NAME[O]}を変えたあと、{NAME[L]}は変わっていません<HostInfoTip label="言語のずれ">もう一方の言語を変えても、こちらは自動では書き換わりません。翻訳し直すか、このままでよければ知らせを消せます。公開は止まりません。</HostInfoTip></p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || translationBusy} className={consoleButtonClass("secondary", "sm")} onClick={() => requestTranslation(L)}>{NAME[O]}から翻訳し直す</button>
        <button type="button" disabled={busy || syncCurrent === null} className={consoleButtonClass("ghost", "sm")} onClick={() => { if (syncCurrent !== null) setContent((current) => withLanguageSync(current, sync.source, syncCurrent)); }}>このままでよい</button>
      </div>
    </section> : null;

    const photoSection = <section id="publication-photos" className={sectionClass} aria-labelledby="publication-photos-title">
      <h2 id="publication-photos-title" className={headingClass}>写真{tag("page", ["PHOTOS_REQUIRED"])}<HostInfoTip label="写真">1枚目が体験ページの表紙です。写真を選ぶと、説明と並び順を変えられます。並び順は英語と日本語で共通です。</HostInfoTip></h2>
      <div className="grid grid-cols-3 gap-2.5 md:grid-cols-4">
        {mediaDraft.map((photo, index) => <button key={photo.id} type="button" aria-pressed={photo.id === activePhotoId} aria-label={`写真 ${index + 1}${index === 0 ? "（表紙）" : ""}を編集`} onClick={() => setActivePhotoId((current) => current === photo.id ? null : photo.id)} className={`relative block aspect-[4/3] w-full overflow-hidden rounded-xl border-2 bg-sand ${photo.id === activePhotoId ? "border-ink" : "border-transparent"}`}>
          <Image src={photo.previewUrl} alt="" width={160} height={120} unoptimized className="size-full object-cover" />
          {missingAltMark && !(L === "ja" ? photo.altTextJa : photo.altText).trim() ? <span className="absolute right-[7px] bottom-[7px] rounded-full bg-warn-pale px-[9px] py-px text-[0.6875rem] font-extrabold text-warn">説明なし</span> : null}
          {index === 0 ? <span className="absolute top-[7px] left-[7px] rounded-full bg-canvas px-[9px] py-px text-[0.6875rem] font-extrabold">表紙</span> : <span className="absolute top-1.5 right-2 text-[0.6875rem] font-extrabold text-canvas [text-shadow:0_1px_2px_rgb(0_0_0/0.35)]">{index + 1}</span>}
        </button>)}
        <button type="button" disabled={!!conflictProduct} onClick={() => openPhotoDialog("gallery")} className="grid aspect-[4/3] w-full place-items-center rounded-xl border-[1.5px] border-dashed border-line-strong bg-sand text-[0.8125rem] font-extrabold text-ink-soft hover:bg-line">＋ 写真を追加</button>
      </div>
      {!mediaDraft.length ? <p className="mt-3 text-sm text-muted">表紙の写真がありません。公開するには、掲載許諾を確認した写真を追加してください。</p> : null}
      {activePhoto ? <div className="mt-3 rounded-2xl bg-sand p-4">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2.5">
          <b>写真 {activeIndex + 1}{activeIndex === 0 ? " · 表紙" : ""}</b>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" aria-label={`写真 ${activeIndex + 1} を表紙にする`} disabled={busy || mediaDraft[0]?.id === activePhoto.id} className={consoleButtonClass("secondary", "sm")} onClick={() => makeCoverPhoto(activePhoto.id)}>表紙にする</button>
            <button type="button" aria-label={`写真 ${activeIndex + 1} を前へ`} disabled={busy || mediaDraft[0]?.id === activePhoto.id} className={consoleButtonClass("secondary", "sm")} onClick={() => movePhoto(activePhoto.id, -1)}>前へ</button>
            <button type="button" aria-label={`写真 ${activeIndex + 1} を後ろへ`} disabled={busy || mediaDraft.at(-1)?.id === activePhoto.id} className={consoleButtonClass("secondary", "sm")} onClick={() => movePhoto(activePhoto.id, 1)}>後ろへ</button>
            <button type="button" aria-label={`写真 ${activeIndex + 1} を下書きから外す`} disabled={busy} className={`${consoleButtonClass("secondary", "sm")} text-danger`} onClick={() => { removePhoto(activePhoto.id); setActivePhotoId(null); }}>外す</button>
          </div>
        </div>
        <EditorField label="写真の説明" info="何が写っているかを一言で書きます。読み上げと検索に使われます。" value={L === "ja" ? activePhoto.altTextJa : activePhoto.altText}
          onChange={(next) => updatePhoto(activePhoto.id, L === "ja" ? { altTextJa: next } : { altText: next })}
          reference={showCompare ? <EditorReference language={NAME[O]} text={O === "ja" ? activePhoto.altTextJa : activePhoto.altText} /> : undefined} />
        <EditorField label="クレジット" small="任意" placeholder="撮影者名など" value={activePhoto.publicCredit ?? ""} onChange={(next) => updatePhoto(activePhoto.id, { publicCredit: next.trim() ? next : null })} />
      </div> : null}
    </section>;

    const timelineSection = <section id="publication-timeline" className={sectionClass} aria-labelledby="publication-timeline-title">
      <h2 id="publication-timeline-title" className={headingClass}>当日の流れ{tag("optional")}</h2>
      <div className="grid gap-2">
        {timeline.map((item, index) => <div key={index}>
          <div className="grid grid-cols-[1fr_34px] items-start gap-2 rounded-xl bg-sand p-2.5 md:grid-cols-[96px_1fr_34px]">
            <input aria-label={`時刻 ${index + 1}`} value={item.time} onChange={(event) => updateTimeline(L, index, "time", event.target.value)} className={`${EDITOR_INPUT} col-start-1 row-start-1`} />
            <div className="col-span-2 row-start-2 grid gap-1.5 md:col-span-1 md:col-start-2 md:row-start-1">
              <input aria-label={`見出し ${index + 1}`} value={item.title} onChange={(event) => updateTimeline(L, index, "title", event.target.value)} className={EDITOR_INPUT} />
              <textarea aria-label={`説明 ${index + 1}`} rows={2} value={item.text} onChange={(event) => updateTimeline(L, index, "text", event.target.value)} className={`${EDITOR_INPUT} resize-y`} />
              <select aria-label={`添える写真 ${index + 1}`} value={item.photoIndex ?? ""} onChange={(event) => updateTimeline(L, index, "photoIndex", event.target.value === "" ? null : Number(event.target.value))} className={EDITOR_INPUT}>
                <option value="">写真を添えない</option>
                {galleryMedia.map((photo, at) => <option key={photo.id} value={photo.sourcePosition}>写真 {at + 1}</option>)}
              </select>
            </div>
            <button type="button" aria-label={`項目 ${index + 1} を削除`} onClick={() => removeTimeline(L, index)} className="col-start-2 row-start-1 h-10 w-[34px] rounded-[9px] text-[1.0625rem] text-muted hover:bg-line hover:text-ink md:col-start-3">×</button>
          </div>
          {showCompare && otherTimeline[index] ? <EditorReference language={NAME[O]} text={`${otherTimeline[index]!.title}　${otherTimeline[index]!.text}`} /> : null}
        </div>)}
        <button type="button" onClick={() => addTimeline(L)} className="justify-self-start px-0.5 py-1.5 text-[0.8125rem] font-extrabold text-moss">＋ 項目を足す</button>
      </div>
    </section>;

    const faqSection = <div role="group" aria-labelledby="publication-faq-title">
      <EditorSubheading id="publication-faq-title" label="よくある質問" small="任意" info="予約前によく聞かれることを、質問と答えの組で書きます。書かなければ公開ページに出ません。" />
      <p className="mb-2 text-xs text-muted">最大{PUBLICATION_FAQ_LIMITS.maxItems}件、質問{PUBLICATION_FAQ_LIMITS.questionMaxLength}文字・答え{PUBLICATION_FAQ_LIMITS.answerMaxLength}文字まで。</p>
      <div className="grid gap-2">
        {faqRows.map((row, index) => <div key={index}>
          <div className="grid grid-cols-[1fr_34px] gap-2 rounded-xl bg-sand p-2.5">
            <div className="grid gap-1.5">
              <input aria-label={`質問 ${index + 1}`} placeholder="質問" value={row.question} onChange={(event) => changeFaq(index, "question", event.target.value)} className={EDITOR_INPUT} />
              <p className={`text-right text-xs ${row.question.length > PUBLICATION_FAQ_LIMITS.questionMaxLength ? "font-bold text-danger" : "text-muted"}`}>{row.question.length}/{PUBLICATION_FAQ_LIMITS.questionMaxLength}文字</p>
              <textarea aria-label={`答え ${index + 1}`} placeholder="答え" rows={2} value={row.answer} onChange={(event) => changeFaq(index, "answer", event.target.value)} className={`${EDITOR_INPUT} resize-y`} />
              <p className={`text-right text-xs ${row.answer.length > PUBLICATION_FAQ_LIMITS.answerMaxLength ? "font-bold text-danger" : "text-muted"}`}>{row.answer.length}/{PUBLICATION_FAQ_LIMITS.answerMaxLength}文字</p>
            </div>
            <button type="button" aria-label={`質問 ${index + 1} を削除`} onClick={() => updateFaq(L, faqRows.filter((_, at) => at !== index))} className="h-10 w-[34px] rounded-[9px] text-[1.0625rem] text-muted hover:bg-line hover:text-ink">×</button>
          </div>
          {showCompare && otherFaqRows[index] ? <EditorReference language={NAME[O]} text={`${otherFaqRows[index]!.question}　${otherFaqRows[index]!.answer}`} /> : null}
        </div>)}
        <button type="button" disabled={faqFull} onClick={() => updateFaq(L, [...faqRows, { question: "", answer: "" }])} className="justify-self-start px-0.5 py-1.5 text-[0.8125rem] font-extrabold text-moss disabled:opacity-45">＋ 質問を足す</button>
      </div>
      {faqFull ? <p className="text-sm text-muted">質問は{PUBLICATION_FAQ_LIMITS.maxItems}件まで追加できます。</p> : null}
      <p aria-live="polite" className="text-sm font-bold text-danger">{faqProblem ?? ""}</p>
    </div>;

    const hostSection = <section id="publication-host" className={sectionClass} aria-labelledby="publication-host-title">
      <h2 id="publication-host-title" className={headingClass}>迎える人{tag("optional")}<HostInfoTip label="迎える人">販売者の表示と、提供者の写真・ロゴです。すべての体験に同じ内容が出ます。</HostInfoTip></h2>
      <p className="text-sm text-ink-soft">販売者表示: <span className="font-bold text-ink">{product.sellerDisplayName || "未設定"}</span></p>
      <div className="mt-3 grid gap-3">
        {providerMediaDraft.map((photo) => <div key={photo.id} className="grid gap-3 rounded-xl border border-line p-3 md:grid-cols-[5rem_1fr]">
          <Image src={photo.previewUrl} alt={L === "ja" ? photo.altTextJa : photo.altText} width={80} height={80} unoptimized className="size-20 rounded-lg object-cover" />
          <div>
            <p className="text-sm font-bold text-ink-soft">{photo.placement === "PROVIDER_PHOTO" ? "提供者写真" : "事業者ロゴ"}</p>
            <EditorField label="写真の説明" value={L === "ja" ? photo.altTextJa : photo.altText} onChange={(next) => updateProviderPhoto(photo.id, L === "ja" ? { altTextJa: next } : { altText: next })}
              reference={showCompare ? <EditorReference language={NAME[O]} text={O === "ja" ? photo.altTextJa : photo.altText} /> : undefined} />
            <EditorField label="クレジット" small="任意" value={photo.publicCredit ?? ""} onChange={(next) => updateProviderPhoto(photo.id, { publicCredit: next.trim() ? next : null })} />
            <button type="button" disabled={busy || !!conflictProduct} className={`${consoleButtonClass("secondary", "sm")} mt-3`} onClick={() => void removeProviderMedia(photo.id)}>全商品から削除</button>
          </div>
        </div>)}
        {!providerMediaDraft.length ? <p className="text-sm text-muted">提供者写真・事業者ロゴは未設定です。</p> : null}
        <button type="button" disabled={!!conflictProduct} className={`${consoleButtonClass("secondary", "sm")} justify-self-start`} onClick={() => openPhotoDialog("provider")}>写真を追加</button>
      </div>
    </section>;

    const pageTab = <>
      {languageBar}
      <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_176px] md:items-start">
        <div className="grid min-w-0 gap-4">
          {staleNotice}
          {photoSection}
          <section id="publication-intro" className={sectionClass} aria-labelledby="publication-intro-title">
            <h2 id="publication-intro-title" className={headingClass}>紹介{tag("page", ["MANUSCRIPT_REQUIRED", "PUBLIC_CONTENT_INVALID"])}</h2>
            {manuscriptField("体験名", "title")}
            {manuscriptField("ひとこと紹介", "lead", { rows: 2 })}
            {manuscriptField("当日の言語", "language")}
            {manuscriptField("詳しい説明", "description", { rows: 6 })}
          </section>
          <section id="publication-highlights" className={sectionClass} aria-labelledby="publication-highlights-title">
            <h2 id="publication-highlights-title" className={headingClass}>見どころ・含まれるもの{tag("optional")}</h2>
            {rowsEditor("見どころ", "highlights")}
            {rowsEditor("含まれるもの", "included")}
            {rowsEditor("含まれないもの", "notIncluded")}
          </section>
          {timelineSection}
          <section id="publication-meeting" className={sectionClass} aria-labelledby="publication-meeting-title">
            <h2 id="publication-meeting-title" className={headingClass}>集合場所{tag("optional")}</h2>
            <EditorChoice name="meeting-disclosure" legend="集合場所を見せる時期" info="「予約が確定してから案内する」では、公開ページに「集合の概要」だけが出ます。「予約前から公開する」では、公開ページに集合場所が出ます。英語と日本語で共通です。"
              value={disclosure} onChange={(next) => setContent((current) => ({ ...current, meetingPointDisclosure: next, publicMapPoint: next === "PUBLIC" ? current.publicMapPoint ?? null : null, publicMapArea: next === "AFTER_BOOKING" ? current.publicMapArea ?? null : null }))}
              options={[{ value: "AFTER_BOOKING", label: "予約が確定してから案内する" }, { value: "PUBLIC", label: "予約前から公開する" }]} />
            {L === "en" ? <EditorField label="集合の概要" rows={2} info="予約前の公開ページに出る、大まかな場所の案内です。英語のページにだけ出ます。" value={typeof content.meetingOverview === "string" ? content.meetingOverview : ""} onChange={(next) => updateContent("meetingOverview", next || null)} /> : null}
            <div className="mt-4 space-y-3">
              <p className="text-sm text-ink-soft">{disclosure === "PUBLIC" ? "公開してよい地点を地図上で選びます。" : "予約後に案内する地点ではなく、公開してよい範囲の中心を選びます。公開されるのは中心と半径だけです。"}</p>
              <MapboxLocationMap
                point={disclosure === "PUBLIC" ? publicMapPoint : null}
                area={disclosure === "AFTER_BOOKING" ? publicMapArea : null}
                editable
                label={disclosure === "PUBLIC" ? "公開する集合場所のピン" : "公開する集合エリア"}
                locale="ja"
                onChoose={(coordinate) => setContent((current) => disclosure === "PUBLIC"
                  ? { ...current, publicMapPoint: coordinate, publicMapArea: null }
                  : { ...current, publicMapPoint: null, publicMapArea: { ...coordinate, radiusMeters: mapArea(current.publicMapArea)?.radiusMeters ?? 500 } })}
              />
              <MeetingCoordinatesEditor
                value={disclosure === "PUBLIC" ? publicMapPoint : publicMapArea}
                approximate={disclosure === "AFTER_BOOKING"}
                radius={publicMapArea?.radiusMeters ?? 500}
                onChange={(coordinate) => setContent((current) => disclosure === "PUBLIC"
                  ? { ...current, publicMapPoint: coordinate, publicMapArea: null }
                  : { ...current, publicMapPoint: null, publicMapArea: coordinate ? { ...coordinate, radiusMeters: mapArea(current.publicMapArea)?.radiusMeters ?? 500 } : null })}
                onRadiusChange={(radiusMeters) => setContent((current) => {
                  const center = mapArea(current.publicMapArea);
                  return center ? { ...current, publicMapArea: { ...center, radiusMeters } } : current;
                })}
              />
            </div>
          </section>
          <section id="publication-notes" className={sectionClass} aria-labelledby="publication-notes-title">
            <h2 id="publication-notes-title" className={headingClass}>注意事項・よくある質問{tag("optional")}</h2>
            {rowsEditor("参加前の注意", "knowBeforeYouGo")}
            {rowsEditor("参加に向かない条件", "notSuitableFor", "任意")}
            <div className="mt-5">{faqSection}</div>
          </section>
          {hostSection}
        </div>
        <nav aria-label="このページの項目" className="sticky top-4 hidden gap-0.5 text-[0.8125rem] md:grid">
          <b className="mb-1.5 text-[0.6875rem] tracking-[0.04em] text-muted">このページ</b>
          {([["publication-photos", "写真"], ["publication-intro", "紹介"], ["publication-highlights", "見どころ"], ["publication-timeline", "当日の流れ"], ["publication-meeting", "集合場所"], ["publication-notes", "注意・質問"], ["publication-host", "迎える人"]] as const).map(([id, label]) => (
            <button key={id} type="button" onClick={() => scrollTo(id)} className="rounded-lg px-2.5 py-1.5 text-left text-ink-soft hover:bg-sand hover:text-ink">{label}</button>
          ))}
        </nav>
      </div>
    </>;

    const pricingTab = <div className="grid max-w-[720px] gap-4">
      <section id="publication-price" className={sectionClass} aria-labelledby="publication-price-title">
        <h2 id="publication-price-title" className={headingClass}>料金{tag("page", ["PRICE_REQUIRED"])}</h2>
        <EditorUnitField label="大人1人" small="税込" prefix="¥" info="無料の体験は0円にします。有料は50円以上にしてください。" value={unitAmount} onChange={setUnitAmount} />
        <EditorSwitch label="子ども料金を設定する" checked={terms.childPricingEnabled} onChange={(on) => setTermsField("childPricingEnabled", on)} />
        {terms.childPricingEnabled ? <div className="mt-2.5 border-l-2 border-line pl-4">
          <EditorUnitField label="子ども1人" small="税込" prefix="¥" value={terms.childPriceYen} onChange={(next) => setTermsField("childPriceYen", next)} />
          <EditorUnitField label="対象の年齢" suffix="歳" value={terms.childMinAge} onChange={(next) => setTermsField("childMinAge", next)} to={{ label: "対象の年齢（上限）", value: terms.childMaxAge, onChange: (next) => setTermsField("childMaxAge", next) }} />
          <label className="mt-3.5 flex items-center gap-2 text-sm font-bold"><input type="checkbox" checked={terms.childAdultRequired} onChange={(event) => setTermsField("childAdultRequired", event.target.checked)} className="accent-moss" />大人の同伴を必須にする</label>
        </div> : null}
        <EditorSwitch label="開催枠ごとに料金を変える" checked={perOffer} info="枠ごとに大人1人の料金を変えられます。空欄の枠には、保存するときに上の大人1人の料金が入ります。"
          onChange={(on) => { setPerOfferOpen(on); if (!on) setTerms((current) => ({ ...current, offerPrices: current.offerPrices.map((price) => ({ ...price, adultPriceYen: "" })) })); }} />
        {perOffer ? <div className="mt-2.5 border-l-2 border-line pl-4">
          {product.offers.length ? product.offers.map((offer) => {
            const price = terms.offerPrices.find((item) => item.offerId === offer.id)?.adultPriceYen ?? "";
            return <EditorUnitField key={offer.id} label={offerLabel(offer)} prefix="¥" placeholder={unitAmount} value={price}
              onChange={(next) => setTerms((current) => ({ ...current, offerPrices: current.offerPrices.map((item) => item.offerId === offer.id ? { ...item, adultPriceYen: next } : item) }))} />;
          }) : <p className="text-sm font-bold text-warn">先にカレンダーで開催枠を追加すると、枠別料金を入力できます。</p>}
        </div> : null}
      </section>
      <section id="publication-party" className={sectionClass} aria-labelledby="publication-party-title">
        <h2 id="publication-party-title" className={headingClass}>人数</h2>
        <EditorUnitField label="1組の人数" suffix="人" value={terms.minimumParticipants} onChange={(next) => setTermsField("minimumParticipants", next)} to={{ label: "1組の人数（上限）", value: terms.maxPartySize, onChange: (next) => setTermsField("maxPartySize", next) }} />
        <EditorUnitField label="最少課金人数" suffix="人" info="少ない人数の予約でも、この人数分の料金をいただく場合に入れます。" value={terms.minimumChargeableParticipants} onChange={(next) => setTermsField("minimumChargeableParticipants", next)} />
        <EditorUnitField label="最少催行人数" small="任意" suffix="人" info="管理用の記録です。旅行者には表示されず、自動の中止・返金もありません。" value={terms.minimumAttendance} onChange={(next) => setTermsField("minimumAttendance", next)} />
      </section>
      <section id="publication-cancel" className={sectionClass} aria-labelledby="publication-cancel-title">
        <h2 id="publication-cancel-title" className={headingClass}>取消条件{tag("page", ["CANCELLATION_TERMS_REQUIRED"])}<HostInfoTip label="取消条件">無料の期限を過ぎた取消には返金しません。「返金なし」は、予約後の取消に返金しません。確定している条件を選んでください。</HostInfoTip></h2>
        <EditorChoice name="cancel-policy" legend="取消条件を選ぶ" legendHidden value={terms.cancellationPolicy} onChange={(next) => setTermsField("cancellationPolicy", next)}
          options={[{ value: "FREE_UNTIL_24H", label: "開始24時間前まで無料" }, { value: "FREE_UNTIL_48H", label: "開始48時間前まで無料" }, { value: "NONE", label: "返金なし" }, { value: "CUSTOM", label: "期限と返金割合を決める" }]} />
        {terms.cancellationPolicy === "CUSTOM" ? <div className="mt-2.5 border-l-2 border-line pl-4">
          <div className="mt-3.5">
            <p className="mb-1 text-[0.8125rem] font-bold text-ink-soft">無料で取り消せる期限</p>
            <div className="flex items-center gap-2 text-[0.8125rem] text-ink-soft">
              <span>開始の</span>
              <input aria-label="無料で取り消せる期限の数" inputMode="numeric" value={terms.cancellationWindowValue} onChange={(event) => setTermsField("cancellationWindowValue", event.target.value)} className={`${EDITOR_INPUT} w-[72px] text-right`} />
              <select aria-label="無料で取り消せる期限の単位" value={terms.cancellationWindowUnit} onChange={(event) => setTermsField("cancellationWindowUnit", event.target.value as PublicationTermsForm["cancellationWindowUnit"])} className={`${EDITOR_INPUT} w-auto`}><option value="DAYS">日前</option><option value="HOURS">時間前</option><option value="MINUTES">分前</option></select>
              <span>まで</span>
            </div>
          </div>
          <EditorUnitField label="期限内の返金割合" suffix="%" inputMode="decimal" placeholder="100" value={terms.cancellationRefundPercent} onChange={(next) => setTermsField("cancellationRefundPercent", next)} />
        </div> : null}
      </section>
      <section id="publication-questions" className={sectionClass} aria-labelledby="publication-questions-title">
        <h2 id="publication-questions-title" className={headingClass}>申込時の質問<HostInfoTip label="申込時の質問">この画面では、まだ追加・変更できません。保存しても、今の質問はそのまま残ります。</HostInfoTip></h2>
        <p className="text-sm text-ink-soft">保存済みの質問 {product.saleTerms?.bookingQuestions.length ?? 0}件</p>
      </section>
    </div>;

    const scheduleTab = <div className="grid max-w-[720px] gap-4">
      <section id="publication-offers" className={sectionClass} aria-labelledby="publication-offers-title">
        <h2 id="publication-offers-title" className={headingClass}>開催枠{tag("booking", ["SCHEDULE_REQUIRED"])}<HostInfoTip label="開催枠">旅行者が選べる曜日と時刻です。枠の追加・休止・回ごとの変更は、カレンダーで行います。</HostInfoTip></h2>
        {product.offers.length ? <ul>{product.offers.map((offer) => <li key={offer.id} className="border-t border-line py-3 first:border-t-0 first:pt-0">{offerLabel(offer)}</li>)}</ul> : <p className="text-sm text-muted">開催枠はまだありません。</p>}
        <div className="mt-3.5 border-t border-line pt-3.5"><Link className={consoleButtonClass("secondary")} href={calendarHref}>カレンダーで日程を編集 →</Link></div>
      </section>
    </div>;

    const settingsTab = <div className="grid max-w-[720px] gap-4">
      <section id="publication-listing" className={sectionClass} aria-labelledby="publication-listing-title">
        <h2 id="publication-listing-title" className={headingClass}>掲載言語<HostInfoTip label="掲載言語">英語ページは海外からの旅行者向け、日本語ページは日本語で探す人向けです。両方作ることも、片方だけにすることもできます。選んだ言語の原稿が必要です。掲載をやめた言語のページは、次の公開から表示されなくなります。</HostInfoTip></h2>
        <EditorCheckList legend="掲載する言語" legendHidden disabled={busy || !!conflictProduct} onChange={(key, checked) => changeListing({ ...listing, [key]: checked })}
          options={[
            { key: "en", label: "英語", checked: listing.en, detail: `/experiences/${slug}` },
            { key: "ja", label: "日本語", checked: listing.ja, detail: `/ja/experiences/${slug}` },
          ]} />
        {listingNotice ? <p role="status" className="mt-2 text-sm font-bold text-warn">{listingNotice}</p> : null}
      </section>
      {membersProviderId ? <section id="publication-members" className={sectionClass} aria-labelledby="publication-members-title">
        <h2 id="publication-members-title" className={headingClass}>案内するメンバー{tag("optional")}</h2>
        <ProductMemberSelection key={`${membersProviderId}/${product.id}`} providerId={membersProviderId} productId={product.id} />
      </section> : null}
      <section id="publication-slug" className={sectionClass} aria-labelledby="publication-slug-title">
        <h2 id="publication-slug-title" className={headingClass}>ページのアドレス<HostInfoTip label="ページのアドレス">体験を作ったときに自動で決まります。変えたいときだけ「変更」を押してください。半角の英小文字・数字・ハイフンで入力します。</HostInfoTip></h2>
        {slugEditing ? <div className="flex items-center overflow-hidden rounded-[10px] border border-line-strong bg-canvas focus-within:border-moss focus-within:ring-2 focus-within:ring-moss/20">
          <span className="py-2 pl-3 text-[0.84375rem] whitespace-nowrap text-muted">{listing.en ? "" : "/ja"}/experiences/</span>
          <input aria-label="ページのアドレス" value={slug} spellCheck={false} onChange={(event) => setSlug(event.target.value)} className="min-w-20 flex-1 border-0 bg-transparent py-2 pr-3 pl-0.5 text-[1rem] font-bold outline-none md:text-[0.875rem]" />
        </div> : <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-muted [overflow-wrap:anywhere]">{listing.en ? "" : "/ja"}/experiences/<b className="text-ink">{slug}</b></span>
          <span className="grow" />
          <button type="button" className={consoleButtonClass("secondary", "sm")} onClick={() => setSlugEditing(true)}>変更</button>
        </div>}
      </section>
      {classificationShown ? <section id="publication-classification" className={sectionClass} aria-labelledby="publication-classification-title">
        <h2 id="publication-classification-title" className={headingClass}>日本語の一覧での分類<small className="ml-1.5 text-xs font-normal text-muted">任意</small><HostInfoTip label="日本語の一覧での分類">日本語の一覧で、カテゴリーやエリアから探せるようになります。決めなくても掲載できます。「だれと」「こんな日に」は、当てはまるものをすべて選べます。</HostInfoTip></h2>
        <ProductClassificationFields value={classification.value!} onChange={classification.setValue} disabled={busy} />
      </section> : null}
    </div>;

    const tabs = [["page", "体験ページ"], ["pricing", "料金・予約"], ["schedule", "日程"], ["settings", "掲載設定"]] as const;
    const photoDialogOpen = photoDialog !== null;
    const uploadReady = !!selectedPhoto && rightsConfirmed && !busy && !conflictProduct && (!listing.ja || photoAltJa.trim().length > 0) && (!listing.en || photoAlt.trim().length > 0);
    return <HostPageBody>
      <Link href={page(experiencesBase)} className="mb-1.5 inline-flex items-center gap-1 text-[0.8125rem] font-bold text-muted hover:text-ink">‹ 体験</Link>
      <div className="mb-3.5 flex flex-col gap-3 md:flex-row md:items-start">
        <h1 className="min-w-0 flex-1 font-display text-[1.375rem] leading-[1.35] font-medium tracking-[-0.01em] [overflow-wrap:anywhere] md:text-[1.625rem]">
          {titleText}
          <span className={`${pillBase} ${statusTone} ml-2.5 align-middle`}>{stages.statusLabel}</span>
          {pendingChanges ? <button type="button" disabled={busy} onClick={() => void requestPublish("publish-page")} className={`${pillBase} ml-2 bg-warn-pale align-middle text-warn`}>未反映の変更あり</button> : null}
        </h1>
        <div ref={menuRef} className="relative flex shrink-0 items-center gap-2 pt-0.5 max-md:w-full">
          {publicHref ? <Link className={consoleButtonClass("secondary")} href={publicHref}>公開ページを見る ↗</Link> : null}
          {product.status === "PUBLISHED" ? <button type="button" aria-label="そのほかの操作" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((current) => !current)} className={consoleButtonClass("secondary", "md", "w-[38px] px-0 text-lg tracking-[1px]")}>⋯</button> : null}
          {menuOpen ? <div role="menu" className="absolute top-12 right-0 z-20 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-line bg-canvas p-1.5 shadow-[0_10px_30px_rgb(28_28_26/0.12)]">
            {publicSiteOrigin && providerBookingLinkAvailable(product) ? <div className="px-3 py-2"><HostBookingLinkCopy slug={product.draft.slug} origin={publicSiteOrigin} japaneseOnly={japaneseOnly} /></div> : null}
            {embedEnabled && publicHref && !japaneseOnly ? <Link role="menuitem" href={page(`${experiencesBase}/${encodeURIComponent(product.id)}/embed`)} onClick={() => setMenuOpen(false)} className="block w-full rounded-[9px] px-3 py-2 text-left text-[0.8125rem] font-bold text-ink hover:bg-sand">自分のサイトに貼る</Link> : null}
            <button type="button" role="menuitem" disabled={busy || dirty || !!conflictProduct} onClick={() => { setMenuOpen(false); void changeState("stop"); }} className="block w-full rounded-[9px] px-3 py-2 text-left text-[0.8125rem] font-bold text-danger hover:bg-sand disabled:opacity-45">ページを止める（予約も止まります）</button>
          </div> : null}
        </div>
      </div>
      <HostPublicationStages
        stages={stages} busy={busy} publicHref={publicHref}
        onRun={(action) => { if (action === "stop-booking") void changeState("stop-booking"); else void requestPublish(action); }}
        onShowBlockers={(scope) => { setBlockerScope(scope); setBlockersShown(true); setBlockerDialog(true); }}
      />
      {(error && !photoDialog) || conflictProduct ? <div role="alert" className="mb-3 rounded-xl bg-danger-pale p-3 text-danger">{error && !photoDialog ? <p><HostErrorMessage text={error} /></p> : null}{conflictProduct ? <><p className="mt-2 text-sm">サーバーの最新状態: {conflictProduct.draft.publicTitle}（{STATUS_COPY[conflictProduct.status]}・version {conflictProduct.version}）</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={busy} className={consoleButtonClass("secondary")} onClick={() => void replaceDraftWithLatest()}>入力を破棄して最新を読み込む</button><button type="button" disabled={busy} className={consoleButtonClass("primary")} onClick={() => void reapplyDraftOnLatest()}>自分の入力を残して続ける</button></div></> : null}</div> : null}
      {product.status === "SUSPENDED" ? <p className="mb-3 rounded-xl bg-warn-pale p-3 text-warn">運営停止中です。入力と下書きは保存できますが、再開は運営の停止解除後に行えます。</p> : null}
      <div role="tablist" aria-label="体験の編集" className="mb-5 flex gap-6 overflow-x-auto border-b border-line">
        {tabs.map(([id, label]) => <button key={id} type="button" role="tab" id={`publication-tab-${id}`} aria-selected={workspaceSection === id} aria-controls="publication-tabpanel" onClick={() => setWorkspaceSection(id)} className={`-mb-px h-11 shrink-0 border-b-2 text-sm font-bold ${workspaceSection === id ? "border-ink text-ink" : "border-transparent text-muted"}`}>{label}{markedTabs.has(id) ? <span role="img" aria-label="確認が必要" className="ml-1.5 inline-block size-[7px] rounded-full bg-warn align-middle" /> : null}</button>)}
      </div>
      <form id="product-editor" aria-busy={busy} onSubmit={(event) => void saveAll(event)} className="scroll-mt-24">
        <fieldset disabled={busy} className="min-w-0 border-0 p-0">
          <div role="tabpanel" id="publication-tabpanel" aria-labelledby={`publication-tab-${workspaceSection}`}>
            {workspaceSection === "page" ? pageTab : workspaceSection === "pricing" ? pricingTab : workspaceSection === "schedule" ? scheduleTab : settingsTab}
          </div>
        </fieldset>
        {dirty || notice ? <div className="sticky bottom-0 z-10 -mx-4 mt-5 bg-canvas/95 backdrop-blur md:-mx-9">
          {notice ? <p role="status" className="px-4 py-2 text-sm font-bold text-moss md:px-9">{notice}</p> : null}
          {dirty ? <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 md:px-9">
            <p className="font-bold max-md:sr-only">未保存の変更があります</p>
            <div className="flex gap-2 max-md:flex-1">
              <button type="button" disabled={busy} className={consoleButtonClass("ghost")} onClick={() => setDiscardConfirm(true)}>元に戻す</button>
              <button type="submit" disabled={busy || !!conflictProduct} className={consoleButtonClass("primary", "md", "max-md:h-[46px] max-md:flex-1")}>{busy ? "保存しています…" : "保存"}</button>
            </div>
          </div> : null}
        </div> : null}
      </form>
      {stateConfirm && stateConfirm !== "publish" ? <HostConfirmDialog title={publicationConfirmCopy(stateConfirm, product.status, bookingIsOpen).title} description={publicationConfirmCopy(stateConfirm, product.status, bookingIsOpen).description} focusRef={stateConfirmStay} stayRef={stateConfirmStay} confirm={<button type="submit" className={consoleButtonClass("primary")}>{publicationConfirmCopy(stateConfirm, product.status, bookingIsOpen).confirm}</button>} onConfirm={() => { const action = stateConfirm; void runStateChange(action); }} onClose={() => setStateConfirm(null)} /> : null}
      {translateConfirm ? <HostConfirmDialog title={`今の${NAME[translateConfirm]}を置き換えますか？`} description={`${translateConfirm === "en" ? "日本語" : "英語"}の原稿から翻訳し直します。${NAME[translateConfirm]}に手で書いた内容は消えます。`} focusRef={stateConfirmStay} stayRef={stateConfirmStay} confirm={<button type="submit" className={consoleButtonClass("primary")}>置き換える</button>} onConfirm={() => void (translateConfirm === "en" ? generateEnglish() : generateJapanese())} onClose={() => setTranslateConfirm(null)} /> : null}
      {discardConfirm ? <HostConfirmDialog title="変更を元に戻しますか？" description="保存していない入力は消えて、最後に保存した内容に戻ります。" focusRef={stateConfirmStay} stayRef={stateConfirmStay} confirm={<button type="submit" className={consoleButtonClass("primary")}>元に戻す</button>} onConfirm={() => void discardToLatest()} onClose={() => setDiscardConfirm(false)} /> : null}
      <EditorDialog open={blockerDialog} onClose={() => setBlockerDialog(false)} title={`${blockerGoal}には、あと${dialogBlockers.length}つ必要です`}>
        <ul className="mt-3">
          {dialogBlockers.map((blocker) => {
            const destination = publicationBlockerDestination(blocker);
            const link = "font-extrabold whitespace-nowrap text-moss underline underline-offset-4";
            return <li key={blocker} className="flex items-center justify-between gap-3.5 border-t border-line py-2.5">
              <span>{blocker === "MANUSCRIPT_REQUIRED" ? `${listing.en && listing.ja ? "英語と日本語" : listing.en ? "英語" : "日本語"}の原稿（体験名・ひとこと紹介・当日の言語・詳しい説明）を書いてください。` : BLOCKER_COPY[blocker] ?? (blocker.startsWith("READINESS_") ? BLOCKER_COPY.READINESS_MISSING : "公開条件を確認してください。")}</span>
              {destination?.kind === "calendar" ? <Link href={calendarHref} className={link}>カレンダーを開く</Link>
                : destination?.kind === "tab" ? <button type="button" className={link} onClick={() => { setBlockerDialog(false); setWorkspaceSection(destination.tab); }}>入力する</button>
                  : destination?.kind === "href" ? <Link href={destination.href} className={link}>確認する</Link>
                    : destination?.kind === "payment-consent" && paymentConsentHref ? <a href={paymentConsentHref} referrerPolicy="no-referrer" className={link}>{paymentConsentLabel}</a>
                      : paymentConsentHref && (blocker === "CONNECT_NOT_READY" || blocker === "SELLER_REQUIRED" || blocker === "SELLER_MISMATCH" || blocker.startsWith("READINESS_")) ? <a href={paymentConsentHref} referrerPolicy="no-referrer" className={link}>受取口座を開く</a> : null}
            </li>;
          })}
        </ul>
        <div className="mt-5 flex justify-end"><button type="button" className={consoleButtonClass("secondary")} onClick={() => setBlockerDialog(false)}>閉じる</button></div>
      </EditorDialog>
      <EditorDialog open={photoDialogOpen} onClose={() => setPhotoDialog(null)} title="写真を追加">
        <div className="space-y-1">
          {photoDialog === "provider" ? <label className="block text-[0.8125rem] font-bold text-ink-soft">写真の用途
            <select value={photoPlacement} disabled={busy} onChange={(event) => { setPhotoPlacement(event.target.value as typeof photoPlacement); setPhotoRights(null); }} className={`${EDITOR_INPUT} mt-1`}><option value="PROVIDER_PHOTO">提供者写真（全商品）</option><option value="BUSINESS_LOGO">事業者ロゴ（全商品）</option></select>
          </label> : null}
          {listing.en ? <EditorField label="写真の説明（英語）" value={photoAlt} onChange={setPhotoAlt} /> : null}
          {listing.ja ? <EditorField label="写真の説明（日本語）" value={photoAltJa} onChange={setPhotoAltJa} /> : null}
          <EditorField label="クレジット" small="任意" value={photoCredit} onChange={setPhotoCredit} />
          <div className="pt-3"><HostSharedPhotoOffer disabled={busy || !!conflictProduct} onUse={(photo) => { setSelectedPhoto(photo); setSharedPhotoName(photo.name); setPhotoRights(null); }} /></div>
          <label className="block pt-3 text-[0.8125rem] font-bold text-ink-soft">端末から選ぶ<input type="file" accept="image/jpeg,image/png" disabled={busy} onChange={(event) => { setSelectedPhoto(event.target.files?.[0] ?? null); setSharedPhotoName(null); setPhotoRights(null); }} className="mt-1 block max-w-full font-normal" /></label>
          {sharedPhotoName && selectedPhoto ? <p className="text-sm text-ink-soft">共有された写真を選択中: <span className="[overflow-wrap:anywhere]">{sharedPhotoName}</span></p> : null}
          <label className="flex items-start gap-2 pt-3 text-sm"><input type="checkbox" className="mt-1 accent-moss" checked={rightsConfirmed} disabled={busy || !selectedPhoto} onChange={(event) => setPhotoRights(event.target.checked && selectedPhoto ? { file: selectedPhoto, productId: product.id, placement: photoPlacement } : null)} /><span>この写真を「{photoPlacement === "GALLERY" ? "この体験の写真" : photoPlacement === "PROVIDER_PHOTO" ? "提供者写真" : "事業者ロゴ"}」として{photoPlacement === "GALLERY" ? "この商品" : "販売者のすべての商品"}に公開する権利があり、権利者と写っている方から明示的な許諾を得ています。</span></label>
        </div>
        {error ? <p role="alert" className="mt-3 rounded-xl bg-danger-pale p-3 text-danger"><HostErrorMessage text={error} /></p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={consoleButtonClass("secondary")} onClick={() => setPhotoDialog(null)}>閉じる</button>
          <button type="button" disabled={!uploadReady} className={consoleButtonClass("primary")} onClick={() => void uploadPhoto().then((added) => { if (added) setPhotoDialog(null); })}>写真を追加・差し替え</button>
        </div>
      </EditorDialog>
    </HostPageBody>;
  }

  return <HostPageBody>
    <PageHead title={title || "体験を編集"} />
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><span className="rounded-full bg-sand px-2.5 py-1 text-xs font-extrabold">{STATUS_COPY[product.status]}</span><div className="flex flex-wrap gap-2"><Link className={consoleButtonClass("secondary")} href={calendarHref}>開催日程を設定</Link>{!adminDraft && publicHref ? <Link className={consoleButtonClass("secondary")} href={publicHref}>公開ページを見る</Link> : null}<button type="button" disabled={busy || !dirty || !!conflictProduct} className={consoleButtonClass("secondary")} onClick={() => void saveAll()}>下書きを保存</button>{adminDraft ? <button type="button" disabled={busy || !canPublish || !product.adminEnglishReview?.reviewed || !sellerConfirmed || !publicationPhotoRightsConfirmed || !sellerConfirmationMethod} className={consoleButtonClass("primary")} onClick={() => void changeState("publish")}>事務局として代理公開</button> : null}{!adminDraft && (product.status !== "PUBLISHED" || product.publicationNeedsUpdate) ? <button type="button" disabled={busy || !canPublish} className={consoleButtonClass("primary")} onClick={() => void changeState("publish")}>{product.status === "PUBLISHED" ? "変更を公開" : "公開・再開"}</button> : null}{!adminDraft && product.status === "PUBLISHED" ? <button type="button" disabled={busy || dirty || !!conflictProduct} className={consoleButtonClass("secondary")} onClick={() => void changeState("stop")}>販売を停止</button> : null}</div></div>
    <section className={`${HOST_SURFACE} mb-4 p-4 md:p-5`} aria-labelledby="next-action-title">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-extrabold text-muted">次にすること</p><h2 id="next-action-title" className="mt-1 font-extrabold">{nextActionText}</h2></div>{nextActionControl}</div>
      {!dirty && savedBlockers.length ? <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-soft">{savedBlockers.map((blocker) => <li key={blocker}>{BLOCKER_COPY[blocker] ?? "公開条件を確認してください。"}</li>)}</ul> : null}
      {!dirty && savedBlockers.length === 0 ? <p className="mt-2 text-sm font-bold text-moss">保存済みの内容は公開条件を満たしています。</p> : null}
      {adminDraft ? <p className="mt-2 text-sm text-ink-soft">事務局は販売者本人を装わず、販売者・Connect口座・OWNER権限を変更しません。代理公開後の停止・再開もこの画面ではできません。</p> : null}
    </section>
    {adminDraft ? <section className={`${HOST_SURFACE} mb-4 space-y-3 p-4 md:p-5`} aria-labelledby="admin-proxy-publication-title">
      <h2 id="admin-proxy-publication-title" className="font-extrabold">販売者確認と代理公開</h2>
      {product.acceptanceMode === "INSTANT" ? <dl className="flex flex-wrap gap-x-3 text-sm">
        <dt className="font-bold">予約の受付方法</dt><dd>即時決済（有料は支払い完了で予約確定）</dd>
      </dl> : product.acceptanceMode === "APPROVAL" ? <dl className="flex flex-wrap gap-x-3 text-sm">
        <dt className="font-bold">予約の受付方法</dt><dd>承認後に決済（申込時はカード情報を受け取らず、事務局が承認後の支払URLを手動案内）</dd>
      </dl> : null}
      <p className="text-sm text-ink-soft">現在の保存版・販売条件・掲載同意版・事務局担当者・確認方法を公開と同じtransactionで監査記録します。自由記入欄や個人情報は記録しません。</p>
      <div className="rounded-xl border border-line bg-sand/40 p-3 text-xs text-ink-soft">
        <p className="font-bold text-ink">{product.draft.content.japaneseOnly === true ? "事務局の日本語原稿レビュー" : "事務局の英語原稿レビュー"}</p>
        <p className="mt-1">{product.adminEnglishReview?.reviewed ? "現在の保存版を確認済みです。" : (product.draft.content.japaneseOnly === true ? "日本語原稿を読み、内容を確認してください。" : "英語文面を読み、日本語原稿との対応を確認してください。")}</p>
        <dl className="mt-2 grid gap-1 break-all font-mono">
          <div><dt className="inline font-sans font-bold">Content: </dt><dd className="inline">{product.adminEnglishReview?.contentFingerprint ?? "unavailable"}</dd></div>
          <div><dt className="inline font-sans font-bold">Japanese: </dt><dd className="inline">{product.adminEnglishReview?.japaneseFingerprint ?? "incomplete"}</dd></div>
          <div><dt className="inline font-sans font-bold">English: </dt><dd className="inline">{product.adminEnglishReview?.englishFingerprint ?? "incomplete"}</dd></div>
        </dl>
      </div>
      <label className="block text-sm font-bold text-ink-soft">販売者への確認方法<select value={sellerConfirmationMethod} onChange={(event) => setSellerConfirmationMethod(event.target.value as "" | "VERBAL" | "WRITTEN")} className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2 font-normal"><option value="">選択してください</option><option value="VERBAL">口頭</option><option value="WRITTEN">書面・メッセージ</option></select></label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={sellerConfirmed} onChange={(event) => setSellerConfirmed(event.target.checked)} className="mt-1" /><span>販売者へ現在の公開内容・販売条件・掲載条件を確認済みです。</span></label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={publicationPhotoRightsConfirmed} onChange={(event) => setPublicationPhotoRightsConfirmed(event.target.checked)} className="mt-1" /><span>公開対象の写真について掲載権利を確認済みです。</span></label>
    </section> : null}
    {!adminDraft && product.salesPlan ? <section className={`${HOST_SURFACE} mb-4 space-y-3 p-4 md:p-5`} aria-labelledby="owner-sales-plan-title">
      <h2 id="owner-sales-plan-title" className="font-extrabold">{product.salesPlan.current.plan === "MANAGED_20" ? "NIHO完全代行から本人販売へ切り替える" : "本人販売のプランを変更する"}</h2>
      <p className="text-sm text-ink-soft">この体験だけを切り替えます。公開URL・商品・開催枠・在庫は変わりません。切替中は新しい受付を止め、残っている旧条件の決済を元のStripeアカウントで失効または照合してから新条件へ切り替えます。</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm"><dt>現在</dt><dd>{product.salesPlan.current.plan === "MANAGED_20" ? "完全代行 20%" : product.salesPlan.current.plan === "SUPPORTED_15" ? "本人販売＋サポート 15%" : "本人販売 10%"}（版 {product.salesPlan.current.revision}）</dd><dt>切替状態</dt><dd>{product.salesPlan.phase === "ACTIVE" ? "受付中" : "旧決済の照合中（新規受付停止）"}</dd></dl>
      <fieldset disabled={busy || product.salesPlan.phase !== "ACTIVE" || !product.ownerSalesPlanAgreementVersion} className="space-y-2"><legend className="text-sm font-extrabold">切替後の条件</legend><label className="flex items-start gap-2 text-sm"><input type="radio" checked={ownerSalesPlan === "SUPPORTED_15"} onChange={() => setOwnerSalesPlan("SUPPORTED_15")} className="mt-1" /><span><strong>本人販売＋サポート 15%</strong><br />本人の同じ販売者プロフィール・同意済み受取口座で直接決済します。</span></label><label className="flex items-start gap-2 text-sm"><input type="radio" checked={ownerSalesPlan === "INDEPENDENT_10"} onChange={() => setOwnerSalesPlan("INDEPENDENT_10")} className="mt-1" /><span><strong>本人販売 10%</strong><br />本人の同じ販売者プロフィール・同意済み受取口座で直接決済します。</span></label></fieldset>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={ownerSalesPlanAccepted} disabled={busy || product.salesPlan.phase !== "ACTIVE" || !product.ownerSalesPlanAgreementVersion} onChange={(event) => setOwnerSalesPlanAccepted(event.target.checked)} className="mt-1" /><span>現在のOWNERとして、選択した料率・販売者・決済経路と同意版（{product.ownerSalesPlanAgreementVersion ?? "未設定"}）を確認し、この体験だけを切り替えます。</span></label>
      {product.salesPlan.pending ? <div className="space-y-2">
        <p className="text-sm">切替先は{product.salesPlan.pending.plan === "SUPPORTED_15" ? "本人販売＋サポート 15%" : "本人販売 10%"}です。</p>
        <button type="button" disabled={busy || !product.salesPlan.transitionCommandId} className={consoleButtonClass("primary")} onClick={() => void switchManagedSalesPlan()}>旧決済の照合を再開</button>
      </div> : <button type="button" disabled={busy || dirty || product.salesPlan.phase !== "ACTIVE" || !ownerSalesPlanAccepted || ownerSalesPlan === product.salesPlan.current.plan || !product.ownerSalesPlanAgreementVersion} className={consoleButtonClass("primary")} onClick={() => void switchManagedSalesPlan()}>{salesPlanCommandId ? "同じ切替結果を確認" : "新規受付を止めて切り替える"}</button>}
    </section> : null}
    {dirty ? <p className="mb-3 rounded-xl bg-amber-50 p-3 text-amber-950" role="status">未保存の変更があります。公開・停止は保存後に実行できます。</p> : null}
    {product.publicationNeedsUpdate ? <p className="mb-3 rounded-xl bg-amber-50 p-3 text-amber-950" role="status">現在の掲載版を維持しています。公開条件を満たす変更を反映すると、確認後に新しい掲載版へ切り替わります。</p> : null}
    {error || conflictProduct ? <div role="alert" className="mb-3 rounded-xl bg-rose-50 p-3 text-rose-900">{error ? <p><HostErrorMessage text={error} /></p> : null}{conflictProduct ? <><p className="mt-2 text-sm">サーバーの最新状態: {conflictProduct.draft.publicTitle}（{STATUS_COPY[conflictProduct.status]}・version {conflictProduct.version}）</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={busy} className={consoleButtonClass("secondary")} onClick={() => void replaceDraftWithLatest()}>入力を破棄して最新を読み込む</button><button type="button" disabled={busy} className={consoleButtonClass("primary")} onClick={() => void reapplyDraftOnLatest()}>自分の入力を残して続ける</button></div></> : null}</div> : null}
    {notice ? <p role="status" className="mb-3 rounded-xl bg-green-50 p-3 text-green-900">{notice}</p> : null}
    {product.status === "SUSPENDED" ? <p className="mb-3 rounded-xl bg-amber-50 p-3 text-amber-950">運営停止中です。入力と下書きは保存できますが、再開は運営の停止解除後に行えます。</p> : null}
    <form id="product-editor" aria-busy={busy} onSubmit={(event) => void saveAll(event)} className="scroll-mt-24 space-y-4">
      <fieldset disabled={busy} className="space-y-4 border-0 p-0">
      <section className={`${HOST_SURFACE} space-y-4 p-4 md:p-6`}><h2 className="text-base font-extrabold">商品情報・英語原稿</h2><label className="flex items-start gap-2 rounded-xl border border-line bg-sand/40 p-4 text-sm"><input type="checkbox" className="mt-1" checked={content.japaneseOnly === true} disabled={busy} onChange={(event) => changeJapaneseOnly(event.target.checked)} /><span><b>日本語のみで公開する</b><span className="block text-ink-soft">英語の原稿は作らず、日本語のページ（/ja）にだけ載せます。公開上の商品名は日本語の商品名と同じになります。</span></span></label><Field label="公開URL用slug" value={slug} onChange={setSlug} />{content.japaneseOnly === true ? null : <Field label="商品名（英語・公開用）" value={title} onChange={updateEnglishTitle} />}<Field label="大人1人の基本料金（税込・円）" value={unitAmount} onChange={setUnitAmount} /><p className="text-sm text-muted">販売者表示: {product.sellerDisplayName || "未設定"}</p>{content.japaneseOnly === true ? null : <>{textField("lead", "紹介文（英語）", typeof content.lead === "string" ? content.lead : "", 2)}{textField("description", "体験の説明（英語）", typeof content.description === "string" ? content.description : "", 7)}<Field label="当日の言語（英語）" value={isRecord(content.facts) && typeof content.facts.language === "string" ? content.facts.language : ""} onChange={(next) => updateEnglishContent("facts", { ...(isRecord(content.facts) ? content.facts : {}), language: next })} />{listField("highlights", "体験の特徴（英語・1行ごと）")}{listField("included", "料金に含まれるもの（英語・1行ごと）")}{listField("notIncluded", "料金に含まれないもの（英語・1行ごと）")}{listField("knowBeforeYouGo", "参加前に知っておくこと（英語・1行ごと）")}{listField("notSuitableFor", "参加に向かない条件（英語・1行ごと）")}</>}<div className="rounded-xl border border-line bg-sand/40 p-4"><h3 className="font-extrabold">{content.japaneseOnly === true ? "日本語原稿" : "日本語原稿・英語翻訳"}</h3><p className="mt-1 text-sm text-ink-soft">{adminDraft ? "日本語と手入力の英語原稿を照合し、OWNER本人の確認とは区別された事務局レビューとして確定します。" : "英語は手入力でも翻訳案からでも準備できます。日英の内容を照合し、英語原稿を確認してから保存してください。"}</p><div className="mt-4 space-y-4"><Field label="商品名（日本語）" value={japaneseManuscript(content).title} onChange={(next) => updateJapanese("title", next)} /><Field label="紹介文（日本語）" value={japaneseManuscript(content).lead} multiline rows={2} onChange={(next) => updateJapanese("lead", next)} /><Field label="体験の説明（日本語）" value={japaneseManuscript(content).description} multiline rows={5} onChange={(next) => updateJapanese("description", next)} /><Field label="当日の言語（日本語）" value={japaneseManuscript(content).language} onChange={(next) => updateJapanese("language", next)} /><Field label="特徴（日本語・1行ごと）" value={japaneseManuscript(content).highlights.join("\n")} multiline rows={3} onChange={(next) => updateJapanese("highlights", next.split("\n").filter(Boolean))} /><Field label="含まれるもの（日本語・1行ごと）" value={japaneseManuscript(content).included.join("\n")} multiline rows={2} onChange={(next) => updateJapanese("included", next.split("\n").filter(Boolean))} /><Field label="含まれないもの（日本語・1行ごと）" value={japaneseManuscript(content).notIncluded.join("\n")} multiline rows={2} onChange={(next) => updateJapanese("notIncluded", next.split("\n").filter(Boolean))} /><Field label="参加前の注意（日本語・1行ごと）" value={japaneseManuscript(content).knowBeforeYouGo.join("\n")} multiline rows={2} onChange={(next) => updateJapanese("knowBeforeYouGo", next.split("\n").filter(Boolean))} /><Field label="参加に向かない条件（日本語・1行ごと）" value={japaneseManuscript(content).notSuitableFor.join("\n")} multiline rows={2} onChange={(next) => updateJapanese("notSuitableFor", next.split("\n").filter(Boolean))} />{content.japaneseOnly === true ? <p className="text-xs text-muted">日本語のみで公開します。英語の原稿・確認は要りません。{adminDraft ? "保存後、「事務局として日本語原稿を確認」を押してください。" : ""}</p> : null}{content.japaneseOnly === true && adminDraft ? <button type="button" disabled={busy || dirty || product.adminEnglishReview?.reviewed === true} className={consoleButtonClass("secondary")} onClick={() => void confirmAdminEnglish()}>事務局として日本語原稿を確認</button> : null}{content.japaneseOnly === true ? null : !adminDraft ? <><div className="flex flex-wrap gap-2"><button type="button" disabled={translationBusy || busy} className={consoleButtonClass("secondary")} onClick={() => void generateEnglish()}>{translationBusy ? "翻訳中…" : "日本語から英語案を作成"}</button><button type="button" disabled={translationBusy || busy || englishIsConfirmed(content.translation)} className={consoleButtonClass("secondary")} onClick={confirmEnglish}>英語原稿を確認</button></div><p className="text-xs text-muted">{englishIsConfirmed(content.translation) ? "英語原稿を確認済み" : "未確認の英語原稿は公開できません。日本語を編集すると確認状態が解除されます。"}</p>{liveEnglishStaleNote(product.status, englishIsConfirmed(content.translation)) ? <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950">{liveEnglishStaleNote(product.status, englishIsConfirmed(content.translation))}</p> : null}</> : <><button type="button" disabled={busy || dirty || product.adminEnglishReview?.reviewed === true} className={consoleButtonClass("secondary")} onClick={() => void confirmAdminEnglish()}>事務局として英語原稿を確認</button><p className="text-xs text-muted">{product.adminEnglishReview?.reviewed ? "現在の保存版の日英fingerprintを事務局レビューとして記録済みです。" : "保存後、事務局担当者が日英原稿を照合して確認してください。OWNER本人の確認としては記録されません。"}</p></>}</div></div><Field label="集合場所の公開区分" value={String(content.meetingPointDisclosure ?? "AFTER_BOOKING")} onChange={(next) => setContent((current) => ({ ...current, meetingPointDisclosure: next === "PUBLIC" ? "PUBLIC" : "AFTER_BOOKING" }))} /><Field label="予約前に公開する集合概要" value={typeof content.meetingOverview === "string" ? content.meetingOverview : ""} multiline rows={3} onChange={(next) => updateContent("meetingOverview", next || null)} /></section>
      <section className={`${HOST_SURFACE} space-y-4 p-4 md:p-6`}>
        <h2 className="text-base font-extrabold">料金・販売条件</h2>
        <div className="rounded-xl bg-sand/40 p-3">
          <h3 className="font-bold">開催枠ごとの大人料金（税込・円）</h3>
          <p className="mt-1 text-sm text-ink-soft">空欄のままなら上の商品情報にある基本料金をすべての開催枠に使います。枠別料金を使う場合は、現在の開催枠をすべて入力してください。</p>
          {product.offers.length ? <div className="mt-3 grid gap-3">{product.offers.map((offer) => {
            const price = terms.offerPrices.find((item) => item.offerId === offer.id)?.adultPriceYen ?? "";
            return <Field key={offer.id} label={offerLabel(offer)} value={price} onChange={(next) => setTerms((current) => ({
              ...current,
              offerPrices: current.offerPrices.map((item) => item.offerId === offer.id ? { ...item, adultPriceYen: next } : item),
            }))} placeholder={`基本料金 ¥${unitAmount || "未入力"}`} />;
          })}</div> : <p className="mt-3 text-sm font-bold text-amber-950">先にカレンダーで開催枠を追加すると、枠別料金を入力できます。</p>}
        </div>
        <label className="flex min-h-11 items-center gap-2 font-bold"><input type="checkbox" checked={terms.childPricingEnabled} onChange={(event) => setTerms((current) => ({ ...current, childPricingEnabled: event.target.checked }))} />子ども料金を設定する</label>
        {terms.childPricingEnabled ? <div className="grid gap-4 rounded-xl border border-line p-3 md:grid-cols-2">
          <Field label="子ども1人の料金（税込・円）" value={terms.childPriceYen} onChange={(next) => setTerms((current) => ({ ...current, childPriceYen: next }))} />
          <Field label="子ども料金の最少年齢" value={terms.childMinAge} onChange={(next) => setTerms((current) => ({ ...current, childMinAge: next }))} />
          <Field label="子ども料金の最高年齢" value={terms.childMaxAge} onChange={(next) => setTerms((current) => ({ ...current, childMaxAge: next }))} />
          <label className="flex min-h-11 items-center gap-2 text-sm font-bold"><input type="checkbox" checked={terms.childAdultRequired} onChange={(event) => setTerms((current) => ({ ...current, childAdultRequired: event.target.checked }))} />大人の同伴を必須にする</label>
        </div> : null}
        <p className="text-sm text-muted">無料体験は0円、有料料金は50円以上で入力してください。1〜49円は保存できません。</p>
        <div className="grid gap-4 md:grid-cols-2"><Field label="最少申込人数" value={terms.minimumParticipants} onChange={(next) => setTerms((current) => ({ ...current, minimumParticipants: next }))} /><Field label="最少課金人数" value={terms.minimumChargeableParticipants} onChange={(next) => setTerms((current) => ({ ...current, minimumChargeableParticipants: next }))} /><Field label="1組の上限人数" value={terms.maxPartySize} onChange={(next) => setTerms((current) => ({ ...current, maxPartySize: next }))} /><Field label="最少催行人数（任意）" value={terms.minimumAttendance} onChange={(next) => setTerms((current) => ({ ...current, minimumAttendance: next }))} /></div>
        <label className="block text-sm font-bold text-ink-soft">取消条件<select value={terms.cancellationPolicy} onChange={(event) => setTerms((current) => ({ ...current, cancellationPolicy: event.target.value as PublicationTermsForm["cancellationPolicy"] }))} className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2"><option value="">選択してください</option><option value="CUSTOM">独自の取消期限・返金割合</option><option value="FREE_UNTIL_24H">開始24時間前まで無料</option><option value="FREE_UNTIL_48H">開始48時間前まで無料</option><option value="NONE">返金なし</option></select></label>
        {terms.cancellationPolicy === "CUSTOM" ? <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-bold text-ink-soft">無料取消の期限（開始前）<div className="mt-1 grid grid-cols-[1fr_auto] gap-2"><input value={terms.cancellationWindowValue} onChange={(event) => setTerms((current) => ({ ...current, cancellationWindowValue: event.target.value }))} inputMode="numeric" className="w-full rounded-xl border border-line bg-white px-3 py-2 font-normal text-ink" /><select value={terms.cancellationWindowUnit} onChange={(event) => setTerms((current) => ({ ...current, cancellationWindowUnit: event.target.value as PublicationTermsForm["cancellationWindowUnit"] }))} className="rounded-xl border border-line bg-white px-3 py-2"><option value="DAYS">日前</option><option value="HOURS">時間前</option><option value="MINUTES">分前</option></select></div></label>
          <label className="block text-sm font-bold text-ink-soft">期限内の返金割合（%）<input value={terms.cancellationRefundPercent} onChange={(event) => setTerms((current) => ({ ...current, cancellationRefundPercent: event.target.value }))} inputMode="decimal" placeholder="例: 100 または 37.5" className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 font-normal text-ink" /></label>
        </div> : null}
        <p className="text-sm text-muted">取消期限と返金割合には確定済みの条件を入力してください。未設定の値は公開できません。最少催行人数は運営情報で、達しない場合の自動取消・返金はありません。</p>
      </section>
      <section className={`${HOST_SURFACE} space-y-4 p-4 md:p-6`}>
        <h2 className="text-base font-extrabold">{adminDraft ? "商品写真" : "写真・販売者プロフィール"}</h2>
        <p className="text-sm text-ink-soft">{adminDraft ? "代理登録ではこの商品の写真だけを準備できます。販売者共通の写真・ロゴは変更できません。" : "体験写真はこの商品に、提供者写真と事業者ロゴは同じ販売者の全商品に反映されます。事業者サイトがなくても販売者名を表示します。"}</p>
        <h3 className="font-bold">この体験の写真</h3>
        {mediaDraft.map((photo) => <div key={photo.id} className="grid gap-3 rounded-xl border border-line p-3 md:grid-cols-[5rem_1fr]">
          <Image src={photo.previewUrl} alt={photo.altText} width={80} height={80} unoptimized className="size-20 rounded-lg object-cover" />
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="写真の説明（英語）" value={photo.altText} onChange={(next) => updatePhoto(photo.id, { altText: next })} />
            <Field label="写真の説明（日本語）" value={photo.altTextJa} onChange={(next) => updatePhoto(photo.id, { altTextJa: next })} />
            <Field label="写真クレジット（任意）" value={photo.publicCredit ?? ""} onChange={(next) => updatePhoto(photo.id, { publicCredit: next.trim() ? next : null })} />
            <div className="flex flex-wrap gap-2 md:col-span-2">
              <button type="button" disabled={busy || galleryMedia[0]?.id === photo.id} className={consoleButtonClass("secondary", "sm")} onClick={() => movePhoto(photo.id, -1)}>左へ</button>
              <button type="button" disabled={busy || galleryMedia.at(-1)?.id === photo.id} className={consoleButtonClass("secondary", "sm")} onClick={() => movePhoto(photo.id, 1)}>右へ</button>
              <button type="button" disabled={busy} className={consoleButtonClass("secondary", "sm")} onClick={() => removePhoto(photo.id)}>下書きから削除</button>
            </div>
          </div>
        </div>)}
        {!mediaDraft.length ? <p className="text-sm text-muted">掲載写真はまだありません。</p> : null}
        {!adminDraft ? <div className="border-t border-line pt-4">
          <h3 className="font-bold">販売者プロフィール画像（すべての体験に適用）</h3>
          <p className="mt-1 text-sm text-ink-soft">NIHOアカウントの本人写真や拠点ロゴは転用しません。提供者写真・事業者ロゴは個別に選び、権利を確認してください。</p>
          {providerMediaDraft.map((photo) => <div key={photo.id} className="mt-3 grid gap-3 rounded-xl border border-line p-3 md:grid-cols-[5rem_1fr]">
            <Image src={photo.previewUrl} alt={photo.altText} width={80} height={80} unoptimized className="size-20 rounded-lg object-cover" />
            <div className="grid gap-3 md:grid-cols-2">
              <p className="text-sm font-bold text-ink-soft">{photo.placement === "PROVIDER_PHOTO" ? "提供者写真" : "事業者ロゴ"}</p>
              <Field label="写真の説明（英語）" value={photo.altText} onChange={(next) => updateProviderPhoto(photo.id, { altText: next })} />
              <Field label="写真の説明（日本語）" value={photo.altTextJa} onChange={(next) => updateProviderPhoto(photo.id, { altTextJa: next })} />
              <Field label="写真クレジット（任意）" value={photo.publicCredit ?? ""} onChange={(next) => updateProviderPhoto(photo.id, { publicCredit: next.trim() ? next : null })} />
              <button type="button" disabled={busy || !!conflictProduct} className={`${consoleButtonClass("secondary", "sm")} justify-self-start`} onClick={() => void removeProviderMedia(photo.id)}>全商品から削除</button>
            </div>
          </div>)}
          {!providerMediaDraft.length ? <p className="mt-2 text-sm text-muted">プロフィール画像は未設定です。</p> : null}
        </div> : null}
        {!adminDraft ? <label className="block text-sm font-bold text-ink-soft">新しい写真の用途<select value={photoPlacement} disabled={busy} onChange={(event) => { setPhotoPlacement(event.target.value as typeof photoPlacement); setPhotoRights(null); }} className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2"><option value="GALLERY">この体験の写真</option><option value="PROVIDER_PHOTO">提供者写真（全商品）</option><option value="BUSINESS_LOGO">事業者ロゴ（全商品）</option></select></label> : null}
        <label className="block text-sm font-bold text-ink-soft">写真の説明（英語）<input value={photoAlt} onChange={(event) => setPhotoAlt(event.target.value)} className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 font-normal" /></label>
        <label className="block text-sm font-bold text-ink-soft">写真の説明（日本語）<input value={photoAltJa} onChange={(event) => setPhotoAltJa(event.target.value)} className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 font-normal" /></label>
        <Field label="写真クレジット（任意）" value={photoCredit} onChange={setPhotoCredit} />
        {!adminDraft ? <HostSharedPhotoOffer disabled={busy || !!conflictProduct} onUse={(photo) => { setSelectedPhoto(photo); setSharedPhotoName(photo.name); setPhotoRights(null); }} /> : null}
        <label className="block text-sm"><input type="file" accept="image/jpeg,image/png" disabled={busy} onChange={(event) => { setSelectedPhoto(event.target.files?.[0] ?? null); setSharedPhotoName(null); setPhotoRights(null); }} className="block" /></label>
        {sharedPhotoName && selectedPhoto ? <p className="text-sm text-ink-soft">共有された写真を選択中: <span className="[overflow-wrap:anywhere]">{sharedPhotoName}</span>。写真の説明と権利の確認はこの下の入力で行います。</p> : null}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={rightsConfirmed} disabled={busy || !selectedPhoto} onChange={(event) => setPhotoRights(event.target.checked && selectedPhoto ? { file: selectedPhoto, productId: product.id, placement: photoPlacement } : null)} /><span>この写真を「{photoPlacement === "GALLERY" ? "この体験の写真" : photoPlacement === "PROVIDER_PHOTO" ? "提供者写真" : "事業者ロゴ"}」として{photoPlacement === "GALLERY" ? "この商品" : "販売者のすべての商品"}に公開する権利があり、権利者と写っている方から明示的な許諾を得ています。</span></label>
        <button type="button" disabled={busy || !!conflictProduct || !selectedPhoto || !rightsConfirmed || !photoAlt.trim() || !photoAltJa.trim()} className={consoleButtonClass("secondary")} onClick={() => void uploadPhoto()}>写真を追加・差し替え</button>
      </section>
      </fieldset>
    </form>
    <fieldset disabled={busy} className="mt-4 border-0 p-0">
    <section className={`${HOST_SURFACE} space-y-4 p-4 md:p-6`}>
      <h2 className="font-extrabold">当日の流れ</h2>
      {timelineSection("en", timelineItems(content.timeline))}
      {timelineSection("ja", japaneseManuscript(content).timeline)}
      {faqSection("en")}
      {faqSection("ja")}
    </section>
    </fieldset>
    <section className={`${HOST_SURFACE} mt-4 p-4 md:p-6`}><h2 className="font-extrabold">開催日程</h2><p className="mt-1 text-sm text-ink-soft">日程と定員はカレンダーで登録します。商品を保存してから開催枠を追加してください。</p><Link className={`${consoleButtonClass("secondary")} mt-3 inline-flex`} href={calendarHref}>カレンダーを開く</Link></section>
    {stateConfirm ? (
      <HostConfirmDialog
        title={stateConfirm === "stop" ? "新しい予約を停止しますか？" : adminDraft ? "事務局の代理公開として公開しますか？" : "この商品を公開しますか？"}
        description={stateConfirm === "stop"
          ? "この商品の新しい予約を停止します。受け付けた予約はそのまま残ります。"
          : adminDraft
            ? "販売者への確認を記録します。公開条件と受取口座の状態を確認し、公開します。"
            : "掲載条件を確認し、この商品を公開します。公開内容と販売条件に同意します。"}
        focusRef={stateConfirmStay}
        stayRef={stateConfirmStay}
        confirm={<button type="submit" className={consoleButtonClass("primary")}>{stateConfirm === "stop" ? "停止する" : "同意して公開する"}</button>}
        onConfirm={() => { const action = stateConfirm; void runStateChange(action); }}
        onClose={() => setStateConfirm(null)}
      />
    ) : null}
  </HostPageBody>;
}
