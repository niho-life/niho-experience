"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HOST_SURFACE, consoleButtonClass } from "./host-ui";
import { HostPageBody, PageHead } from "./ui";

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
  draft: { slug: string; publicTitle: string; content: Record<string, unknown>; currency: "JPY"; unitAmount: number };
  sellerDisplayName: string;
  saleTerms: SaleTerms | null;
  media: Media[];
};
type ProductResponse = { product: Product; publicationConsentVersion?: string };
type TimelineItem = { time: string; title: string; text: string; photoIndex: number | null };
type LocaleManuscript = { title: string; lead: string; description: string; language: string; highlights: string[]; included: string[]; notIncluded: string[]; knowBeforeYouGo: string[]; notSuitableFor: string[]; timeline: TimelineItem[] };
type TermsForm = {
  minimumParticipants: string;
  minimumChargeableParticipants: string;
  maxPartySize: string;
  minimumAttendance: string;
  cancellationPolicy: "" | "CUSTOM" | "NONE" | "FREE_UNTIL_24H" | "FREE_UNTIL_48H";
  cancellationWindowMinutesBeforeStart: string;
  cancellationRefundBasisPoints: string;
};
type Props = { productId?: string; create?: boolean };

const blankContent = {
  lead: "", description: "", facts: { language: "" }, highlights: [], included: [], notIncluded: [],
  knowBeforeYouGo: [], notSuitableFor: [], timeline: [], meetingOverview: null,
  meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
};
const blankJapanese: LocaleManuscript = { title: "", lead: "", description: "", language: "", highlights: [], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [] };
const emptyTerms: TermsForm = {
  minimumParticipants: "", minimumChargeableParticipants: "", maxPartySize: "", minimumAttendance: "",
  cancellationPolicy: "", cancellationWindowMinutesBeforeStart: "", cancellationRefundBasisPoints: "",
};
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
};

const BLOCKER_COPY: Record<string, string> = {
  ACCOUNT_NOT_USABLE: "NIHOアカウントが利用できる状態か確認してください。",
  CANCELLATION_TERMS_REQUIRED: "取消期限と返金割合を入力してください。",
  CONNECT_NOT_READY: "販売者の受取口座を確認してください。",
  CONSENT_OUTDATED: "掲載条件が更新されました。最新の条件を確認して公開してください。",
  FEE_SETTINGS_REQUIRED: "運営側の手数料設定が完了するまで公開できません。",
  MANUSCRIPT_REQUIRED: "日本語原稿と確認済みの英語原稿を完成させてください。",
  OPERATIONS_SUSPENDED: "運営停止中のため再開できません。",
  OWNER_NOT_CURRENT: "最新のOWNER権限を確認できません。ログインし直してください。",
  PHOTOS_REQUIRED: "商品写真を追加し、日本語と英語の説明を入力してください。",
  PRICE_REQUIRED: "有効な商品価格を入力してください。",
  PUBLIC_CONTENT_INVALID: "公開原稿の入力内容を確認してください。",
  READINESS_EXPIRED: "販売者と受取口座の確認が期限切れです。再読み込みしてください。",
  READINESS_MISSING: "販売者の設定を読み込めませんでした。再読み込みしてください。",
  SCHEDULE_REQUIRED: "販売できる開催枠をカレンダーに追加してください。",
  SELLER_MISMATCH: "販売者情報をNIHOの本人情報と確認できません。",
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
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
async function fingerprint(value: unknown): Promise<string> {
  const bytes = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function lines(value: unknown): string { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join("\n") : ""; }
function japaneseManuscript(content: Record<string, unknown>): LocaleManuscript {
  const source = isRecord(content.ja) ? content.ja : {};
  return {
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
function asNumber(value: string): number | null { if (!/^\d+$/.test(value)) return null; const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : null; }
function base64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
function termsForm(terms: SaleTerms | null): TermsForm {
  if (!terms) return emptyTerms;
  return {
    minimumParticipants: String(terms.minimumParticipants),
    minimumChargeableParticipants: String(terms.minimumChargeableParticipants),
    maxPartySize: String(terms.maxPartySize),
    minimumAttendance: terms.minimumAttendance === null ? "" : String(terms.minimumAttendance),
    cancellationPolicy: terms.cancellationPolicy,
    cancellationWindowMinutesBeforeStart: terms.cancellationWindowMinutesBeforeStart === null ? "" : String(terms.cancellationWindowMinutesBeforeStart),
    cancellationRefundBasisPoints: String(terms.cancellationRefundBasisPoints),
  };
}
function termsPayload(value: TermsForm): Record<string, unknown> | null {
  const minimumParticipants = asNumber(value.minimumParticipants);
  const minimumChargeableParticipants = asNumber(value.minimumChargeableParticipants);
  const maxPartySize = asNumber(value.maxPartySize);
  const minimumAttendance = value.minimumAttendance === "" ? null : asNumber(value.minimumAttendance);
  if (minimumParticipants === null || minimumChargeableParticipants === null || maxPartySize === null
    || value.cancellationPolicy === "" || (value.minimumAttendance !== "" && minimumAttendance === null)) return null;
  const base: Record<string, unknown> = {
    childPricing: null, minimumParticipants, minimumChargeableParticipants, maxPartySize,
    minimumAttendance, cancellationPolicy: value.cancellationPolicy, bookingQuestions: [], conditionsVersion: null,
  };
  if (value.cancellationPolicy === "CUSTOM") {
    const minutes = asNumber(value.cancellationWindowMinutesBeforeStart);
    const refund = asNumber(value.cancellationRefundBasisPoints);
    if (minutes === null || refund === null || refund > 10000) return null;
    base.cancellationWindowMinutesBeforeStart = minutes;
    base.cancellationRefundBasisPoints = refund;
  }
  return base;
}

function parseBaseline(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch { return null; }
}

function saveLocal(productId: string, form: unknown) {
  try { window.sessionStorage.setItem(`experience-product-draft:${productId}`, JSON.stringify(form)); } catch { /* Storage may be disabled; live component state still protects input. */ }
}
function clearLocal(productId: string) { try { window.sessionStorage.removeItem(`experience-product-draft:${productId}`); } catch { /* Best effort. */ } }

function Field({ label, value, onChange, multiline = false, rows = 3, placeholder }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean; rows?: number; placeholder?: string }) {
  const common = "mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-ink outline-none focus-visible:border-moss focus-visible:ring-2 focus-visible:ring-moss/20";
  return <label className="block text-sm font-bold text-ink-soft">{label}{multiline ? <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={rows} placeholder={placeholder} className={`${common} resize-y font-normal`} /> : <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className={`${common} font-normal`} />}</label>;
}

export function HostPublicationWorkspace({ productId, create = false }: Props) {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [product, setProduct] = useState<Product | null>(null);
  const [consentVersion, setConsentVersion] = useState("");
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [unitAmount, setUnitAmount] = useState("");
  const [content, setContent] = useState<Record<string, unknown>>(blankContent);
  const [terms, setTerms] = useState<TermsForm>(emptyTerms);
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
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<File | null>(null);
  const [translationBusy, setTranslationBusy] = useState(false);
  const [createDraftRestored, setCreateDraftRestored] = useState(false);
  const japaneseSourceRef = useRef<LocaleManuscript>(blankJapanese);
  const englishDraftRef = useRef<{ title: string; content: Record<string, unknown> }>({ title: "", content: blankContent });

  const baselineForm = useMemo(() => parseBaseline(baseline), [baseline]);
  const draftFormJson = useMemo(() => JSON.stringify({ slug, title, unitAmount, content }), [slug, title, unitAmount, content]);
  const baselineDraftJson = baselineForm ? JSON.stringify({ slug: baselineForm.slug, title: baselineForm.title, unitAmount: baselineForm.unitAmount, content: baselineForm.content }) : "";
  const draftDirty = !!product && (!baselineForm || draftFormJson !== baselineDraftJson);
  const termsDirty = !!product && (!baselineForm || JSON.stringify(terms) !== JSON.stringify(baselineForm.terms));
  const mediaDirty = !!product && (!baselineForm || JSON.stringify(mediaForm(mediaDraft)) !== JSON.stringify(baselineForm.media));
  const providerMediaDirty = !!product && JSON.stringify(providerMediaForm(providerMediaDraft)) !== providerMediaBaseline;
  const dirty = create ? Boolean(slug || title || unitAmount) : !!product && (draftDirty || termsDirty || mediaDirty || providerMediaDirty);
  const updateContent = useCallback((key: string, value: unknown) => setContent((current) => ({ ...current, [key]: value })), []);

  function updateJapanese(key: keyof LocaleManuscript, value: string | string[] | TimelineItem[]) {
    const next = { ...japaneseSourceRef.current, [key]: value } as LocaleManuscript;
    japaneseSourceRef.current = next;
    setContent((current) => ({ ...current, ja: next, translation: { sourceFingerprint: null, confirmedSourceFingerprint: null } }));
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

  const refresh = useCallback(async (restoreLocal = true) => {
    const [response, providerResponse] = await Promise.all([
      fetch(`/host/api/products/${encodeURIComponent(productId ?? "")}`, { cache: "no-store", credentials: "same-origin" }),
      fetch("/host/api/provider-media", { cache: "no-store", credentials: "same-origin" }),
    ]);
    const [body, providerBody]: [unknown, unknown] = await Promise.all([
      response.json().catch(() => null), providerResponse.json().catch(() => null),
    ]);
    if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
    if (!providerResponse.ok) throw new Error(apiErrorMessage(providerBody, providerResponse.status));
    const result = body as ProductResponse;
    if (!isRecord(result) || !isRecord(result.product)) throw new Error("商品を読み込めませんでした。");
    if (!isRecord(providerBody) || !isRecord(providerBody.providerMedia) || !Array.isArray(providerBody.providerMedia.assets)
      || !Number.isSafeInteger(providerBody.providerMedia.version)) throw new Error("販売者プロフィールを読み込めませんでした。");
    const current = result.product;
    const currentProviderMedia = providerBody.providerMedia.assets as ProviderMedia[];
    const providerVersion = providerBody.providerMedia.version as number;
    setProduct(current); setConsentVersion(result.publicationConsentVersion ?? "");
    setProviderMediaVersion(providerVersion);
    const restored = (() => { try { const saved = window.sessionStorage.getItem(`experience-product-draft:${current.id}`); return saved ? JSON.parse(saved) as Record<string, unknown> : null; } catch { return null; } })();
    const nextContent = contentFrom(current);
    japaneseSourceRef.current = japaneseManuscript(nextContent);
    englishDraftRef.current = { title: current.draft.publicTitle, content: nextContent };
    const nextTerms = termsForm(current.saleTerms);
    const serverForm = { slug: current.draft.slug, title: current.draft.publicTitle, unitAmount: String(current.draft.unitAmount), content: nextContent, terms: nextTerms, media: mediaForm(current.media), providerMedia: providerMediaForm(currentProviderMedia) };
    if (restoreLocal && restored && isRecord(restored) && typeof restored.slug === "string" && typeof restored.title === "string" && isRecord(restored.content) && isRecord(restored.terms)) {
      const restoredProviderMedia = storedProviderMedia(restored.providerMedia, currentProviderMedia);
      setSlug(restored.slug); setTitle(restored.title); setUnitAmount(String(restored.unitAmount ?? "")); setContent(restored.content); setTerms(restored.terms as unknown as TermsForm); setMediaDraft(storedMedia(restored.media, current.media)); setProviderMediaDraft(restoredProviderMedia);
      setBaseline(JSON.stringify(serverForm));
      setProviderMediaBaseline(JSON.stringify(providerMediaForm(currentProviderMedia)));
      if (JSON.stringify(restored) !== JSON.stringify(serverForm)) setNotice("保存していない入力を復元しました。");
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
  }, [productId]);

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
        const saved = window.sessionStorage.getItem("experience-product-draft:new");
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
          if (isRecord(draft.terms)) setTerms(draft.terms as unknown as TermsForm);
          setNotice("作成前の入力を復元しました。");
        }
      } catch { /* Keep the live form usable when session storage is unavailable. */ }
      setCreateDraftRestored(true);
    });
    return () => { active = false; };
  }, [create]);

  useEffect(() => {
    if (!create || !createDraftRestored) return;
    try { window.sessionStorage.setItem("experience-product-draft:new", JSON.stringify({ slug, title, unitAmount, content, terms })); }
    catch { /* The current form still protects input in memory. */ }
  }, [content, create, createDraftRestored, slug, terms, title, unitAmount]);

  useEffect(() => {
    if (create) {
      let active = true;
      queueMicrotask(() => { if (active) void fetch("/host/api/products", { cache: "no-store", credentials: "same-origin" }).then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
        if (active && isRecord(body) && typeof body.publicationConsentVersion === "string") setConsentVersion(body.publicationConsentVersion);
      }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "販売者情報を読み込めませんでした。"); }); });
      return () => { active = false; };
    }
    if (productId) return;
    let active = true;
    queueMicrotask(() => { if (active) void fetch("/host/api/products", { cache: "no-store", credentials: "same-origin" }).then(async (response) => {
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      if (active && isRecord(body) && Array.isArray(body.products)) setProducts(body.products as Product[]);
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "商品を読み込めませんでした。"); }); });
    return () => { active = false; };
  }, [create, productId]);

  useEffect(() => {
    if (dirty && product) saveLocal(product.id, { slug, title, unitAmount, content, terms, media: mediaDraft, providerMedia: providerMediaDraft });
  }, [content, dirty, mediaDraft, product, providerMediaDraft, slug, terms, title, unitAmount]);

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  async function createProduct(event: React.FormEvent) {
    event.preventDefault(); if (busy || !slug.trim() || !title.trim() || asNumber(unitAmount) === null) return;
    setBusy(true); setError(""); setNotice("");
    const draftContent = { ...blankContent, ...content };
    try {
      const response = await fetch("/host/api/products", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: slug.trim(), publicTitle: title.trim(), content: draftContent, currency: "JPY", unitAmount: asNumber(unitAmount) }) });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      const created = (body as ProductResponse).product;
      saveLocal(created.id, { slug, title, unitAmount, content: draftContent, terms, media: [] });
      try { window.sessionStorage.removeItem("experience-product-draft:new"); } catch { /* Best effort. */ }
      router.replace(`/host/experiences/${encodeURIComponent(created.id)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "作成結果を確認できませんでした。入力を保持しています。");
      // A lost response can still have created the product. Reconcile by the unique seller slug before retry.
      try {
        const listResponse = await fetch("/host/api/products", { cache: "no-store", credentials: "same-origin" });
        const listBody = await listResponse.json().catch(() => null);
        const found = isRecord(listBody) && Array.isArray(listBody.products) ? (listBody.products as Product[]).find((item) => item.draft.slug === slug.trim()) : undefined;
        if (found) {
          saveLocal(found.id, { slug, title, unitAmount, content: draftContent, terms, media: found.media });
          try { window.sessionStorage.removeItem("experience-product-draft:new"); } catch { /* Best effort. */ }
          router.replace(`/host/experiences/${encodeURIComponent(found.id)}`);
        }
      } catch { /* Keep the entered form; an explicit retry can reconcile again. */ }
    } finally { setBusy(false); }
  }

  async function saveAll(event?: React.FormEvent) {
    event?.preventDefault();
    if (!product || busy) return;
    const amount = asNumber(unitAmount);
    const saleTerms = termsPayload(terms);
    if (draftDirty && amount === null) { setError("価格を1円以上の整数で入力してください。"); return; }
    if (!draftDirty && !mediaDirty && !termsDirty && !providerMediaDirty) return;
    if (termsDirty && !saleTerms && !draftDirty && !mediaDirty && !providerMediaDirty) {
      setError("料金・取消条件はまだ保存できません。人数と、確定した取消期限・返金割合を入力してください。入力はこのブラウザーに保持しています。");
      return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      let current = product;
      let publicationUpdated = false;
      if (mediaDirty) {
        const mediaResponse = await fetch(`/host/api/products/${encodeURIComponent(current.id)}/media`, {
          method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: current.version, media: mediaForm(mediaDraft) }),
        });
        const mediaBody: unknown = await mediaResponse.json().catch(() => null);
        if (!mediaResponse.ok) throw new Error(apiErrorMessage(mediaBody, mediaResponse.status));
        current = (mediaBody as ProductResponse).product;
        setProduct(current); setMediaDraft(current.media);
      }
      if (draftDirty) {
        const draft = { slug: slug.trim(), publicTitle: title.trim(), content, currency: "JPY", unitAmount: amount! };
        const response = await fetch(`/host/api/products/${encodeURIComponent(current.id)}`, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: current.version, draft }) });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          if (response.status === 409) {
            try { const latest = await refresh(); setConflictProduct(latest); } catch { /* Keep the conflict form and all local values. */ }
          }
          throw new Error(apiErrorMessage(body, response.status));
        }
        current = (body as ProductResponse).product;
        setProduct(current);
        publicationUpdated = Boolean((body as { publicationUpdated?: boolean }).publicationUpdated);
      }
      let saved = current;
      let termsSaved = false;
      let savedProviderMedia = providerMediaDraft;
      if (termsDirty && saleTerms) {
        const termsResponse = await fetch(`/host/api/products/${encodeURIComponent(saved.id)}/sale-terms`, { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: saved.version, saleTerms }) });
        const termsBody: unknown = await termsResponse.json().catch(() => null);
        if (!termsResponse.ok) {
          if (termsResponse.status === 409) { try { const latest = await refresh(); setConflictProduct(latest); } catch { /* Keep local form values. */ } }
          throw new Error(apiErrorMessage(termsBody, termsResponse.status));
        }
        saved = (termsBody as ProductResponse).product;
        setProduct(saved);
        termsSaved = true;
        publicationUpdated = Boolean((termsBody as { publicationUpdated?: boolean }).publicationUpdated);
      }
      if (providerMediaDirty) {
        if (providerMediaVersion === null) throw new Error("販売者プロフィールの保存版がありません。再読み込みしてください。");
        const profileResponse = await fetch("/host/api/provider-media", {
          method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: providerMediaVersion, media: providerMediaForm(providerMediaDraft) }),
        });
        const profileBody: unknown = await profileResponse.json().catch(() => null);
        if (!profileResponse.ok) throw new Error(apiErrorMessage(profileBody, profileResponse.status));
        if (!isRecord(profileBody) || !isRecord(profileBody.providerMedia) || !Array.isArray(profileBody.providerMedia.assets)
          || !Number.isSafeInteger(profileBody.providerMedia.version)) throw new Error("販売者プロフィールの保存結果を確認できませんでした。");
        const savedProfile = profileBody.providerMedia;
        setProviderMediaVersion(savedProfile.version as number);
        savedProviderMedia = savedProfile.assets as ProviderMedia[];
        setProviderMediaDraft(savedProviderMedia);
      }
      const savedContent = contentFrom(saved);
      const savedTerms = termsForm(saved.saleTerms);
      setMediaDraft(saved.media);
      const savedProviderMediaForm = providerMediaForm(savedProviderMedia);
      setProviderMediaBaseline(JSON.stringify(savedProviderMediaForm));
      setBaseline(JSON.stringify({ slug: saved.draft.slug, title: saved.draft.publicTitle, unitAmount: String(saved.draft.unitAmount), content: savedContent, terms: savedTerms, media: mediaForm(saved.media), providerMedia: savedProviderMediaForm }));
      if (termsSaved) setTerms(savedTerms);
      clearLocal(saved.id); setConflictProduct(null);
      if (publicationUpdated) setNotice("保存しました。掲載内容も更新しました。");
      else if (termsDirty && !saleTerms) setNotice("原稿・写真・販売者プロフィールを保存しました。料金・取消条件は入力途中のため、まだ保存されていません。");
      else if (saved.publicationNeedsUpdate) setNotice("下書きを保存しました。掲載中の内容は維持されています。公開条件を整えると変更を反映できます。");
      else setNotice("下書きを保存しました。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存結果を確認できませんでした。最新状態を読み直してください。");
      // Keep local edits; after a timeout, read current state and compare before another write.
      try { const latest = await refresh(); setConflictProduct(latest); } catch { /* The form and session draft remain untouched. */ }
    } finally { setBusy(false); }
  }

  async function changeState(action: "publish" | "stop") {
    if (!product || dirty || busy) { if (dirty) setError("公開・停止の前に、入力を保存してください。"); return; }
    if (action === "publish" && !window.confirm("掲載条件を確認し、この商品を公開します。公開内容と販売条件に同意しますか？")) return;
    if (action === "stop" && !window.confirm("この商品の新しい予約を停止しますか？")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/host/api/products/${encodeURIComponent(product.id)}/${action}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(action === "publish" ? { version: product.version, consentVersion, accepted: true } : { version: product.version }) });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      const saved = (body as ProductResponse).product;
      setProduct(saved); setNotice(action === "publish" ? "公開しました。" : "販売を停止しました。");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "処理結果を確認できませんでした。入力は保持しています。");
      try { await refresh(); } catch { /* State remains unchanged locally; retry after refresh. */ }
    } finally { setBusy(false); }
  }

  async function generateEnglish() {
    if (!product || translationBusy || busy) return;
    const japanese = japaneseSourceRef.current;
    if (!japanese.title.trim() || !japanese.lead.trim() || !japanese.description.trim()) { setError("日本語の商品名・紹介文・説明を入力してください。"); return; }
    const snapshot = canonicalJson(japanese);
    const englishSnapshot = canonicalJson(englishDraftRef.current);
    setTranslationBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/host/api/products/${encodeURIComponent(product.id)}/translation`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ japanese }) });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
      const result = body as { sourceFingerprint?: unknown; english?: unknown };
      if (canonicalJson(japaneseSourceRef.current) !== snapshot) { setNotice("翻訳中に日本語原稿が変更されたため、結果を破棄しました。もう一度生成してください。"); return; }
      if (canonicalJson(englishDraftRef.current) !== englishSnapshot) { setNotice("翻訳中に英語原稿が編集されたため、結果を破棄しました。入力した英語は保持しています。"); return; }
      if (typeof result.sourceFingerprint !== "string" || !isRecord(result.english)) throw new Error("翻訳結果を確認できませんでした。原稿は変更していません。");
      const english = result.english as unknown as LocaleManuscript;
      const nextContent = {
        ...englishDraftRef.current.content, lead: english.lead, description: english.description, facts: { language: english.language },
        highlights: english.highlights, included: english.included, notIncluded: english.notIncluded,
        knowBeforeYouGo: english.knowBeforeYouGo, notSuitableFor: english.notSuitableFor, timeline: english.timeline,
        translation: { sourceFingerprint: result.sourceFingerprint, confirmedSourceFingerprint: null, confirmedEnglishFingerprint: null },
      };
      englishDraftRef.current = { title: english.title, content: nextContent };
      setTitle(english.title);
      setContent(nextContent);
      setNotice("英語案を作成しました。原文と照合して必要な修正を行い、確認してから保存してください。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "翻訳できませんでした。日本語原稿は保持しています。"); }
    finally { setTranslationBusy(false); }
  }

  async function confirmEnglish() {
    const translation = isRecord(content.translation) ? content.translation : null;
    const sourceFingerprint = translation?.sourceFingerprint;
    if (typeof sourceFingerprint !== "string") return;
    const japanese = japaneseSourceRef.current;
    const english = {
      title: englishDraftRef.current.title,
      lead: englishDraftRef.current.content.lead,
      description: englishDraftRef.current.content.description,
      language: isRecord(englishDraftRef.current.content.facts) ? englishDraftRef.current.content.facts.language : null,
      highlights: englishDraftRef.current.content.highlights, included: englishDraftRef.current.content.included,
      notIncluded: englishDraftRef.current.content.notIncluded,
      knowBeforeYouGo: englishDraftRef.current.content.knowBeforeYouGo,
      notSuitableFor: englishDraftRef.current.content.notSuitableFor,
      timeline: englishDraftRef.current.content.timeline,
    };
    const [actualSourceFingerprint, confirmedEnglishFingerprint] = await Promise.all([fingerprint(japanese), fingerprint(english)]);
    if (actualSourceFingerprint !== sourceFingerprint) { setError("日本語原稿が翻訳後に変わっています。もう一度英語案を作成してください。"); return; }
    setContent((current) => ({ ...current, translation: { sourceFingerprint, confirmedSourceFingerprint: sourceFingerprint, confirmedEnglishFingerprint } }));
    setNotice("現在の英語原稿を確認しました。保存後に公開できます。");
  }

  async function uploadPhoto() {
    if (!product || !selectedPhoto || !rightsConfirmed || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const profileAsset = photoPlacement !== "GALLERY";
      if (profileAsset && providerMediaVersion === null) throw new Error("販売者プロフィールの保存版がありません。再読み込みしてください。");
      const response = await fetch(profileAsset ? "/host/api/provider-media/upload" : `/host/api/products/${encodeURIComponent(product.id)}/media`, { method: "POST", credentials: "same-origin", headers: { "content-type": selectedPhoto.type, "x-experience-photo-rights-confirmed": "true", "x-experience-photo-alt-text-utf8-base64url": base64UrlUtf8(photoAlt), "x-experience-photo-alt-text-ja-utf8-base64url": base64UrlUtf8(photoAltJa), "x-experience-media-placement": photoPlacement, ...(profileAsset ? { "x-experience-provider-media-version": String(providerMediaVersion) } : {}), ...(photoCredit.trim() ? { "x-experience-photo-credit-utf8-base64url": base64UrlUtf8(photoCredit.trim()) } : {}) }, body: selectedPhoto });
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
      setSelectedPhoto(null); setRightsConfirmed(false); setPhotoAlt(""); setPhotoAltJa(""); setPhotoCredit("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "写真を追加できませんでした。選択した写真と入力を保持しています。"); }
    finally { setBusy(false); }
  }

  async function removeProviderMedia(assetId: string) {
    if (providerMediaVersion === null || busy) return;
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

  if (create) return <HostPageBody><PageHead title="体験を作成" /><form onSubmit={createProduct} className={`${HOST_SURFACE} space-y-5 p-4 md:p-6`}>
    <p className="text-sm text-ink-soft">新しい商品をExperienceに下書き保存します。公開前の入力は公開されません。</p>
    {error ? <p role="alert" className="rounded-xl bg-rose-50 p-3 text-rose-900">{error}</p> : null}
    <Field label="公開URL用の英数字slug" value={slug} onChange={setSlug} placeholder="kamakura-community-dinner" />
    <Field label="商品名（公開用）" value={title} onChange={setTitle} />
    <Field label="大人1人の基本料金（税込・円）" value={unitAmount} onChange={setUnitAmount} />
    <button disabled={busy || !slug.trim() || !title.trim() || asNumber(unitAmount) === null} className={consoleButtonClass("primary")}>{busy ? "作成中…" : "下書きを作成"}</button>
  </form></HostPageBody>;

  if (!productId) return <HostPageBody><PageHead title="体験" /><section className={`${HOST_SURFACE} p-4 md:p-6`}>
    <div className="mb-4 flex items-center justify-between gap-3"><p className="text-ink-soft">あなたが販売する体験</p><Link className={consoleButtonClass("primary")} href="/host/experiences/new">体験を作成</Link></div>
    {error ? <p role="alert" className="mb-3 rounded-xl bg-rose-50 p-3 text-rose-900">{error}</p> : null}
    {products.length ? <ul className="divide-y divide-line">{products.map((item) => <li key={item.id} className="flex items-center justify-between gap-3 py-3"><div className="min-w-0"><Link className="font-extrabold underline-offset-2 hover:underline" href={`/host/experiences/${encodeURIComponent(item.id)}`}>{item.draft.publicTitle || "題名なし"}</Link><p className="text-sm text-muted">{item.draft.slug}</p></div><span className="rounded-full bg-sand px-2.5 py-1 text-xs font-extrabold">{STATUS_COPY[item.status]}</span></li>)}</ul> : <p className="py-6 text-center text-muted">{error ? "商品を読み込めませんでした。" : "まだ商品がありません。"}</p>}
  </section></HostPageBody>;

  if (!product) return <HostPageBody><PageHead title="体験を読み込み中" />{error ? <p role="alert" className="rounded-xl bg-rose-50 p-3 text-rose-900">{error}</p> : <p>商品を読み込んでいます…</p>}<button type="button" className={consoleButtonClass("secondary")} onClick={() => void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : "読み込みに失敗しました。"))}>再読み込み</button></HostPageBody>;

  const textField = (key: string, label: string, value: string, rows = 3) => <Field label={label} value={value} multiline rows={rows} onChange={(next) => updateEnglishContent(key, next)} />;
  const listField = (key: string, label: string) => <Field label={label} value={lines(content[key])} multiline rows={3} onChange={(next) => updateEnglishContent(key, next.split("\n").filter((item) => item.trim().length > 0))} />;
  const galleryMedia = mediaDraft.filter((item) => item.placement === "GALLERY");
  const calendarHref = `/host/calendar?experience=${encodeURIComponent(product.id)}`;
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
  return <HostPageBody>
    <PageHead title={title || "体験を編集"} />
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><span className="rounded-full bg-sand px-2.5 py-1 text-xs font-extrabold">{STATUS_COPY[product.status]}</span><div className="flex flex-wrap gap-2"><Link className={consoleButtonClass("secondary")} href={calendarHref}>開催日程を設定</Link><button type="button" disabled={busy || !dirty} className={consoleButtonClass("secondary")} onClick={() => void saveAll()}>下書きを保存</button>{product.status !== "PUBLISHED" || product.publicationNeedsUpdate ? <button type="button" disabled={busy || dirty || product.status === "SUSPENDED"} className={consoleButtonClass("primary")} onClick={() => void changeState("publish")}>{product.status === "PUBLISHED" ? "変更を公開" : "公開・再開"}</button> : null}{product.status === "PUBLISHED" ? <button type="button" disabled={busy || dirty} className={consoleButtonClass("secondary")} onClick={() => void changeState("stop")}>販売を停止</button> : null}</div></div>
    {dirty ? <p className="mb-3 rounded-xl bg-amber-50 p-3 text-amber-950" role="status">未保存の変更があります。公開・停止は保存後に実行できます。</p> : null}
    {product.publicationNeedsUpdate ? <p className="mb-3 rounded-xl bg-amber-50 p-3 text-amber-950" role="status">現在の掲載版を維持しています。公開条件を満たす変更を反映すると、確認後に新しい掲載版へ切り替わります。</p> : null}
    {error ? <div role="alert" className="mb-3 rounded-xl bg-rose-50 p-3 text-rose-900"><p>{error}</p>{conflictProduct ? <div className="mt-2 flex flex-wrap gap-2"><button type="button" className={consoleButtonClass("secondary")} onClick={() => { void refresh(false).then((remote) => { clearLocal(remote.id); setError(""); }).catch((reason) => setError(reason instanceof Error ? reason.message : "最新状態を読み込めませんでした。入力は保持しています。")); }}>最新の保存内容に置き換える</button><button type="button" className={consoleButtonClass("secondary")} onClick={() => void refresh().catch(() => undefined)}>競合を再確認</button></div> : null}</div> : null}
    {notice ? <p role="status" className="mb-3 rounded-xl bg-green-50 p-3 text-green-900">{notice}</p> : null}
    {product.status === "SUSPENDED" ? <p className="mb-3 rounded-xl bg-amber-50 p-3 text-amber-950">運営停止中です。入力と下書きは保存できますが、再開は運営の停止解除後に行えます。</p> : null}
    <form onSubmit={(event) => void saveAll(event)} className="space-y-4">
      <section className={`${HOST_SURFACE} space-y-4 p-4 md:p-6`}><h2 className="text-base font-extrabold">商品情報・英語原稿</h2><Field label="公開URL用slug" value={slug} onChange={setSlug} /><Field label="商品名（英語・公開用）" value={title} onChange={updateEnglishTitle} /><Field label="大人1人の基本料金（税込・円）" value={unitAmount} onChange={setUnitAmount} /><p className="text-sm text-muted">販売者表示: {product.sellerDisplayName || "未設定"}</p>{textField("lead", "紹介文（英語）", typeof content.lead === "string" ? content.lead : "", 2)}{textField("description", "体験の説明（英語）", typeof content.description === "string" ? content.description : "", 7)}<Field label="当日の言語（英語）" value={isRecord(content.facts) && typeof content.facts.language === "string" ? content.facts.language : ""} onChange={(next) => updateEnglishContent("facts", { ...(isRecord(content.facts) ? content.facts : {}), language: next })} />{listField("highlights", "体験の特徴（英語・1行ごと）")}{listField("included", "料金に含まれるもの（英語・1行ごと）")}{listField("notIncluded", "料金に含まれないもの（英語・1行ごと）")}{listField("knowBeforeYouGo", "参加前に知っておくこと（英語・1行ごと）")}{listField("notSuitableFor", "参加に向かない条件（英語・1行ごと）")}<div className="rounded-xl border border-line bg-sand/40 p-4"><h3 className="font-extrabold">日本語原稿・英語翻訳</h3><p className="mt-1 text-sm text-ink-soft">翻訳案は保存・公開されません。内容を確認し、英語を編集した後に確認操作をしてください。</p><div className="mt-4 space-y-4"><Field label="商品名（日本語）" value={japaneseManuscript(content).title} onChange={(next) => updateJapanese("title", next)} /><Field label="紹介文（日本語）" value={japaneseManuscript(content).lead} multiline rows={2} onChange={(next) => updateJapanese("lead", next)} /><Field label="体験の説明（日本語）" value={japaneseManuscript(content).description} multiline rows={5} onChange={(next) => updateJapanese("description", next)} /><Field label="当日の言語（日本語）" value={japaneseManuscript(content).language} onChange={(next) => updateJapanese("language", next)} /><Field label="特徴（日本語・1行ごと）" value={japaneseManuscript(content).highlights.join("\n")} multiline rows={3} onChange={(next) => updateJapanese("highlights", next.split("\n").filter(Boolean))} /><Field label="含まれるもの（日本語・1行ごと）" value={japaneseManuscript(content).included.join("\n")} multiline rows={2} onChange={(next) => updateJapanese("included", next.split("\n").filter(Boolean))} /><Field label="含まれないもの（日本語・1行ごと）" value={japaneseManuscript(content).notIncluded.join("\n")} multiline rows={2} onChange={(next) => updateJapanese("notIncluded", next.split("\n").filter(Boolean))} /><Field label="参加前の注意（日本語・1行ごと）" value={japaneseManuscript(content).knowBeforeYouGo.join("\n")} multiline rows={2} onChange={(next) => updateJapanese("knowBeforeYouGo", next.split("\n").filter(Boolean))} /><Field label="参加に向かない条件（日本語・1行ごと）" value={japaneseManuscript(content).notSuitableFor.join("\n")} multiline rows={2} onChange={(next) => updateJapanese("notSuitableFor", next.split("\n").filter(Boolean))} /><div className="flex flex-wrap gap-2"><button type="button" disabled={translationBusy || busy} className={consoleButtonClass("secondary")} onClick={() => void generateEnglish()}>{translationBusy ? "翻訳中…" : "日本語から英語案を作成"}</button><button type="button" disabled={translationBusy || !isRecord(content.translation) || typeof content.translation.sourceFingerprint !== "string" || content.translation.confirmedSourceFingerprint === content.translation.sourceFingerprint} className={consoleButtonClass("secondary")} onClick={confirmEnglish}>英語原稿を確認</button></div><p className="text-xs text-muted">{isRecord(content.translation) && content.translation.confirmedSourceFingerprint === content.translation.sourceFingerprint && typeof content.translation.sourceFingerprint === "string" ? "英語原稿を確認済み" : "未確認の英語原稿は公開できません。日本語を編集すると確認状態が解除されます。"}</p></div></div><Field label="集合場所の公開区分" value={String(content.meetingPointDisclosure ?? "AFTER_BOOKING")} onChange={(next) => setContent((current) => ({ ...current, meetingPointDisclosure: next === "PUBLIC" ? "PUBLIC" : "AFTER_BOOKING" }))} /><Field label="予約前に公開する集合概要" value={typeof content.meetingOverview === "string" ? content.meetingOverview : ""} multiline rows={3} onChange={(next) => updateContent("meetingOverview", next || null)} /></section>
      <section className={`${HOST_SURFACE} space-y-4 p-4 md:p-6`}><h2 className="text-base font-extrabold">料金・販売条件</h2><div className="grid gap-4 md:grid-cols-2"><Field label="最少申込人数" value={terms.minimumParticipants} onChange={(next) => setTerms((current) => ({ ...current, minimumParticipants: next }))} /><Field label="最少課金人数" value={terms.minimumChargeableParticipants} onChange={(next) => setTerms((current) => ({ ...current, minimumChargeableParticipants: next }))} /><Field label="1組の上限人数" value={terms.maxPartySize} onChange={(next) => setTerms((current) => ({ ...current, maxPartySize: next }))} /><Field label="最少催行人数（任意）" value={terms.minimumAttendance} onChange={(next) => setTerms((current) => ({ ...current, minimumAttendance: next }))} /></div><label className="block text-sm font-bold text-ink-soft">取消条件<select value={terms.cancellationPolicy} onChange={(event) => setTerms((current) => ({ ...current, cancellationPolicy: event.target.value as TermsForm["cancellationPolicy"] }))} className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2"><option value="">選択してください</option><option value="CUSTOM">独自の取消期限・返金割合</option><option value="FREE_UNTIL_24H">開始24時間前まで無料</option><option value="FREE_UNTIL_48H">開始48時間前まで無料</option><option value="NONE">返金なし</option></select></label>{terms.cancellationPolicy === "CUSTOM" ? <div className="grid gap-4 md:grid-cols-2"><Field label="無料取消の期限（開始前・分）" value={terms.cancellationWindowMinutesBeforeStart} onChange={(next) => setTerms((current) => ({ ...current, cancellationWindowMinutesBeforeStart: next }))} placeholder="確定した値を入力" /><Field label="期限内の返金割合（0〜10000 bps）" value={terms.cancellationRefundBasisPoints} onChange={(next) => setTerms((current) => ({ ...current, cancellationRefundBasisPoints: next }))} placeholder="確定した値を入力" /></div> : null}<p className="text-sm text-muted">取消期限と返金割合には確定済みの条件を入力してください。未設定の値は公開できません。最少催行人数は運営情報で、達しない場合の自動取消・返金はありません。</p></section>
      <section className={`${HOST_SURFACE} space-y-4 p-4 md:p-6`}>
        <h2 className="text-base font-extrabold">写真・販売者プロフィール</h2>
        <p className="text-sm text-ink-soft">体験写真はこの商品に、提供者写真と事業者ロゴは同じ販売者の全商品に反映されます。事業者サイトがなくても販売者名を表示します。</p>
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
        <div className="border-t border-line pt-4">
          <h3 className="font-bold">販売者プロフィール画像（すべての体験に適用）</h3>
          <p className="mt-1 text-sm text-ink-soft">NIHOアカウントの本人写真や拠点ロゴは転用しません。提供者写真・事業者ロゴは個別に選び、権利を確認してください。</p>
          {providerMediaDraft.map((photo) => <div key={photo.id} className="mt-3 grid gap-3 rounded-xl border border-line p-3 md:grid-cols-[5rem_1fr]">
            <Image src={photo.previewUrl} alt={photo.altText} width={80} height={80} unoptimized className="size-20 rounded-lg object-cover" />
            <div className="grid gap-3 md:grid-cols-2">
              <p className="text-sm font-bold text-ink-soft">{photo.placement === "PROVIDER_PHOTO" ? "提供者写真" : "事業者ロゴ"}</p>
              <Field label="写真の説明（英語）" value={photo.altText} onChange={(next) => updateProviderPhoto(photo.id, { altText: next })} />
              <Field label="写真の説明（日本語）" value={photo.altTextJa} onChange={(next) => updateProviderPhoto(photo.id, { altTextJa: next })} />
              <Field label="写真クレジット（任意）" value={photo.publicCredit ?? ""} onChange={(next) => updateProviderPhoto(photo.id, { publicCredit: next.trim() ? next : null })} />
              <button type="button" disabled={busy} className={`${consoleButtonClass("secondary", "sm")} justify-self-start`} onClick={() => void removeProviderMedia(photo.id)}>全商品から削除</button>
            </div>
          </div>)}
          {!providerMediaDraft.length ? <p className="mt-2 text-sm text-muted">プロフィール画像は未設定です。</p> : null}
        </div>
        <label className="block text-sm font-bold text-ink-soft">新しい写真の用途<select value={photoPlacement} onChange={(event) => setPhotoPlacement(event.target.value as typeof photoPlacement)} className="mt-1 block w-full rounded-xl border border-line bg-white px-3 py-2"><option value="GALLERY">この体験の写真</option><option value="PROVIDER_PHOTO">提供者写真（全商品）</option><option value="BUSINESS_LOGO">事業者ロゴ（全商品）</option></select></label>
        <label className="block text-sm font-bold text-ink-soft">写真の説明（英語）<input value={photoAlt} onChange={(event) => setPhotoAlt(event.target.value)} className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 font-normal" /></label>
        <label className="block text-sm font-bold text-ink-soft">写真の説明（日本語）<input value={photoAltJa} onChange={(event) => setPhotoAltJa(event.target.value)} className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 font-normal" /></label>
        <Field label="写真クレジット（任意）" value={photoCredit} onChange={setPhotoCredit} />
        <label className="block text-sm"><input type="file" accept="image/jpeg,image/png" onChange={(event) => setSelectedPhoto(event.target.files?.[0] ?? null)} className="block" /></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} /><span>この写真を「{photoPlacement === "GALLERY" ? "この体験の写真" : photoPlacement === "PROVIDER_PHOTO" ? "提供者写真" : "事業者ロゴ"}」として{photoPlacement === "GALLERY" ? "この商品" : "販売者のすべての商品"}に公開する権利があり、権利者と写っている方から明示的な許諾を得ています。</span></label>
        <button type="button" disabled={busy || !selectedPhoto || !rightsConfirmed || !photoAlt.trim() || !photoAltJa.trim()} className={consoleButtonClass("secondary")} onClick={() => void uploadPhoto()}>写真を追加・差し替え</button>
      </section>
    </form>
    <section className={`${HOST_SURFACE} mt-4 space-y-4 p-4 md:p-6`}>
      <h2 className="font-extrabold">当日の流れ</h2>
      {timelineSection("en", timelineItems(content.timeline))}
      {timelineSection("ja", japaneseManuscript(content).timeline)}
    </section>
    <section className={`${HOST_SURFACE} mt-4 p-4 md:p-6`}><h2 className="font-extrabold">開催日程</h2><p className="mt-1 text-sm text-ink-soft">日程と定員はカレンダーで登録します。商品を保存してから開催枠を追加してください。</p><Link className={`${consoleButtonClass("secondary")} mt-3 inline-flex`} href={calendarHref}>カレンダーを開く</Link></section>
  </HostPageBody>;
}
