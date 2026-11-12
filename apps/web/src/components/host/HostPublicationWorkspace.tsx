"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HOST_SURFACE, consoleButtonClass } from "./host-ui";
import { HostPageBody, PageHead } from "./ui";
import { HostSharedPhotoOffer } from "./HostSharedPhoto";
import { HostConfirmDialog } from "./HostConfirmDialog";
import {
  asPublicationPrice,
  publicationTermsForm,
  publicationTermsPayload,
  type PublicationTermsForm,
} from "./publication-terms";
import { publicationCanPublish, publicationNextAction } from "./publication-workflow";
import { canonicalPublicationJson as canonicalJson, confirmPublicationEnglish, englishIsConfirmed, englishPublicationManuscript, liveEnglishStaleNote } from "./publication-confirmation";
import { photoRightsConfirmed, type PhotoRightsConfirmation } from "./photo-rights";
import { reapplyProviderMediaEdits } from "./publication-conflict";
import { HostBookingLinkCopy } from "./HostBookingLinkCopy";
import { providerBookingLinkAvailable } from "@/lib/provider-booking-link";
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
  acceptanceMode?: "INSTANT" | "APPROVAL";
  adminEnglishReview?: {
    reviewed: boolean;
    reviewedAtUtc: string | null;
    contentFingerprint: string;
    japaneseFingerprint: string | null;
    englishFingerprint: string | null;
  };
  draft: { slug: string; publicTitle: string; content: Record<string, unknown>; currency: "JPY"; unitAmount: number };
  sellerDisplayName: string;
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
};

const blankContent = {
  lead: "", description: "", facts: { language: "" }, highlights: [], included: [], notIncluded: [],
  knowBeforeYouGo: [], notSuitableFor: [], timeline: [], meetingOverview: null,
  meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
};
const blankJapanese: LocaleManuscript = { title: "", lead: "", description: "", language: "", highlights: [], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [] };
const emptyTerms = publicationTermsForm(null, []);
const STATUS_COPY: Record<Status, string> = { DRAFT: "下書き", PUBLISHED: "公開中", STOPPED: "停止中", RESTART_REQUIRED: "再公開が必要", SUSPENDED: "運営停止中" };
const readError: Record<string, string> = {
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
  MANUSCRIPT_REQUIRED: "日本語原稿と確認済みの英語原稿を完成させてください。",
  OPERATIONS_SUSPENDED: "運営停止中のため再開できません。",
  OWNER_NOT_CURRENT: "最新のOWNER権限を確認できません。ログインし直してください。",
  PAYMENT_REUSE_CONSENT_REQUIRED: "受取口座で売上を受け取ることへの同意を確認してください。",
  PHOTOS_REQUIRED: "商品写真を追加し、日本語と英語の説明を入力してください。",
  PRICE_REQUIRED: "有効な商品価格を入力してください。",
  PUBLIC_CONTENT_INVALID: "公開原稿の入力内容を確認してください。",
  READINESS_EXPIRED: "販売者と受取口座の確認が期限切れです。販売者本人がHost画面で最新状態を確認した後、再度読み込んでください。",
  READINESS_MISSING: "販売者の最新状態を確認できません。販売者本人がHost画面で最新状態を確認した後、再度読み込んでください。",
  SCHEDULE_REQUIRED: "販売できる開催枠をカレンダーに追加してください。",
  SELLER_MISMATCH: "販売者情報と受取口座が、登録されている販売者と一致しません。",
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
function lines(value: unknown): string { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join("\n") : ""; }
function japaneseManuscript(content: Record<string, unknown>): LocaleManuscript {
  const source = isRecord(content.ja) ? content.ja : {};
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

export function HostPublicationWorkspace({
  productId,
  create = false,
  bookingGuideHref,
  paymentConsentHref,
  paymentConsentLabel = "NIHOで受取口座を確認",
  mode = "host",
  apiBase = "/host/api/products",
  experiencesBase = "/host/experiences",
  createHref = "/host/experiences/new",
  publicSiteOrigin,
}: Props) {
  const router = useRouter();
  const adminDraft = mode === "admin-draft";
  const storageNamespace = adminDraft ? `admin-product-draft:${apiBase}` : "experience-product-draft";
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
  const [workspaceSection, setWorkspaceSection] = useState<"page" | "pricing">("page");
  const [editorLocale, setEditorLocale] = useState<"ja" | "en">("ja");
  const [sellerConfirmationMethod, setSellerConfirmationMethod] = useState<"" | "VERBAL" | "WRITTEN">("");
  const [sellerConfirmed, setSellerConfirmed] = useState(false);
  const [publicationPhotoRightsConfirmed, setPublicationPhotoRightsConfirmed] = useState(false);
  const [ownerSalesPlan, setOwnerSalesPlan] = useState<"SUPPORTED_15" | "INDEPENDENT_10">("SUPPORTED_15");
  const [ownerSalesPlanAccepted, setOwnerSalesPlanAccepted] = useState(false);
  const [salesPlanCommandId, setSalesPlanCommandId] = useState<string | null>(null);
  const [createDraftRestored, setCreateDraftRestored] = useState(false);
  /** 公開・停止 waiting for its confirmation in the page's dialog. */
  const [stateConfirm, setStateConfirm] = useState<"publish" | "stop" | null>(null);
  const stateConfirmStay = useRef<HTMLButtonElement>(null);
  const japaneseSourceRef = useRef<LocaleManuscript>(blankJapanese);
  const englishDraftRef = useRef<{ title: string; content: Record<string, unknown> }>({ title: "", content: blankContent });

  const baselineForm = useMemo(() => parseBaseline(baseline), [baseline]);
  // jsonb may return object keys in a different order; only content changes are unsaved.
  const draftFormJson = useMemo(() => canonicalJson({ slug, title, unitAmount, content }), [slug, title, unitAmount, content]);
  const baselineDraftJson = baselineForm ? canonicalJson({ slug: baselineForm.slug, title: baselineForm.title, unitAmount: baselineForm.unitAmount, content: baselineForm.content }) : "";
  const draftDirty = !!product && (!baselineForm || draftFormJson !== baselineDraftJson);
  const termsDirty = !!product && (!baselineForm || JSON.stringify(terms) !== JSON.stringify(baselineForm.terms));
  const mediaDirty = !!product && (!baselineForm || JSON.stringify(mediaForm(mediaDraft)) !== JSON.stringify(baselineForm.media));
  const providerMediaDirty = !adminDraft && !!product && JSON.stringify(providerMediaForm(providerMediaDraft)) !== providerMediaBaseline;
  const dirty = create ? Boolean(slug || title || unitAmount) : !!product && (draftDirty || termsDirty || mediaDirty || providerMediaDirty);
  const updateContent = useCallback((key: string, value: unknown) => setContent((current) => ({ ...current, [key]: value })), []);

  function updateJapanese(key: keyof LocaleManuscript, value: string | string[] | TimelineItem[]) {
    const next = { ...japaneseSourceRef.current, [key]: value } as LocaleManuscript;
    japaneseSourceRef.current = next;
    setContent((current) => ({ ...current, ja: next, translation: { sourceFingerprint: null, confirmedSourceFingerprint: null } }));
  }

  function updateFaq(locale: "en" | "ja", rows: PublicationFaqRow[]) {
    if (locale === "ja") {
      const next = withPublicationFaq(japaneseSourceRef.current, rows);
      japaneseSourceRef.current = next;
      setContent((current) => ({ ...current, ja: next, translation: { sourceFingerprint: null, confirmedSourceFingerprint: null } }));
      return;
    }
    englishDraftRef.current = { ...englishDraftRef.current, content: withPublicationFaq(englishDraftRef.current.content, rows) };
    setContent((current) => withPublicationFaq({ ...current, translation: { ...(isRecord(current.translation) ? current.translation : {}), confirmedSourceFingerprint: null, confirmedEnglishFingerprint: null } }, rows));
  }

  function updateEnglishTitle(value: string) {
    englishDraftRef.current = { ...englishDraftRef.current, title: value };
    setTitle(value);
    setContent((current) => ({ ...current, translation: { ...(isRecord(current.translation) ? current.translation : {}), confirmedSourceFingerprint: null, confirmedEnglishFingerprint: null } }));
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
    const response = await fetch(`${apiBase}/${encodeURIComponent(productId ?? "")}`, { cache: "no-store", credentials: "same-origin" });
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
      const providerResponse = await fetch("/host/api/provider-media", { cache: "no-store", credentials: "same-origin" });
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
    englishDraftRef.current = { title: current.draft.publicTitle, content: nextContent };
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
      englishDraftRef.current = { title: restored.title, content: restored.content };
    } else {
      setSlug(current.draft.slug); setTitle(current.draft.publicTitle); setUnitAmount(String(current.draft.unitAmount)); setContent(nextContent); setTerms(nextTerms); setMediaDraft(current.media);
      setProviderMediaDraft(currentProviderMedia);
      setBaseline(JSON.stringify(serverForm));
      setProviderMediaBaseline(JSON.stringify(providerMediaForm(currentProviderMedia)));
      japaneseSourceRef.current = japaneseManuscript(nextContent);
      englishDraftRef.current = { title: current.draft.publicTitle, content: nextContent };
    }
    setError(""); setConflictProduct(null);
    return current;
  }, [adminDraft, apiBase, productId, storageNamespace]);

  useEffect(() => {
    if (create) return;
    if (!productId) return;
    let active = true;
    queueMicrotask(() => { if (active) void refresh().catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "商品を読み込めませんでした。"); }); });
    return () => { active = false; };
  }, [create, productId, refresh]);

  useEffect(() => {
    if (!create) return;
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
  }, [create, storageNamespace]);

  useEffect(() => {
    if (!create || !createDraftRestored) return;
    try { window.sessionStorage.setItem(`${storageNamespace}:new`, JSON.stringify({ slug, title, unitAmount, content, terms })); }
    catch { /* The current form still protects input in memory. */ }
  }, [content, create, createDraftRestored, slug, storageNamespace, terms, title, unitAmount]);

  useEffect(() => {
    if (create) {
      let active = true;
      queueMicrotask(() => { if (active) void fetch(apiBase, { cache: "no-store", credentials: "same-origin" }).then(async (response) => {
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
    queueMicrotask(() => { if (active) void fetch(apiBase, { cache: "no-store", credentials: "same-origin" }).then(async (response) => {
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      if (active && isRecord(body) && Array.isArray(body.products)) setProducts(body.products as Product[]);
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "商品を読み込めませんでした。"); }); });
    return () => { active = false; };
  }, [apiBase, create, productId]);

  useEffect(() => {
    if (dirty && product) saveLocal(storageNamespace, product.id, { slug, title, unitAmount, content, terms, media: mediaDraft, providerMedia: providerMediaDraft });
  }, [content, dirty, mediaDraft, product, providerMediaDraft, slug, storageNamespace, terms, title, unitAmount]);

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
      const response = await fetch(apiBase, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: slug.trim(), publicTitle: title.trim(), content: draftContent, currency: "JPY", unitAmount: asPublicationPrice(unitAmount), ...(managedSales ? { managedSales } : {}) }) });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      const created = (body as ProductResponse).product;
      saveLocal(storageNamespace, created.id, { slug, title, unitAmount, content: draftContent, terms, media: [] });
      try { window.sessionStorage.removeItem(`${storageNamespace}:new`); } catch { /* Best effort. */ }
      router.replace(`${experiencesBase}/${encodeURIComponent(created.id)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "作成結果を確認できませんでした。入力を保持しています。");
      // A lost response can still have created the product. Reconcile by the unique seller slug before retry.
      try {
        const listResponse = await fetch(apiBase, { cache: "no-store", credentials: "same-origin" });
        const listBody = await listResponse.json().catch(() => null);
        const found = isRecord(listBody) && Array.isArray(listBody.products) ? (listBody.products as Product[]).find((item) => item.draft.slug === slug.trim()) : undefined;
        if (found) {
          saveLocal(storageNamespace, found.id, { slug, title, unitAmount, content: draftContent, terms, media: found.media });
          try { window.sessionStorage.removeItem(`${storageNamespace}:new`); } catch { /* Best effort. */ }
          router.replace(`${experiencesBase}/${encodeURIComponent(found.id)}`);
        }
      } catch { /* Keep the entered form; an explicit retry can reconcile again. */ }
    } finally { setBusy(false); }
  }

  async function saveAll(event?: React.FormEvent) {
    event?.preventDefault();
    if (!product || busy) return;
    if (conflictProduct) { setError("別の更新と競合しています。入力を保持したまま、最新状態を確認してから保存してください。"); return; }
    const amount = asPublicationPrice(unitAmount);
    const saleTerms = publicationTermsPayload(terms, product.saleTerms);
    if (draftDirty && amount === null) { setError("料金は無料なら0円、有料なら50円以上の整数で入力してください。"); return; }
    const faqProblem = draftDirty ? publicationContentFaqProblem(content) : null;
    if (faqProblem) { setError(`${faqProblem}入力はこのブラウザーに保持しています。`); return; }
    if (!draftDirty && !mediaDirty && !termsDirty && !providerMediaDirty) return;
    if (termsDirty && !saleTerms && !draftDirty && !mediaDirty && !providerMediaDirty) {
      setError("料金・取消条件はまだ保存できません。人数と、確定した取消期限・返金割合を入力してください。入力はこのブラウザーに保持しています。");
      return;
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
        const mediaResponse = await fetch(`${apiBase}/${encodeURIComponent(current.id)}/media`, {
          method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: current.version, media: mediaForm(mediaDraft) }),
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
      if (draftDirty) {
        const draft = { slug: slug.trim(), publicTitle: title.trim(), content, currency: "JPY", unitAmount: amount! };
        shouldReconcile = true;
        const response = await fetch(`${apiBase}/${encodeURIComponent(current.id)}`, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: current.version, draft }) });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          shouldReconcile = writeOutcomeNeedsReconciliation(response.status);
          throw new Error(apiErrorMessage(body, response.status));
        }
        if (!isRecord(body) || !isRecord(body.product)) throw new Error("商品情報の保存結果を確認できませんでした。");
        current = (body as ProductResponse).product;
        shouldReconcile = false;
        setProduct(current);
        publicationUpdated = Boolean((body as { publicationUpdated?: boolean }).publicationUpdated);
      }
      let saved = current;
      let termsSaved = false;
      let savedProviderMedia = providerMediaDraft;
      if (termsDirty && saleTerms) {
        shouldReconcile = true;
        const termsResponse = await fetch(`${apiBase}/${encodeURIComponent(saved.id)}/sale-terms`, { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: saved.version, saleTerms }) });
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
        const profileResponse = await fetch("/host/api/provider-media", {
          method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: providerMediaVersion, media: providerMediaForm(providerMediaDraft) }),
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
      const savedContent = contentFrom(saved);
      const savedTerms = publicationTermsForm(saved.saleTerms, saved.offers);
      setMediaDraft(saved.media);
      const savedProviderMediaForm = providerMediaForm(savedProviderMedia);
      setProviderMediaBaseline(JSON.stringify(savedProviderMediaForm));
      setBaseline(JSON.stringify({ slug: saved.draft.slug, title: saved.draft.publicTitle, unitAmount: String(saved.draft.unitAmount), content: savedContent, terms: savedTerms, media: mediaForm(saved.media), providerMedia: savedProviderMediaForm }));
      if (termsSaved) setTerms(savedTerms);
      clearLocal(storageNamespace, saved.id); setConflictProduct(null);
      if (publicationUpdated) setNotice("保存しました。掲載内容も更新しました。");
      else if (termsDirty && !saleTerms) setNotice("原稿・写真・販売者プロフィールを保存しました。料金・取消条件は入力途中のため、まだ保存されていません。");
      else if (saved.publicationNeedsUpdate) setNotice("下書きを保存しました。掲載中の内容は維持されています。公開条件を整えると変更を反映できます。");
      else setNotice("下書きを保存しました。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存結果を確認できませんでした。最新状態を読み直してください。");
      // Only an uncertain write outcome or an explicit version conflict needs reconciliation.
      // Fetch a comparison snapshot without hydrating the live form from storage or the server.
      if (shouldReconcile) {
        try { await refresh(true, true); } catch { /* The in-memory form and local draft remain untouched. */ }
      }
    } finally { setBusy(false); }
  }

  async function reapplyDraftOnLatest() {
    if (!product || !conflictProduct || busy) return;
    if (!window.confirm("現在の入力を最新の商品状態に適用し直します。競合した項目は、次の保存でこの入力に更新されます。続けますか？")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${apiBase}/${encodeURIComponent(product.id)}`, { cache: "no-store", credentials: "same-origin" });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      if (!isRecord(body) || !isRecord(body.product)) throw new Error("最新の商品状態を読み込めませんでした。");
      const latest = body.product as Product;
      let latestProviderMedia: ProviderMedia[] = [];
      let latestProviderVersion: number | null = null;
      if (!adminDraft) {
        const providerResponse = await fetch("/host/api/provider-media", { cache: "no-store", credentials: "same-origin" });
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
    setBusy(true);
    setNotice("");
    try {
      const latest = await refresh(false);
      clearLocal(storageNamespace, latest.id);
      setError("");
      setNotice("最新の保存内容を読み込みました。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "最新状態を読み込めませんでした。入力は保持しています。");
    } finally { setBusy(false); }
  }

  async function changeState(action: "publish" | "stop") {
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

  async function runStateChange(action: "publish" | "stop") {
    if (!product || dirty || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (adminDraft && action === "stop") throw new Error("事務局は公開済み商品の停止を操作できません。");
      const publishBody = adminDraft
        ? { version: product.version, accepted: true, sellerConfirmationMethod, photoRightsConfirmed: true, consentVersion }
        : { version: product.version, consentVersion, accepted: true };
      const response = await fetch(`${apiBase}/${encodeURIComponent(product.id)}/${action}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(action === "publish" ? publishBody : { version: product.version }) });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      if (adminDraft) {
        setNotice("事務局の代理公開として公開しました。");
        router.push(experiencesBase);
        router.refresh();
        return;
      }
      const saved = (body as ProductResponse).product;
      setProduct(saved); setNotice(action === "publish" ? "公開しました。" : "販売を停止しました。");
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
      const response = await fetch(`${apiBase}/${encodeURIComponent(product.id)}/english-review`, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: product.version, reviewed: true }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      if (!isRecord(body) || !isRecord(body.product)) throw new Error("英語原稿の確認結果を読み取れませんでした。");
      setProduct((body as ProductResponse).product);
      setNotice("現在の日英原稿を事務局レビューとして確認しました。");
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
      const response = await fetch(`${apiBase}/${encodeURIComponent(product.id)}/translation`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ japanese }) });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      const result = body as { sourceFingerprint?: unknown; english?: unknown };
      if (canonicalJson(japaneseSourceRef.current) !== snapshot) { setNotice("翻訳中に日本語原稿が変更されたため、結果を破棄しました。もう一度生成してください。"); return; }
      if (canonicalJson(englishDraftRef.current) !== englishSnapshot) { setNotice("翻訳中に英語原稿が編集されたため、結果を破棄しました。入力した英語は保持しています。"); return; }
      if (typeof result.sourceFingerprint !== "string" || !isRecord(result.english)) throw new Error("翻訳結果を確認できませんでした。原稿は変更していません。");
      const english = result.english as unknown as LocaleManuscript;
      // The translation keeps the Japanese FAQ rows (the server checks the count); none removes the English FAQ.
      const nextContent = withPublicationFaq({
        ...englishDraftRef.current.content, lead: english.lead, description: english.description, facts: { language: english.language },
        highlights: english.highlights, included: english.included, notIncluded: english.notIncluded,
        knowBeforeYouGo: english.knowBeforeYouGo, notSuitableFor: english.notSuitableFor, timeline: english.timeline,
        translation: { sourceFingerprint: result.sourceFingerprint, confirmedSourceFingerprint: null, confirmedEnglishFingerprint: null },
      }, publicationFaqRows(english.faq));
      englishDraftRef.current = { title: english.title, content: nextContent };
      setTitle(english.title);
      setContent(nextContent);
      setNotice("英語案を作成しました。原文と照合して必要な修正を行い、確認してから保存してください。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "翻訳できませんでした。日本語原稿は保持しています。"); }
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
      const response = await fetch(`${apiBase}/${encodeURIComponent(product.id)}/sales-plan`, {
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

  async function uploadPhoto() {
    if (!product || !selectedPhoto || !rightsConfirmed || busy || conflictProduct) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const profileAsset = !adminDraft && photoPlacement !== "GALLERY";
      if (profileAsset && providerMediaVersion === null) throw new Error("販売者プロフィールの保存版がありません。再読み込みしてください。");
      const response = await fetch(profileAsset ? "/host/api/provider-media/upload" : `${apiBase}/${encodeURIComponent(product.id)}/media`, { method: "POST", credentials: "same-origin", headers: { "content-type": selectedPhoto.type, "x-experience-photo-rights-confirmed": "true", "x-experience-photo-alt-text-utf8-base64url": base64UrlUtf8(photoAlt), "x-experience-photo-alt-text-ja-utf8-base64url": base64UrlUtf8(photoAltJa), "x-experience-media-placement": adminDraft ? "GALLERY" : photoPlacement, ...(profileAsset ? { "x-experience-provider-media-version": String(providerMediaVersion) } : {}), ...(photoCredit.trim() ? { "x-experience-photo-credit-utf8-base64url": base64UrlUtf8(photoCredit.trim()) } : {}) }, body: selectedPhoto });
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
    } catch (reason) { setError(reason instanceof Error ? reason.message : "写真を追加できませんでした。選択した写真と入力を保持しています。"); }
    finally { setBusy(false); }
  }

  async function removeProviderMedia(assetId: string) {
    if (providerMediaVersion === null || busy || conflictProduct) return;
    const asset = providerMediaDraft.find((item) => item.id === assetId);
    if (!asset || !window.confirm(asset.placement === "PROVIDER_PHOTO" ? "販売中のすべての体験から提供者写真を削除しますか？" : "販売中のすべての体験から事業者ロゴを削除しますか？")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/host/api/provider-media/${encodeURIComponent(asset.id)}`, {
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

  if (create) return <HostPageBody><PageHead title={adminDraft ? "商品の代理登録" : "体験を作成"} /><form onSubmit={createProduct} className={`${HOST_SURFACE} space-y-5 p-4 md:p-6`}>
    <p className="text-sm text-ink-soft">{adminDraft ? "選択した運営登録済み販売者へ、非公開の商品下書きを作成します。販売者へ確認後、通常公開と同じ条件を満たす未公開draftだけを事務局判断で代理公開できます。" : "新しい商品をExperienceに下書き保存します。公開前の入力は公開されません。"}</p>
    {error ? <p role="alert" className="rounded-xl bg-rose-50 p-3 text-rose-900">{error}</p> : null}
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
    <div className="mb-4 flex items-center justify-between gap-3"><p className="text-ink-soft">{adminDraft ? "事務局が作成した、一度も公開していない下書き" : "あなたが販売する体験"}</p><Link className={consoleButtonClass("primary")} href={createHref}>{adminDraft ? "商品を代理登録" : "体験を作成"}</Link></div>
    {error ? <p role="alert" className="mb-3 rounded-xl bg-rose-50 p-3 text-rose-900">{error}</p> : null}
    {products.length ? <ul className="divide-y divide-line">{products.map((item) => <li key={item.id} className="flex items-center justify-between gap-3 py-3"><div className="min-w-0"><Link className="font-extrabold underline-offset-2 hover:underline" href={`${experiencesBase}/${encodeURIComponent(item.id)}`}>{item.draft.publicTitle || "題名なし"}</Link><p className="text-sm text-muted">{item.draft.slug}</p>{!adminDraft && publicSiteOrigin && providerBookingLinkAvailable(item) ? <HostBookingLinkCopy slug={item.draft.slug} origin={publicSiteOrigin} /> : null}</div><span className="rounded-full bg-sand px-2.5 py-1 text-xs font-extrabold">{STATUS_COPY[item.status]}</span></li>)}</ul> : <p className="py-6 text-center text-muted">{error ? "商品を読み込めませんでした。" : "まだ商品がありません。"}</p>}
  </section></HostPageBody>;

  if (!product) return <HostPageBody><PageHead title="体験を読み込み中" />{error ? <p role="alert" className="rounded-xl bg-rose-50 p-3 text-rose-900">{error}</p> : <p>商品を読み込んでいます…</p>}<button type="button" className={consoleButtonClass("secondary")} onClick={() => void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : "読み込みに失敗しました。"))}>再読み込み</button></HostPageBody>;

  const textField = (key: string, label: string, value: string, rows = 3) => <Field label={label} value={value} multiline rows={rows} onChange={(next) => updateEnglishContent(key, next)} />;
  const listField = (key: string, label: string) => <Field label={label} value={lines(content[key])} multiline rows={3} onChange={(next) => updateEnglishContent(key, next.split("\n").filter((item) => item.trim().length > 0))} />;
  const galleryMedia = mediaDraft.filter((item) => item.placement === "GALLERY");
  const calendarHref = adminDraft ? `${experiencesBase}/${encodeURIComponent(product.id)}/calendar` : `/host/calendar?experience=${encodeURIComponent(product.id)}`;
  const savedBlockers = product.publicationBlockers ?? [];
  const canPublish = !conflictProduct && publicationCanPublish({ dirty, blockers: savedBlockers, suspended: product.status === "SUSPENDED" });
  const nextAction = publicationNextAction({ dirty, blockers: savedBlockers, published: product.status === "PUBLISHED" && !product.publicationNeedsUpdate });
  // A pending draft may have a different slug from the current publication.
  const publicHref = product.status === "PUBLISHED" && !product.publicationNeedsUpdate ? `/experiences/${encodeURIComponent(product.draft.slug)}` : null;
  const nextActionControl = adminDraft
    ? (dirty ? <button type="button" disabled={busy || !!conflictProduct} className={consoleButtonClass("primary")} onClick={() => void saveAll()}>入力を保存</button>
      : !product.adminEnglishReview?.reviewed ? <button type="button" disabled={busy} className={consoleButtonClass("primary")} onClick={() => void confirmAdminEnglish()}>事務局として英語原稿を確認</button>
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
              ? <Link className={consoleButtonClass("primary")} href="/host/settings#settings-support">サポート・手数料の条件を確認</Link>
            : nextAction === "PAYMENT_CONSENT" && paymentConsentHref
              ? <a className={consoleButtonClass("primary")} href={paymentConsentHref} referrerPolicy="no-referrer">{paymentConsentLabel}</a>
            : nextAction === "PUBLISH"
              ? <button type="button" disabled={busy || !canPublish} className={consoleButtonClass("primary")} onClick={() => void changeState("publish")}>同意して公開</button>
              : nextAction === "LIVE" && publicHref
                ? <Link className={consoleButtonClass("primary")} href={publicHref}>公開ページを見る</Link>
                : null;
  const nextActionText = conflictProduct ? "競合を解消してから保存・公開できます。現在の入力は保持しています。"
    : adminDraft ? (dirty ? "代理登録中の入力を保存してください。" : !product.adminEnglishReview?.reviewed ? "現在の日英原稿を事務局レビューとして確認してください。" : savedBlockers.length ? "通常公開と同じ未完了条件を解消してください。" : "販売者への確認方法と写真掲載権利を記録すると、事務局として代理公開できます。")
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
      title,
      lead: typeof content.lead === "string" ? content.lead : "",
      description: typeof content.description === "string" ? content.description : "",
      language: isRecord(content.facts) && typeof content.facts.language === "string" ? content.facts.language : "",
      highlights: lines(content.highlights),
      included: lines(content.included),
      notIncluded: lines(content.notIncluded),
      knowBeforeYouGo: lines(content.knowBeforeYouGo),
      notSuitableFor: lines(content.notSuitableFor),
    };
    const localeIsJapanese = editorLocale === "ja";
    const localeField = (key: "title" | "lead" | "description" | "language", jaLabel: string, enLabel: string, rows = 0) => {
      const value = localeIsJapanese ? japanese[key] : english[key];
      const update = (next: string) => {
        if (localeIsJapanese) updateJapanese(key, next);
        else if (key === "title") updateEnglishTitle(next);
        else if (key === "language") updateEnglishContent("facts", { ...(isRecord(content.facts) ? content.facts : {}), language: next });
        else updateEnglishContent(key, next);
      };
      return <Field label={localeIsJapanese ? jaLabel : enLabel} value={value} multiline={rows > 0} rows={rows || undefined} onChange={update} />;
    };
    const localeListField = (key: "highlights" | "included" | "notIncluded" | "knowBeforeYouGo" | "notSuitableFor", jaLabel: string, enLabel: string, rows = 3) => (
      <Field
        label={localeIsJapanese ? jaLabel : enLabel}
        value={localeIsJapanese ? japanese[key].join("\n") : english[key]}
        multiline
        rows={rows}
        onChange={(next) => {
          // Keep the trailing empty line while typing so Enter can start the next item.
          const value = next.split("\n");
          if (localeIsJapanese) updateJapanese(key, value);
          else updateEnglishContent(key, value);
        }}
        onBlur={() => {
          const value = localeIsJapanese ? japanese[key] : english[key].split("\n");
          if (!value.some((item) => !item.trim())) return;
          const nonempty = value.filter((item) => item.trim().length > 0);
          if (localeIsJapanese) updateJapanese(key, nonempty);
          else updateEnglishContent(key, nonempty);
        }}
      />
    );
    const makeCoverPhoto = (id: string) => setMediaDraft((current) => {
      const gallery = current.filter((item) => item.placement === "GALLERY");
      const selected = gallery.find((item) => item.id === id);
      if (!selected || gallery[0]?.id === id) return current;
      const ordered = [selected, ...gallery.filter((item) => item.id !== id)];
      let cursor = 0;
      return current.map((item) => item.placement === "GALLERY" ? ordered[cursor++]! : item);
    });
    const statusAndMessages = <>
      {dirty ? <p className="mb-3 rounded-xl bg-amber-50 p-3 text-amber-950" role="status">未保存の変更があります。公開・停止は保存後に実行できます。</p> : null}
      {product.publicationNeedsUpdate ? <p className="mb-3 rounded-xl bg-amber-50 p-3 text-amber-950" role="status">現在の掲載版を維持しています。公開条件を満たす変更を反映すると、確認後に新しい掲載版へ切り替わります。</p> : null}
      {error || conflictProduct ? <div role="alert" className="mb-3 rounded-xl bg-rose-50 p-3 text-rose-900">{error ? <p>{error}</p> : null}{conflictProduct ? <><p className="mt-2 text-sm">サーバーの最新状態: {conflictProduct.draft.publicTitle}（{STATUS_COPY[conflictProduct.status]}・version {conflictProduct.version}）</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={busy} className={consoleButtonClass("secondary")} onClick={() => void replaceDraftWithLatest()}>入力を破棄して最新を読み込む</button><button type="button" disabled={busy} className={consoleButtonClass("primary")} onClick={() => void reapplyDraftOnLatest()}>自分の入力を残して続ける</button></div></> : null}</div> : null}
      {notice ? <p role="status" className="mb-3 rounded-xl bg-green-50 p-3 text-green-900">{notice}</p> : null}
      {product.status === "SUSPENDED" ? <p className="mb-3 rounded-xl bg-amber-50 p-3 text-amber-950">運営停止中です。入力と下書きは保存できますが、再開は運営の停止解除後に行えます。</p> : null}
    </>;
    const languageSwitch = <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="inline-flex rounded-xl border border-line bg-white p-1" role="group" aria-label="原稿の言語">
        <button type="button" aria-pressed={localeIsJapanese} className={`min-h-10 rounded-lg px-4 text-sm font-bold ${localeIsJapanese ? "bg-sand text-ink" : "text-muted"}`} onClick={() => setEditorLocale("ja")}>日本語</button>
        <button type="button" aria-pressed={!localeIsJapanese} className={`min-h-10 rounded-lg px-4 text-sm font-bold ${!localeIsJapanese ? "bg-sand text-ink" : "text-muted"}`} onClick={() => setEditorLocale("en")}>英語を確認</button>
      </div>
      {!localeIsJapanese ? <span className={`rounded-full px-2.5 py-1 text-xs font-extrabold ${englishIsConfirmed(content.translation) ? "bg-green-50 text-moss" : "bg-amber-50 text-amber-950"}`}>{englishIsConfirmed(content.translation) ? "確認済み" : "未確認"}</span> : null}
    </div>;
    const translationControls = !localeIsJapanese ? <div className="rounded-xl border border-line bg-sand/40 p-4">
      <p className="text-sm text-ink-soft">日本語の内容と照合し、公開する英語を確認してください。日本語を編集すると確認状態が解除されます。</p>
      <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={translationBusy || busy} className={consoleButtonClass("secondary")} onClick={() => void generateEnglish()}>{translationBusy ? "翻訳中…" : "日本語から英語案を作成"}</button><button type="button" disabled={translationBusy || busy || englishIsConfirmed(content.translation)} className={consoleButtonClass("secondary")} onClick={confirmEnglish}>この英語を確認</button></div>
      {liveEnglishStaleNote(product.status, englishIsConfirmed(content.translation)) ? <p role="status" className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-950">{liveEnglishStaleNote(product.status, englishIsConfirmed(content.translation))}</p> : null}
    </div> : null;
    const photoSection = <section className={`${HOST_SURFACE} space-y-4 p-4 md:p-6`} aria-labelledby="publication-photos-title">
      <div><h2 id="publication-photos-title" className="text-base font-extrabold">写真</h2><p className="mt-1 text-sm text-ink-soft">1枚目が体験ページの表紙です。説明・クレジット・並び順も公開内容として保存します。</p></div>
      {mediaDraft.map((photo, index) => <details key={photo.id} className="rounded-xl border border-line p-3">
        <summary className="flex min-h-11 cursor-pointer items-center gap-3">
          <Image src={photo.previewUrl} alt="" width={64} height={48} unoptimized className="h-12 w-16 rounded-lg object-cover" />
          <span className="min-w-0 flex-1 break-words text-sm font-bold">写真 {index + 1}{index === 0 ? " · 表紙" : ""}<span className="block text-xs font-normal text-muted">{photo.altTextJa || photo.altText || "写真の説明を編集"}</span></span>
          <span className="shrink-0 text-xs text-muted">編集</span>
        </summary>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <Field label="写真の説明（英語）" value={photo.altText} onChange={(next) => updatePhoto(photo.id, { altText: next })} />
          <Field label="写真の説明（日本語）" value={photo.altTextJa} onChange={(next) => updatePhoto(photo.id, { altTextJa: next })} />
          <Field label="写真クレジット（任意）" value={photo.publicCredit ?? ""} onChange={(next) => updatePhoto(photo.id, { publicCredit: next.trim() ? next : null })} />
          <div className="flex flex-wrap gap-2 md:col-span-2">
            <button type="button" aria-label={`写真 ${index + 1} を前へ`} disabled={busy || galleryMedia[0]?.id === photo.id} className={consoleButtonClass("secondary", "sm")} onClick={() => movePhoto(photo.id, -1)}>前へ</button>
            <button type="button" aria-label={`写真 ${index + 1} を後ろへ`} disabled={busy || galleryMedia.at(-1)?.id === photo.id} className={consoleButtonClass("secondary", "sm")} onClick={() => movePhoto(photo.id, 1)}>後ろへ</button>
            <button type="button" aria-label={`写真 ${index + 1} を表紙にする`} disabled={busy || galleryMedia[0]?.id === photo.id} className={consoleButtonClass("secondary", "sm")} onClick={() => makeCoverPhoto(photo.id)}>表紙にする</button>
            <button type="button" aria-label={`写真 ${index + 1} を下書きから外す`} disabled={busy} className={consoleButtonClass("secondary", "sm")} onClick={() => removePhoto(photo.id)}>外す</button>
          </div>
        </div>
      </details>)}
      {!mediaDraft.length ? <p className="text-sm text-muted">表紙の写真がありません。公開するには、掲載許諾を確認した写真を追加してください。</p> : null}
      <details open={!mediaDraft.length} className="space-y-3 rounded-xl bg-sand/40 p-4">
        <summary className="min-h-11 cursor-pointer py-2 font-bold">写真を追加</summary>
        <label className="block text-sm font-bold text-ink-soft">写真の用途<select value={photoPlacement} disabled={busy} onChange={(event) => { setPhotoPlacement(event.target.value as typeof photoPlacement); setPhotoRights(null); }} className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2"><option value="GALLERY">この体験の写真</option><option value="PROVIDER_PHOTO">提供者写真（全商品）</option><option value="BUSINESS_LOGO">事業者ロゴ（全商品）</option></select></label>
        <Field label="写真の説明（英語）" value={photoAlt} onChange={setPhotoAlt} />
        <Field label="写真の説明（日本語）" value={photoAltJa} onChange={setPhotoAltJa} />
        <Field label="写真クレジット（任意）" value={photoCredit} onChange={setPhotoCredit} />
        <HostSharedPhotoOffer disabled={busy || !!conflictProduct} onUse={(photo) => { setSelectedPhoto(photo); setSharedPhotoName(photo.name); setPhotoRights(null); }} />
        <label className="block text-sm font-bold text-ink-soft">端末から選ぶ<input type="file" accept="image/jpeg,image/png" disabled={busy} onChange={(event) => { setSelectedPhoto(event.target.files?.[0] ?? null); setSharedPhotoName(null); setPhotoRights(null); }} className="mt-1 block max-w-full font-normal" /></label>
        {sharedPhotoName && selectedPhoto ? <p className="text-sm text-ink-soft">共有された写真を選択中: <span className="[overflow-wrap:anywhere]">{sharedPhotoName}</span></p> : null}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={rightsConfirmed} disabled={busy || !selectedPhoto} onChange={(event) => setPhotoRights(event.target.checked && selectedPhoto ? { file: selectedPhoto, productId: product.id, placement: photoPlacement } : null)} /><span>この写真を「{photoPlacement === "GALLERY" ? "この体験の写真" : photoPlacement === "PROVIDER_PHOTO" ? "提供者写真" : "事業者ロゴ"}」として{photoPlacement === "GALLERY" ? "この商品" : "販売者のすべての商品"}に公開する権利があり、権利者と写っている方から明示的な許諾を得ています。</span></label>
        <button type="button" disabled={busy || !!conflictProduct || !selectedPhoto || !rightsConfirmed || !photoAlt.trim() || !photoAltJa.trim()} className={consoleButtonClass("secondary")} onClick={() => void uploadPhoto()}>写真を追加・差し替え</button>
      </details>
    </section>;
    const pageSections = <div id="publication-page-panel" className="space-y-4">
      {languageSwitch}
      {translationControls}
      {photoSection}
      <section className={`${HOST_SURFACE} space-y-4 p-4 md:p-6`} aria-labelledby="publication-intro-title"><h2 id="publication-intro-title" className="text-base font-extrabold">ひとこと紹介・言語・説明</h2>{localeField("title", "体験名", "Experience title")}{localeField("lead", "ひとこと紹介", "Short introduction", 2)}{localeField("language", "当日の言語", "Languages during the experience")}{localeField("description", "詳しい説明", "Description", 7)}</section>
      <section className={`${HOST_SURFACE} space-y-4 p-4 md:p-6`} aria-labelledby="publication-highlights-title"><h2 id="publication-highlights-title" className="text-base font-extrabold">見どころ・含まれるもの</h2>{localeListField("highlights", "見どころ", "Highlights")}{localeListField("included", "含まれるもの", "Included", 2)}{localeListField("notIncluded", "含まれないもの", "Not included", 2)}</section>
      <section className={`${HOST_SURFACE} space-y-4 p-4 md:p-6`} aria-labelledby="publication-timeline-title"><h2 id="publication-timeline-title" className="text-base font-extrabold">当日の流れ</h2>{timelineSection(editorLocale, localeIsJapanese ? japanese.timeline : timelineItems(content.timeline))}</section>
      <section className={`${HOST_SURFACE} space-y-4 p-4 md:p-6`} aria-labelledby="publication-meeting-title"><h2 id="publication-meeting-title" className="text-base font-extrabold">集合場所</h2><label className="block text-sm font-bold text-ink-soft">集合場所を旅行者に見せる時期<select value={String(content.meetingPointDisclosure ?? "AFTER_BOOKING")} onChange={(event) => setContent((current) => ({ ...current, meetingPointDisclosure: event.target.value === "PUBLIC" ? "PUBLIC" : "AFTER_BOOKING" }))} className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2 font-normal text-ink"><option value="AFTER_BOOKING">予約が確定してから案内する</option><option value="PUBLIC">予約前から公開する</option></select></label><Field label="予約前に公開する集合概要" value={typeof content.meetingOverview === "string" ? content.meetingOverview : ""} multiline rows={3} onChange={(next) => updateContent("meetingOverview", next || null)} /></section>
      <section className={`${HOST_SURFACE} space-y-4 p-4 md:p-6`} aria-labelledby="publication-notes-title"><h2 id="publication-notes-title" className="text-base font-extrabold">注意事項・よくある質問</h2>{localeListField("knowBeforeYouGo", "参加前の注意", "Know before you go", 2)}{localeListField("notSuitableFor", "参加に向かない条件", "Not suitable for", 2)}{faqSection(editorLocale)}</section>
      <section className={`${HOST_SURFACE} space-y-4 p-4 md:p-6`} aria-labelledby="publication-host-title"><h2 id="publication-host-title" className="text-base font-extrabold">迎える人</h2><p className="text-sm text-ink-soft">販売者表示: <span className="font-bold text-ink">{product.sellerDisplayName || "未設定"}</span></p><p className="text-sm text-muted">提供者写真と事業者ロゴは同じ販売者のすべての体験に反映されます。</p>{providerMediaDraft.map((photo) => <div key={photo.id} className="grid gap-3 rounded-xl border border-line p-3 md:grid-cols-[5rem_1fr]"><Image src={photo.previewUrl} alt={photo.altText} width={80} height={80} unoptimized className="size-20 rounded-lg object-cover" /><div className="grid gap-3 md:grid-cols-2"><p className="text-sm font-bold text-ink-soft md:col-span-2">{photo.placement === "PROVIDER_PHOTO" ? "提供者写真" : "事業者ロゴ"}</p><Field label="写真の説明（英語）" value={photo.altText} onChange={(next) => updateProviderPhoto(photo.id, { altText: next })} /><Field label="写真の説明（日本語）" value={photo.altTextJa} onChange={(next) => updateProviderPhoto(photo.id, { altTextJa: next })} /><Field label="写真クレジット（任意）" value={photo.publicCredit ?? ""} onChange={(next) => updateProviderPhoto(photo.id, { publicCredit: next.trim() ? next : null })} /><button type="button" disabled={busy || !!conflictProduct} className={`${consoleButtonClass("secondary", "sm")} justify-self-start`} onClick={() => void removeProviderMedia(photo.id)}>全商品から削除</button></div></div>)}{!providerMediaDraft.length ? <p className="text-sm text-muted">提供者写真・事業者ロゴは未設定です。写真の用途を選んで上の「写真」から追加できます。</p> : null}</section>
    </div>;
    const pricingSections = <div id="publication-pricing-panel" className="space-y-4">
      <section className={`${HOST_SURFACE} space-y-4 p-4 md:p-6`} aria-labelledby="publication-pricing-title"><h2 id="publication-pricing-title" className="text-base font-extrabold">料金</h2><Field label="大人1人の基本料金（税込・円）" value={unitAmount} onChange={setUnitAmount} /><p className="text-sm text-muted">無料体験は0円、有料料金は50円以上で入力してください。1〜49円は保存できません。</p><div className="rounded-xl bg-sand/40 p-3"><h3 className="font-bold">開催枠ごとの大人料金（税込・円）</h3><p className="mt-1 text-sm text-ink-soft">空欄なら基本料金を使います。枠別料金を使う場合は、現在の開催枠をすべて入力してください。</p>{product.offers.length ? <div className="mt-3 grid gap-3">{product.offers.map((offer) => { const price = terms.offerPrices.find((item) => item.offerId === offer.id)?.adultPriceYen ?? ""; return <Field key={offer.id} label={offerLabel(offer)} value={price} onChange={(next) => setTerms((current) => ({ ...current, offerPrices: current.offerPrices.map((item) => item.offerId === offer.id ? { ...item, adultPriceYen: next } : item) }))} placeholder={`基本料金 ¥${unitAmount || "未入力"}`} />; })}</div> : <p className="mt-3 text-sm font-bold text-amber-950">先にカレンダーで開催枠を追加すると、枠別料金を入力できます。</p>}</div><label className="flex min-h-11 items-center gap-2 font-bold"><input type="checkbox" checked={terms.childPricingEnabled} onChange={(event) => setTerms((current) => ({ ...current, childPricingEnabled: event.target.checked }))} />子ども料金を設定する</label>{terms.childPricingEnabled ? <div className="grid gap-4 rounded-xl border border-line p-3 md:grid-cols-2"><Field label="子ども1人の料金（税込・円）" value={terms.childPriceYen} onChange={(next) => setTerms((current) => ({ ...current, childPriceYen: next }))} /><Field label="子ども料金の最少年齢" value={terms.childMinAge} onChange={(next) => setTerms((current) => ({ ...current, childMinAge: next }))} /><Field label="子ども料金の最高年齢" value={terms.childMaxAge} onChange={(next) => setTerms((current) => ({ ...current, childMaxAge: next }))} /><label className="flex min-h-11 items-center gap-2 text-sm font-bold"><input type="checkbox" checked={terms.childAdultRequired} onChange={(event) => setTerms((current) => ({ ...current, childAdultRequired: event.target.checked }))} />大人の同伴を必須にする</label></div> : null}</section>
      <section className={`${HOST_SURFACE} space-y-4 p-4 md:p-6`} aria-labelledby="publication-booking-title"><h2 id="publication-booking-title" className="text-base font-extrabold">予約条件・取消条件</h2><div className="grid gap-4 md:grid-cols-2"><Field label="最少申込人数" value={terms.minimumParticipants} onChange={(next) => setTerms((current) => ({ ...current, minimumParticipants: next }))} /><Field label="最少課金人数" value={terms.minimumChargeableParticipants} onChange={(next) => setTerms((current) => ({ ...current, minimumChargeableParticipants: next }))} /><Field label="1組の上限人数" value={terms.maxPartySize} onChange={(next) => setTerms((current) => ({ ...current, maxPartySize: next }))} /><Field label="最少催行人数（任意）" value={terms.minimumAttendance} onChange={(next) => setTerms((current) => ({ ...current, minimumAttendance: next }))} /></div><label className="block text-sm font-bold text-ink-soft">取消条件<select value={terms.cancellationPolicy} onChange={(event) => setTerms((current) => ({ ...current, cancellationPolicy: event.target.value as PublicationTermsForm["cancellationPolicy"] }))} className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2"><option value="">選択してください</option><option value="CUSTOM">独自の取消期限・返金割合</option><option value="FREE_UNTIL_24H">開始24時間前まで無料</option><option value="FREE_UNTIL_48H">開始48時間前まで無料</option><option value="NONE">返金なし</option></select></label>{terms.cancellationPolicy === "CUSTOM" ? <div className="grid gap-4 md:grid-cols-2"><label className="block text-sm font-bold text-ink-soft">無料取消の期限（開始前）<div className="mt-1 grid grid-cols-[1fr_auto] gap-2"><input value={terms.cancellationWindowValue} onChange={(event) => setTerms((current) => ({ ...current, cancellationWindowValue: event.target.value }))} inputMode="numeric" className="w-full rounded-xl border border-line bg-white px-3 py-2 font-normal text-ink" /><select value={terms.cancellationWindowUnit} onChange={(event) => setTerms((current) => ({ ...current, cancellationWindowUnit: event.target.value as PublicationTermsForm["cancellationWindowUnit"] }))} className="rounded-xl border border-line bg-white px-3 py-2"><option value="DAYS">日前</option><option value="HOURS">時間前</option><option value="MINUTES">分前</option></select></div></label><label className="block text-sm font-bold text-ink-soft">期限内の返金割合（%）<input value={terms.cancellationRefundPercent} onChange={(event) => setTerms((current) => ({ ...current, cancellationRefundPercent: event.target.value }))} inputMode="decimal" placeholder="例: 100 または 37.5" className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 font-normal text-ink" /></label></div> : null}<p className="text-sm text-muted">取消期限と返金割合には確定済みの条件を入力してください。最少催行人数に達しない場合の自動取消・返金はありません。</p></section>
      <section className={`${HOST_SURFACE} space-y-3 p-4 md:p-6`} aria-labelledby="publication-questions-title"><h2 id="publication-questions-title" className="text-base font-extrabold">申込時の質問</h2><p className="text-sm text-ink-soft">保存済みの質問 {product.saleTerms?.bookingQuestions.length ?? 0}件</p><p className="text-sm text-muted">現在の質問はこの画面の保存でも維持されます。質問の追加・変更は、質問編集に対応した商品画面で行ってください。</p></section>
    </div>;
    const listingRail = <aside className="order-first space-y-4 md:sticky md:top-4 md:order-none md:col-start-2 md:row-start-1 md:self-start" aria-label="掲載・料金・日程">
      <section className={`${HOST_SURFACE} space-y-3 p-4`} aria-labelledby="publication-listing-title"><div className="flex items-center justify-between gap-3"><h2 id="publication-listing-title" className="font-extrabold">掲載</h2><span className="rounded-full bg-sand px-2.5 py-1 text-xs font-extrabold">{STATUS_COPY[product.status]}</span></div><p className="text-sm text-ink-soft">{nextActionText}</p>{nextActionControl ? <div>{nextActionControl}</div> : null}{publicHref && nextAction !== "LIVE" ? <Link className="text-sm font-bold text-moss underline underline-offset-4" href={publicHref}>体験ページを見る</Link> : null}{product.status === "PUBLISHED" ? <button type="button" disabled={busy || dirty || !!conflictProduct} className={consoleButtonClass("ghost", "sm", "text-danger")} onClick={() => void changeState("stop")}>新しい予約を停止</button> : null}<details className="border-t border-line pt-2"><summary className="min-h-10 cursor-pointer py-2 font-bold">公開前の確認</summary>{!dirty && savedBlockers.length ? <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">{savedBlockers.map((blocker) => <li key={blocker}>{BLOCKER_COPY[blocker] ?? "公開条件を確認してください。"}</li>)}</ul> : !dirty ? <p className="text-sm font-bold text-moss">保存済みの内容は公開条件を満たしています。</p> : <p className="text-sm text-ink-soft">保存後に公開条件を確認できます。</p>}</details></section>
      <section className={`${HOST_SURFACE} hidden space-y-2 p-4 md:block`}><h2 className="font-extrabold">料金・予約</h2><p className="text-lg font-extrabold tabular-nums">{asPublicationPrice(unitAmount) === null ? "未設定" : `¥${Number(unitAmount).toLocaleString("ja-JP")}`} <span className="text-xs font-normal text-muted">/ 大人1名</span></p><p className="text-sm text-muted">1組 {terms.minimumParticipants || "–"}–{terms.maxPartySize || "–"}名</p><button type="button" className="text-sm font-bold text-moss underline underline-offset-4" onClick={() => setWorkspaceSection("pricing")}>料金・条件を編集</button></section>
      <section className={`${HOST_SURFACE} hidden space-y-2 p-4 md:block`}><h2 className="font-extrabold">開催日程</h2><p className="text-sm text-ink-soft">日程と定員はカレンダーで登録します。</p><Link className="text-sm font-bold text-moss underline underline-offset-4" href={calendarHref}>カレンダーを開く</Link></section>
      <details className={`${HOST_SURFACE} p-4`}><summary className="min-h-10 cursor-pointer py-2 font-bold">体験ページのアドレス</summary><div className="space-y-3 pt-2"><Field label="ページのアドレス" value={slug} onChange={setSlug} /><p className="break-all text-xs text-muted">/experiences/{slug || "ページ名"}</p></div></details>
    </aside>;
    return <HostPageBody>
      <PageHead title={localeIsJapanese ? japanese.title || title || "体験を編集" : title || japanese.title || "体験を編集"} />
      {statusAndMessages}
      <nav className="mb-4 flex gap-5 overflow-x-auto border-b border-line" aria-label="体験の編集">
        <button type="button" disabled={busy} aria-pressed={workspaceSection === "page"} className={`min-h-11 shrink-0 border-b-2 px-1 text-sm font-bold ${workspaceSection === "page" ? "border-ink text-ink" : "border-transparent text-muted"}`} onClick={() => setWorkspaceSection("page")}>体験ページ</button>
        <button type="button" disabled={busy} aria-pressed={workspaceSection === "pricing"} className={`min-h-11 shrink-0 border-b-2 px-1 text-sm font-bold ${workspaceSection === "pricing" ? "border-ink text-ink" : "border-transparent text-muted"}`} onClick={() => setWorkspaceSection("pricing")}>料金・予約</button>
        <Link href={calendarHref} aria-disabled={busy} tabIndex={busy ? -1 : undefined} onClick={(event) => { if (busy) event.preventDefault(); }} className="flex min-h-11 shrink-0 items-center border-b-2 border-transparent px-1 text-sm font-bold text-muted">日程</Link>
      </nav>
      <form id="product-editor" aria-busy={busy} onSubmit={(event) => void saveAll(event)} className="scroll-mt-24">
        <fieldset disabled={busy} className="border-0 p-0">
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_320px] md:items-start">
            {listingRail}
            <div className="min-w-0 md:col-start-1 md:row-start-1">{workspaceSection === "page" ? pageSections : pricingSections}</div>
          </div>
        </fieldset>
      </form>
      {stateConfirm ? <HostConfirmDialog title={stateConfirm === "stop" ? "新しい予約を停止しますか？" : "この商品を公開しますか？"} description={stateConfirm === "stop" ? "この商品の新しい予約を停止します。受け付けた予約はそのまま残ります。" : "掲載条件を確認し、この商品を公開します。公開内容と販売条件に同意します。"} focusRef={stateConfirmStay} stayRef={stateConfirmStay} confirm={<button type="submit" className={consoleButtonClass("primary")}>{stateConfirm === "stop" ? "停止する" : "同意して公開する"}</button>} onConfirm={() => { const action = stateConfirm; void runStateChange(action); }} onClose={() => setStateConfirm(null)} /> : null}
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
        <p className="font-bold text-ink">事務局の英語原稿レビュー</p>
        <p className="mt-1">{product.adminEnglishReview?.reviewed ? "現在の保存版を確認済みです。" : "英語文面を読み、日本語原稿との対応を確認してください。"}</p>
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
    {error || conflictProduct ? <div role="alert" className="mb-3 rounded-xl bg-rose-50 p-3 text-rose-900">{error ? <p>{error}</p> : null}{conflictProduct ? <><p className="mt-2 text-sm">サーバーの最新状態: {conflictProduct.draft.publicTitle}（{STATUS_COPY[conflictProduct.status]}・version {conflictProduct.version}）</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={busy} className={consoleButtonClass("secondary")} onClick={() => void replaceDraftWithLatest()}>入力を破棄して最新を読み込む</button><button type="button" disabled={busy} className={consoleButtonClass("primary")} onClick={() => void reapplyDraftOnLatest()}>自分の入力を残して続ける</button></div></> : null}</div> : null}
    {notice ? <p role="status" className="mb-3 rounded-xl bg-green-50 p-3 text-green-900">{notice}</p> : null}
    {product.status === "SUSPENDED" ? <p className="mb-3 rounded-xl bg-amber-50 p-3 text-amber-950">運営停止中です。入力と下書きは保存できますが、再開は運営の停止解除後に行えます。</p> : null}
    <form id="product-editor" aria-busy={busy} onSubmit={(event) => void saveAll(event)} className="scroll-mt-24 space-y-4">
      <fieldset disabled={busy} className="space-y-4 border-0 p-0">
      <section className={`${HOST_SURFACE} space-y-4 p-4 md:p-6`}><h2 className="text-base font-extrabold">商品情報・英語原稿</h2><Field label="公開URL用slug" value={slug} onChange={setSlug} /><Field label="商品名（英語・公開用）" value={title} onChange={updateEnglishTitle} /><Field label="大人1人の基本料金（税込・円）" value={unitAmount} onChange={setUnitAmount} /><p className="text-sm text-muted">販売者表示: {product.sellerDisplayName || "未設定"}</p>{textField("lead", "紹介文（英語）", typeof content.lead === "string" ? content.lead : "", 2)}{textField("description", "体験の説明（英語）", typeof content.description === "string" ? content.description : "", 7)}<Field label="当日の言語（英語）" value={isRecord(content.facts) && typeof content.facts.language === "string" ? content.facts.language : ""} onChange={(next) => updateEnglishContent("facts", { ...(isRecord(content.facts) ? content.facts : {}), language: next })} />{listField("highlights", "体験の特徴（英語・1行ごと）")}{listField("included", "料金に含まれるもの（英語・1行ごと）")}{listField("notIncluded", "料金に含まれないもの（英語・1行ごと）")}{listField("knowBeforeYouGo", "参加前に知っておくこと（英語・1行ごと）")}{listField("notSuitableFor", "参加に向かない条件（英語・1行ごと）")}<div className="rounded-xl border border-line bg-sand/40 p-4"><h3 className="font-extrabold">日本語原稿・英語翻訳</h3><p className="mt-1 text-sm text-ink-soft">{adminDraft ? "日本語と手入力の英語原稿を照合し、OWNER本人の確認とは区別された事務局レビューとして確定します。" : "英語は手入力でも翻訳案からでも準備できます。日英の内容を照合し、英語原稿を確認してから保存してください。"}</p><div className="mt-4 space-y-4"><Field label="商品名（日本語）" value={japaneseManuscript(content).title} onChange={(next) => updateJapanese("title", next)} /><Field label="紹介文（日本語）" value={japaneseManuscript(content).lead} multiline rows={2} onChange={(next) => updateJapanese("lead", next)} /><Field label="体験の説明（日本語）" value={japaneseManuscript(content).description} multiline rows={5} onChange={(next) => updateJapanese("description", next)} /><Field label="当日の言語（日本語）" value={japaneseManuscript(content).language} onChange={(next) => updateJapanese("language", next)} /><Field label="特徴（日本語・1行ごと）" value={japaneseManuscript(content).highlights.join("\n")} multiline rows={3} onChange={(next) => updateJapanese("highlights", next.split("\n").filter(Boolean))} /><Field label="含まれるもの（日本語・1行ごと）" value={japaneseManuscript(content).included.join("\n")} multiline rows={2} onChange={(next) => updateJapanese("included", next.split("\n").filter(Boolean))} /><Field label="含まれないもの（日本語・1行ごと）" value={japaneseManuscript(content).notIncluded.join("\n")} multiline rows={2} onChange={(next) => updateJapanese("notIncluded", next.split("\n").filter(Boolean))} /><Field label="参加前の注意（日本語・1行ごと）" value={japaneseManuscript(content).knowBeforeYouGo.join("\n")} multiline rows={2} onChange={(next) => updateJapanese("knowBeforeYouGo", next.split("\n").filter(Boolean))} /><Field label="参加に向かない条件（日本語・1行ごと）" value={japaneseManuscript(content).notSuitableFor.join("\n")} multiline rows={2} onChange={(next) => updateJapanese("notSuitableFor", next.split("\n").filter(Boolean))} />{!adminDraft ? <><div className="flex flex-wrap gap-2"><button type="button" disabled={translationBusy || busy} className={consoleButtonClass("secondary")} onClick={() => void generateEnglish()}>{translationBusy ? "翻訳中…" : "日本語から英語案を作成"}</button><button type="button" disabled={translationBusy || busy || englishIsConfirmed(content.translation)} className={consoleButtonClass("secondary")} onClick={confirmEnglish}>英語原稿を確認</button></div><p className="text-xs text-muted">{englishIsConfirmed(content.translation) ? "英語原稿を確認済み" : "未確認の英語原稿は公開できません。日本語を編集すると確認状態が解除されます。"}</p>{liveEnglishStaleNote(product.status, englishIsConfirmed(content.translation)) ? <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950">{liveEnglishStaleNote(product.status, englishIsConfirmed(content.translation))}</p> : null}</> : <><button type="button" disabled={busy || dirty || product.adminEnglishReview?.reviewed === true} className={consoleButtonClass("secondary")} onClick={() => void confirmAdminEnglish()}>事務局として英語原稿を確認</button><p className="text-xs text-muted">{product.adminEnglishReview?.reviewed ? "現在の保存版の日英fingerprintを事務局レビューとして記録済みです。" : "保存後、事務局担当者が日英原稿を照合して確認してください。OWNER本人の確認としては記録されません。"}</p></>}</div></div><Field label="集合場所の公開区分" value={String(content.meetingPointDisclosure ?? "AFTER_BOOKING")} onChange={(next) => setContent((current) => ({ ...current, meetingPointDisclosure: next === "PUBLIC" ? "PUBLIC" : "AFTER_BOOKING" }))} /><Field label="予約前に公開する集合概要" value={typeof content.meetingOverview === "string" ? content.meetingOverview : ""} multiline rows={3} onChange={(next) => updateContent("meetingOverview", next || null)} /></section>
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
