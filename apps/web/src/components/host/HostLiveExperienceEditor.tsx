"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExperienceProviderMeetingPoint, ExperienceProviderPageDetail, ExperienceProviderPageListingResponse, ExperienceProviderPageMeetingPointUpdateResponse, ExperienceProviderPageOffer, ExperienceProviderPhotoUploadForm } from "@niho-experience/api-client/host";
import type { HostProviderReviewStatus, HostProviderRole } from "@/lib/host/providers";
import type { EditorTab } from "@/host/page-english";
import { DISABLED, EditorPanel } from "./editor-parts";
import { FieldSection } from "./fields";
import { HostConfirmDialog } from "./HostConfirmDialog";
import { EDITOR_TAB_PANEL_ID, EditorLanguageTabs, editorTabId, LIVE_ENGLISH_TAB_LABEL } from "./HostEditorEnglish";
import { consoleButtonClass } from "./host-ui";
import { ListingSteps } from "./HostEditorRail";
import { HostIcon } from "./HostIcon";
import { HostSubHeader } from "./HostSubHeader";
import { HostPageBody } from "./ui";
import { HostLeaveDialog, useHostLeaveGuard, type HostLeaveMode } from "./HostLeaveGuard";
import { LIVE_PHOTO_LIMIT, appendPhoto, conflictValueText, liveContentProblem, liveMeetingChanged, liveMeetingProblem, liveMeetingRequest, liveOfferProblem, mergeLiveMeeting, makeCoverPhoto, mergeLivePage, movePhoto, readLiveMeeting, removePhoto, restoreSavedLiveOffers, serializeLivePagePatch, type LiveMeeting } from "./live-editor-state";
import { LIVE_ENGLISH_STATUS, liveEnglishState, readLiveEnglish } from "./live-english";
import { hostListingReviewNote, LISTING_TEXT, listingRefusal, liveListingStatus, liveListingView, providerReviewLine, publishBlockerText, readListingResponse } from "./live-listing-state";
import { LiveContentPanels, LiveExteriorPhoto } from "./LiveContentPanels";
import { LiveEnglishPanels, LiveEnglishState, type LiveEnglishLoad } from "./LiveEnglishPanels";
import { LivePagePanel } from "./LivePagePanel";
import { LivePhotosSection } from "./LivePhotosSection";
import { HostLiveOfferEditor } from "./HostLiveOfferEditor";
import { MeetingPointFields, MeetingPointSummary } from "./MeetingPointFields";
import { SaveBar } from "./SaveBar";

// The detail view comes only when 「プレビュー」 is pressed.
const HostExperiencePreview = dynamic(() => import("./HostExperiencePreview"), { ssr: false });

const PHOTO_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_FILE_FIELD = "file";

function message(status: number): string {
  if (status === 409) return "ほかの人が先に保存しました。入力は保持しています。最新の内容と照合してください。";
  if (status === 401) return "ログインの有効期限が切れました。";
  if (status === 403 || status === 404) return "この体験を操作する権限が終了しています。";
  return "保存できませんでした。入力は保持しています。";
}

/** A page (or a re-read of it) that could not be read: not "保存できませんでした". Status 0: no answer. */
function loadMessage(status: number): string {
  if (status === 401) return "ログインの有効期限が切れました。";
  if (status === 403 || status === 404) return "この体験を操作する権限が終了しています。";
  if (status === 0) return "通信できませんでした。接続を確かめてから、もう一度試してください。";
  return "体験を読み込めませんでした。";
}

function copyPage(value: ExperienceProviderPageDetail): ExperienceProviderPageDetail {
  return structuredClone(value);
}

const JSON_HEADERS = { "content-type": "application/json" };
const SAVE_UNCERTAIN = "保存結果を確認できません。再送せず、最新の内容を確認してください。";

/** One call of 申請 / 取り下げ (the publish before 申請 included): its JSON, or the status and the BFF's `error` (status 0: no answer to trust). */
async function listingCall(url: string, init: RequestInit): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string | null }> {
  let response: Response;
  try { response = await fetch(url, init); } catch { return { ok: false, status: 0, error: null }; }
  let body: unknown = null;
  try { body = await response.json(); } catch { if (response.ok) return { ok: false, status: 0, error: null }; }
  if (response.ok) return { ok: true, value: body };
  const reason = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : null;
  return { ok: false, status: response.status, error: typeof reason === "string" ? reason : null };
}

async function responseError(response: Response): Promise<string | null> {
  try {
    const body = await response.clone().json();
    return typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null;
  } catch { return null; }
}

export interface HostLiveExperienceEditorProps {
  providerId: string;
  pageId: string;
  backHref: string;
  /** Only the OWNER sees 掲載 (NIHO answers the listing to the owner only). */
  role: HostProviderRole | null;
  reviewStatus: HostProviderReviewStatus | null;
  settingsHref: string;
  siteUrl: string;
}

/**
 * 体験の編集 against NIHO (#89): the page, its photos and offers, its own 集合場所 and (OWNER) its one
 * listing on the experience site. One 保存 sends the page, then the meeting point with the page version
 * the page's save answered. 掲載 works on its own, only while nothing is left unsaved.
 */
export function HostLiveExperienceEditor({ providerId, pageId, backHref, role, reviewStatus, settingsHref, siteUrl }: HostLiveExperienceEditorProps) {
  const owner = role === "OWNER";
  const [saved, setSaved] = useState<ExperienceProviderPageDetail | null>(null);
  const [draft, setDraft] = useState<ExperienceProviderPageDetail | null>(null);
  const [latest, setLatest] = useState<ExperienceProviderPageDetail | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false); const [uncertain, setUncertain] = useState(false);
  const [uncertainOfferIds, setUncertainOfferIds] = useState<string[]>([]);
  const [uncertainOfferResolution, setUncertainOfferResolution] = useState<Record<string, string>>({});
  // A 409: 最新の保存内容を読む compares the page and the meeting point with what another editor saved.
  const [stale, setStale] = useState(false);
  const [savedMeeting, setSavedMeeting] = useState<LiveMeeting | null>(null);
  const [meeting, setMeeting] = useState<LiveMeeting | null>(null);
  const [latestMeeting, setLatestMeeting] = useState<LiveMeeting | null>(null);
  // The provider's default, as the last INHERIT read showed it.
  const [meetingDefaults, setMeetingDefaults] = useState<ExperienceProviderMeetingPoint | null>(null);
  const [meetingState, setMeetingState] = useState<"loading" | "ready" | "error">("loading");
  const [listing, setListing] = useState<ExperienceProviderPageListingResponse | null>(null);
  const [listingState, setListingState] = useState<"loading" | "ready" | "error">("loading");
  const [listingBusy, setListingBusy] = useState(false); const [listingUncertain, setListingUncertain] = useState(false);
  const [listingMessage, setListingMessage] = useState<{ tone: "error" | "notice"; text: string } | null>(null);
  const [confirming, setConfirming] = useState<"save" | "withdraw" | "stop" | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // 日本語で書く / 英語（自動訳）: a Japanese page's English is NIHO's own, read from the preview (live-english.ts).
  const [tab, setTab] = useState<EditorTab>("ja");
  const [english, setEnglish] = useState<LiveEnglishLoad>({ kind: "loading" });
  const [saving, setSaving] = useState(false); const [flash, setFlash] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  const ownedPhotoUrls = useRef(new Set<string>());
  const mounted = useRef(false);
  const loadVersion = useRef(0); const meetingVersion = useRef(0); const listingVersion = useRef(0); const englishVersion = useRef(0);
  const endpoint = `/host/api/provider-pages/${encodeURIComponent(providerId)}/${encodeURIComponent(pageId)}`;
  const load = useCallback(async (replace = true) => {
    const version = ++loadVersion.current;
    const response = await fetch(endpoint, { cache: "no-store" }).catch(() => null);
    if (!response?.ok) throw new Error(loadMessage(response?.status ?? 0));
    const value = await response.json().catch(() => null) as ExperienceProviderPageDetail | null;
    if (!value) throw new Error(loadMessage(500));
    if (version !== loadVersion.current) return null;
    if (value.id !== pageId) throw new Error("別の体験が返されました。画面を読み込み直してください。");
    if (replace) { setSaved(value); setDraft(copyPage(value)); setLatest(null); } else setLatest(value);
    return value;
  }, [endpoint, pageId]);
  // Never throws: a meeting point that cannot be read hides only its own section. Answers whether this read landed.
  const loadMeeting = useCallback(async (replace = true): Promise<boolean> => {
    const version = ++meetingVersion.current;
    let value: LiveMeeting | null = null;
    try { const response = await fetch(`${endpoint}/meeting-point`, { cache: "no-store" }); value = response.ok ? readLiveMeeting(await response.json()) : null; } catch { value = null; }
    if (version !== meetingVersion.current) return false;
    if (!value) { if (replace) setMeetingState("error"); return false; }
    if (value.mode === "INHERIT") setMeetingDefaults(value.fields);
    if (replace) { setSavedMeeting(value); setMeeting(structuredClone(value)); setLatestMeeting(null); setMeetingState("ready"); } else setLatestMeeting(value);
    return true;
  }, [endpoint]);
  const loadListing = useCallback(async () => {
    if (!owner) return;
    const version = ++listingVersion.current;
    let value: ExperienceProviderPageListingResponse | null = null;
    try { const response = await fetch(`${endpoint}/listing`, { cache: "no-store" }); value = response.ok ? readListingResponse(await response.json()) : null; } catch { value = null; }
    if (version !== listingVersion.current) return;
    if (value) { setListing(value); setListingState("ready"); } else setListingState("error");
  }, [endpoint, owner]);
  // The English NIHO made of the saved Japanese (the preview's `*En`). Never throws: a failure is said in the English tab only.
  const loadEnglish = useCallback(async () => {
    const version = ++englishVersion.current;
    setEnglish({ kind: "loading" });
    let next: LiveEnglishLoad;
    try {
      const response = await fetch(`${endpoint}/preview`, { cache: "no-store" });
      if (response.status === 404) next = { kind: "missing" };
      else if (!response.ok) next = { kind: "error", text: response.status === 401 ? "ログインの有効期限が切れました。" : "英語を読み込めませんでした。" };
      else { const value = readLiveEnglish(await response.json()); next = value ? { kind: "ready", english: value } : { kind: "error", text: "英語を読み込めませんでした。" }; }
    } catch { next = { kind: "error", text: "英語を読み込めませんでした。" }; }
    if (version === englishVersion.current) setEnglish(next);
  }, [endpoint]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (!active) return; void load().catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : loadMessage(500)); }); void loadMeeting(); void loadListing(); });
    return () => { active = false; loadVersion.current += 1; meetingVersion.current += 1; listingVersion.current += 1; englishVersion.current += 1; };
  }, [load, loadMeeting, loadListing]);
  // Uploaded photos use temporary previews until NIHO returns its signed display URLs.
  // Revoke only URLs created here; API URLs can be shared by other views.
  useEffect(() => {
    mounted.current = true;
    const urls = ownedPhotoUrls.current;
    return () => { mounted.current = false; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); };
  }, []);
  useEffect(() => {
    const visible = new Set(draft?.photos.map((photo) => photo.url) ?? []);
    for (const url of ownedPhotoUrls.current) {
      if (visible.has(url)) continue;
      URL.revokeObjectURL(url);
      ownedPhotoUrls.current.delete(url);
    }
  }, [draft]);
  // 保存しました stays for a moment beside 保存.
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(false), 2500);
    return () => window.clearTimeout(timer);
  }, [flash]);
  const savedJapanese = saved?.language === "JA"; const savedVersion = saved?.updatedAt;
  // Read again whenever the saved page changes: what NIHO made follows the saved Japanese, not the draft.
  useEffect(() => {
    if (!savedJapanese) return;
    queueMicrotask(() => void loadEnglish());
  }, [savedJapanese, savedVersion, loadEnglish]);
  const pageDirty = useMemo(() => saved !== null && draft !== null && Object.keys(serializeLivePagePatch(draft, saved)).length > 0, [saved, draft]);
  const meetingDirty = savedMeeting !== null && meeting !== null && liveMeetingChanged(meeting, savedMeeting);
  const dirty = pageDirty || meetingDirty;
  const mergePreview = useMemo(() => saved && draft && latest ? mergeLivePage(saved, draft, latest) : null, [saved, draft, latest]);
  const meetingMerge = useMemo(() => savedMeeting && meeting && latestMeeting ? mergeLiveMeeting(savedMeeting, meeting, latestMeeting) : null, [savedMeeting, meeting, latestMeeting]);
  const conflicts = mergePreview ? [...mergePreview.conflicts, ...(meetingMerge?.conflict ? [meetingMerge.conflict] : [])] : [];
  const leaveMode: HostLeaveMode = busy || listingBusy ? "saving" : uncertain || listingUncertain ? "unknown" : dirty || latest ? "dirty" : null;
  const leaveGuard = useHostLeaveGuard(leaveMode);
  // Design: nothing is applied, withdrawn or stopped while the page has changes not yet saved.
  const listingLocked = dirty || Boolean(latest) || uncertain || busy || listingBusy || listingUncertain;
  const editContent = (patch: Partial<ExperienceProviderPageDetail["content"]>) => setDraft((current) => current ? { ...current, content: { ...current.content, ...patch } } : current);
  const editOffers = (offers: ExperienceProviderPageOffer[]) => setDraft((current) => current ? { ...current, offers, offer: offers[0] ?? null } : current);

  /** 保存: a listed experience leaves the site until NIHO checks it again, so the owner is asked first. */
  function requestSave() {
    if (!draft || !saved || busy || listingBusy || latest || !dirty) return;
    // Only the Japanese tab draws the fields: the check does not depend on the tab being open.
    const changed = serializeLivePagePatch(draft, saved);
    const problem = liveContentProblem(draft.content) ?? (changed.offers ? liveOfferProblem(draft.offers) : null) ?? (meetingDirty && meeting ? liveMeetingProblem(meeting) : null);
    if (problem) { setError(problem); setNotice(""); setTab("ja"); return; }
    if (owner && listing?.listing?.status === "ACTIVE") setConfirming("save");
    else void save();
  }

  async function save() {
    if (!draft || !saved || busy || latest) return; setBusy(true); setSaving(true); setError(""); setNotice(""); setStale(false); setFlash(false);
    let version = saved.updatedAt; let pageSaved = false;
    try {
      if (pageDirty) {
        const patch = serializeLivePagePatch(draft, saved);
        const markUncertain = () => {
          setUncertain(true);
          setUncertainOfferIds(patch.offers ? draft.offers.filter((offer) => offer.id.startsWith("draft:")).map((offer) => offer.id) : []);
          setUncertainOfferResolution({});
        };
        let response: Response;
        try { response = await fetch(endpoint, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ expectedUpdatedAt: saved.updatedAt, patch }) }); }
        catch { markUncertain(); setError(SAVE_UNCERTAIN); return; }
        if (!response.ok) {
          if (response.status >= 500) { markUncertain(); setError(SAVE_UNCERTAIN); return; }
          const code = await responseError(response);
          if (code === "PAGE_OFFER_HAS_BOOKINGS") {
            const offers = restoreSavedLiveOffers(saved.offers, draft.offers);
            setDraft((current) => current ? { ...current, offers, offer: offers[0] ?? null } : current);
            setError("予約履歴がある商品は削除できません。商品を戻しました。代わりに「この商品を受付する」をオフにしてください。");
            return;
          }
          setStale(response.status === 409); setError(message(response.status)); return;
        }
        let value: ExperienceProviderPageDetail;
        try { value = await response.json() as ExperienceProviderPageDetail; }
        catch { markUncertain(); setError("保存は受け付けられた可能性があります。最新の内容を確認してください。"); return; }
        if (value.id !== pageId) { markUncertain(); setError("保存結果を確認できません。最新の内容を確認してください。"); return; }
        setSaved(value); setDraft(copyPage(value)); version = value.updatedAt; pageSaved = true;
      }
      if (meetingDirty && meeting) {
        // The page is kept as saved; the meeting input stays for another try.
        const uncertainText = pageSaved ? "本文は保存しました。集合場所の保存結果を確認できません。再送せず、最新の内容を確認してください。" : SAVE_UNCERTAIN;
        let response: Response;
        try { response = await fetch(`${endpoint}/meeting-point`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(liveMeetingRequest(meeting, version)) }); }
        catch { setUncertain(true); setError(uncertainText); return; }
        if (!response.ok) {
          if (response.status >= 500) { setUncertain(true); setError(uncertainText); return; }
          setStale(response.status === 409);
          setError(response.status === 409 ? (pageSaved ? "本文は保存しました。集合場所は、ほかの人が先に保存したため保存できませんでした。入力は保持しています。最新の内容と照合してください。" : message(409)) : pageSaved ? "本文は保存しました。集合場所は保存できませんでした。入力は保持しています。" : message(response.status));
          return;
        }
        let value: ExperienceProviderPageMeetingPointUpdateResponse | null = null;
        try { value = await response.json() as ExperienceProviderPageMeetingPointUpdateResponse; } catch { value = null; }
        if (!value || typeof value.updatedAt !== "string" || (value.mode !== "INHERIT" && value.mode !== "OVERRIDE")) { setUncertain(true); setError(uncertainText); return; }
        const updatedAt = value.updatedAt;
        // Saving the meeting point moves the page's version on.
        setSaved((current) => current ? { ...current, updatedAt } : current); setDraft((current) => current ? { ...current, updatedAt } : current);
        const next: LiveMeeting = value.mode === "OVERRIDE" ? { mode: "OVERRIDE", fields: value.meetingPoint } : { mode: "INHERIT", fields: meeting.fields };
        setSavedMeeting(next); setMeeting(structuredClone(next));
        await loadMeeting();
      }
      setUncertain(false); setFlash(true);
      void loadListing();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存できませんでした。入力は保持しています。"); }
    finally { setBusy(false); setSaving(false); }
  }

  async function reconcile() {
    setBusy(true); setError(""); setStale(false);
    try {
      const [, meetingRead] = await Promise.all([load(false), meetingState === "ready" ? loadMeeting(false) : true]);
      // The page alone is not enough: a check without the meeting point would let 保存 overwrite another editor's one.
      if (!meetingRead) { setLatest(null); setStale(true); setError("集合場所の最新の保存内容を読めませんでした。もう一度「最新の保存内容を読む」を押してください。"); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : loadMessage(500)); } finally { setBusy(false); }
  }
  function canResolveUncertainOfferCreates() {
    if (!uncertainOfferIds.length) return true;
    if (!latest || !saved) return false;
    const selected = new Set<string>();
    return uncertainOfferIds.every((localId) => {
      const resolution = uncertainOfferResolution[localId];
      if (resolution === "retry") return true;
      if (!resolution || saved.offers.some((offer) => offer.id === resolution) || !latest.offers.some((offer) => offer.id === resolution && !saved.offers.some((base) => base.id === offer.id))) return false;
      if (selected.has(resolution)) return false;
      selected.add(resolution);
      return true;
    });
  }
  function applyMerge(choice: "local" | "remote") {
    if (!latest || !saved || !draft) return;
    if (meetingState === "ready" && savedMeeting && meeting && !latestMeeting) return;
    if (!canResolveUncertainOfferCreates()) return;
    const draftForMerge = copyPage(draft);
    for (const localId of uncertainOfferIds) {
      const resolution = uncertainOfferResolution[localId];
      if (!resolution || resolution === "retry") continue;
      const remote = latest.offers.find((offer) => offer.id === resolution);
      const localIndex = draftForMerge.offers.findIndex((offer) => offer.id === localId);
      if (!remote || localIndex < 0) return;
      // The owner explicitly matched this uncertain local create to an API-issued product ID.
      draftForMerge.offers[localIndex] = structuredClone(remote);
    }
    draftForMerge.offer = draftForMerge.offers[0] ?? null;
    const merged = mergeLivePage(saved, draftForMerge, latest, choice);
    const meetingMerged = savedMeeting && meeting && latestMeeting ? mergeLiveMeeting(savedMeeting, meeting, latestMeeting, choice) : null;
    setSaved(latest); setDraft(merged.draft); setLatest(null);
    if (meetingMerged && latestMeeting) { setSavedMeeting(latestMeeting); setMeeting(meetingMerged.draft); setLatestMeeting(null); }
    setUncertain(false); setUncertainOfferIds([]); setUncertainOfferResolution({}); setStale(false); setError("");
    setNotice(merged.conflicts.length || meetingMerged?.conflict ? (choice === "local" ? "競合した項目は自分の入力を残しました。保存前に確認してください。" : "競合した項目は最新の内容を残しました。") : "両方の変更を統合しました。保存前に確認してください。");
  }

  async function publish() {
    if (!saved || dirty || latest || busy) return; setBusy(true); setError(""); setNotice(""); setStale(false);
    try {
      let response: Response;
      try { response = await fetch(`${endpoint}/publish`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ expectedUpdatedAt: saved.updatedAt }) }); }
      catch { setUncertain(true); setError("公開結果を確認できません。再送せず、最新の内容を確認してください。"); return; }
      if (!response.ok) {
        if (response.status >= 500) { setUncertain(true); setError("公開結果を確認できません。再送せず、最新の内容を確認してください。"); return; }
        setStale(response.status === 409); setError(message(response.status)); return;
      }
      let value: ExperienceProviderPageDetail;
      try { value = await response.json() as ExperienceProviderPageDetail; }
      catch { setUncertain(true); setError("公開は受け付けられた可能性があります。最新の内容を確認してください。"); return; }
      if (value.id !== pageId) { setUncertain(true); setError("公開結果を確認できません。最新の内容を確認してください。"); return; }
      setSaved(value); setDraft(copyPage(value)); setUncertain(false); setNotice("公開しました。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "公開できませんでした。"); } finally { setBusy(false); }
  }

  /** 最新の状態を確認: the listing, and the page unless it has changes (申請 may have published it). */
  async function refreshListing() {
    await Promise.all([loadListing(), pageDirty ? null : load().catch(() => null)]);
  }
  async function refuseListing(step: "request" | "withdraw", status: number, reason: string | null) {
    const refusal = listingRefusal(step, status, reason);
    if (refusal.kind === "uncertain") setListingUncertain(true);
    setListingMessage({ tone: refusal.tone, text: refusal.text });
    if (refusal.kind === "reload") await refreshListing();
  }
  async function checkListing() {
    setListingBusy(true); setListingMessage(null);
    try { await refreshListing(); setListingUncertain(false); } finally { setListingBusy(false); }
  }

  /** 同意して掲載を申請 (OWNER): publish the saved page first when it is not, then the consent version NIHO showed. */
  async function requestListing() {
    if (!saved || !listing || listingLocked) return; setListingBusy(true); setListingMessage(null); setError(""); setNotice("");
    const resubmittingPausedListing = listing.listing?.status === "PAUSED";
    try {
      if (saved.status !== "PUBLISHED") {
        const published = await listingCall(`${endpoint}/publish`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ expectedUpdatedAt: saved.updatedAt }) });
        if (!published.ok) { await refuseListing("request", published.status, published.error); return; }
        const page = published.value as ExperienceProviderPageDetail | null;
        if (page?.id !== pageId) { setListingUncertain(true); setListingMessage({ tone: "error", text: LISTING_TEXT.requestUncertain }); return; }
        setSaved(page); setDraft(copyPage(page));
      }
      const requested = await listingCall(`${endpoint}/listing`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ consentVersion: listing.consent.version }) });
      if (!requested.ok) { await refuseListing("request", requested.status, requested.error); return; }
      const value = readListingResponse(requested.value);
      if (!value) { setListingUncertain(true); setListingMessage({ tone: "error", text: LISTING_TEXT.requestUncertain }); return; }
      setListing(value); setListingState("ready"); setListingMessage({ tone: "notice", text: resubmittingPausedListing ? LISTING_TEXT.pausedResubmitted : LISTING_TEXT.requested });
    } finally { setListingBusy(false); }
  }

  /** 申請を取り下げる / 掲載を止める (OWNER), after the dialog: NIHO withdraws the listing; bookings stay. */
  async function withdrawListing(stop: boolean) {
    if (!listing?.listing || listingLocked) return; setListingBusy(true); setListingMessage(null); setError(""); setNotice("");
    try {
      const result = await listingCall(`${endpoint}/listing`, { method: "DELETE" });
      if (!result.ok) { await refuseListing("withdraw", result.status, result.error); return; }
      const value = readListingResponse(result.value);
      if (!value) { setListingUncertain(true); setListingMessage({ tone: "error", text: LISTING_TEXT.withdrawUncertain }); return; }
      setListing(value); setListingMessage({ tone: "notice", text: stop ? LISTING_TEXT.stopped : LISTING_TEXT.withdrawn });
    } finally { setListingBusy(false); }
  }

  async function upload(file: File) {
    if (!draft || busy) return;
    if (draft.photos.length >= LIVE_PHOTO_LIMIT) { setError(`写真は ${LIVE_PHOTO_LIMIT} 枚までです。追加するには、どれかを外してください。`); return; }
    if (!PHOTO_CONTENT_TYPES.includes(file.type as typeof PHOTO_CONTENT_TYPES[number]) || file.size > PHOTO_MAX_BYTES) { setError("JPEG、PNG、WebPの10MB以下の写真を選んでください。"); return; }
    setBusy(true); setError("");
    try {
      const policyResponse = await fetch(`/host/api/provider-pages/${encodeURIComponent(providerId)}/upload-policy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose: "ARTICLE_IMAGE", contentType: file.type, contentLength: file.size }) });
      if (!policyResponse.ok) throw new Error("写真のアップロード先を取得できませんでした。入力は保持しています。");
      const policy = await policyResponse.json() as ExperienceProviderPhotoUploadForm; const form = new FormData();
      for (const [key, value] of Object.entries(policy.fields)) form.append(key, value); form.append(PHOTO_FILE_FIELD, file);
      const uploaded = await fetch(policy.url, { method: "POST", body: form, referrerPolicy: "no-referrer" }); if (!uploaded.ok) throw new Error("写真をアップロードできませんでした。入力は保持しています。");
      if (!mounted.current) return;
      const previewUrl = URL.createObjectURL(file);
      ownedPhotoUrls.current.add(previewUrl);
      setDraft((current) => current ? appendPhoto(current, { objectKey: policy.objectKey, url: previewUrl }, file.name.replace(/\.[^.]+$/, "")) : current);
      setNotice("写真をアップロードしました。並びと説明を確認して「保存」を押してください。");
    } catch { setError("写真をアップロードできませんでした。入力は保持しています。"); } finally { setBusy(false); }
  }

  /** 読み込み直す: the first read of the page failed (the editor has nothing to show yet). */
  const retryLoad = () => { setError(""); void load().catch((reason) => setError(reason instanceof Error ? reason.message : loadMessage(500))); };
  if (!draft || !saved) return <><HostSubHeader backHref={backHref} backLabel="体験" title="体験の編集" /><HostPageBody><p role={error ? "alert" : undefined} className="rounded-xl bg-sand p-5">{error || "読み込み中…"}{error ? <button type="button" onClick={retryLoad} className="ml-2 font-extrabold underline">読み込み直す</button> : null}</p></HostPageBody></>;
  const reviewLine = providerReviewLine(reviewStatus);
  /** 掲載 (OWNER): the state as a pill and what can be done in it, first on the page (the rail comes first on phones). */
  const listingPanel = () => {
    const view = listing ? liveListingView(listing.listing, saved, siteUrl) : null;
    const reviewNote = listing ? hostListingReviewNote(listing.listing) : null;
    const resubmitting = listing?.listing?.status === "WITHDRAWN" || listing?.listing?.status === "PAUSED";
    const reviewNotePanel = reviewNote ? <div className="rounded-xl bg-sand p-3 [overflow-wrap:anywhere]"><p className="font-bold">NIHOからの確認事項</p><p className="mt-1 whitespace-pre-wrap text-sm">{reviewNote}</p></div> : null;
    const withdraw = <button type="button" disabled={listingLocked} onClick={() => setConfirming("withdraw")} className={consoleButtonClass("secondary", "md", DISABLED)}>申請を取り下げる</button>;
    return <FieldSection title="掲載" status={listingState === "ready" && listing ? liveListingStatus(listing.listing) : null}>
      {listingState === "loading" ? <p className="text-ink-soft">読み込み中…</p> : listingState === "error" || !listing || !view ? <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1"><p>{LISTING_TEXT.unreadable}</p><button type="button" disabled={listingBusy} onClick={() => { setListingState("loading"); void loadListing(); }} className={consoleButtonClass("secondary", "sm", DISABLED)}>読み込み直す</button></div> : <div className="flex flex-col gap-2.5">
        <ListingSteps status={view.kind === "request" ? "draft" : view.kind === "requested" ? "review" : view.kind === "active" ? "live" : "paused"} />
        {reviewNotePanel}
        {view.kind === "request" ? view.block === "language" ? <p>体験サイトに載せられるのは英語の体験ページだけです。</p> : <>
          {view.block === null ? <p className="whitespace-pre-wrap rounded-xl bg-sand p-3 text-sm [overflow-wrap:anywhere]">{listing.consent.text}</p> : null}
          {view.block === null && saved.status !== "PUBLISHED" ? <p className="text-xs text-muted">申請すると、保存済みの内容で体験ページを公開します。</p> : null}
          <div className="flex flex-wrap items-center gap-2"><button type="button" disabled={listingLocked || view.block !== null} aria-describedby={view.block ? "live-listing-why" : undefined} onClick={() => void requestListing()} className={consoleButtonClass("primary", "md", DISABLED)}>{listingBusy ? "申請しています…" : resubmitting ? "同意して再申請" : "同意して掲載を申請"}</button>{view.withdrawable ? withdraw : null}</div>
          {view.block === "blockers" ? <p id="live-listing-why" className="text-xs text-muted">下の「公開前に確認が必要です」の項目を直すと申請できます。</p> : null}
        </> : null}
        {view.kind === "requested" ? <><p>NIHO が確認しています。</p><div>{withdraw}</div></> : null}
        {view.kind === "active" ? <div className="flex flex-wrap items-center gap-2">{view.href ? <a href={view.href} target="_blank" rel="noopener noreferrer" className={consoleButtonClass("secondary")}>体験サイトで見る</a> : null}<button type="button" disabled={listingLocked} onClick={() => setConfirming("stop")} className={consoleButtonClass("secondary", "md", DISABLED)}>掲載を止める</button></div> : null}
        {view.kind === "paused" ? <><p>{reviewNote ? "確認事項を直して保存したあと、同意して再申請してください。審査が終わるまで掲載は停止中です。" : "保存済みの内容を再審査に出せます。審査が終わるまで掲載は停止中です。"}</p><p className="whitespace-pre-wrap rounded-xl bg-sand p-3 text-sm [overflow-wrap:anywhere]">{listing.consent.text}</p><div className="flex flex-wrap items-center gap-2"><button type="button" disabled={listingLocked} onClick={() => void requestListing()} className={consoleButtonClass("primary", "md", DISABLED)}>{listingBusy ? "再申請しています…" : "同意して再申請"}</button>{withdraw}</div></> : null}
      </div>}
      {reviewLine ? <p className="mt-3 border-t border-line pt-3 text-sm">{reviewLine.text}{reviewLine.link ? <> <a href={`${settingsHref}#settings-provider`} className="font-bold text-moss underline underline-offset-4">{reviewLine.link}</a></> : null}</p> : null}
      {dirty || latest ? <p className="mt-2 text-xs text-muted">保存前の変更があるあいだは、申請・取り下げ・停止はできません。</p> : null}
      {listingMessage ? <p role={listingMessage.tone === "error" ? "alert" : "status"} className={`mt-3 rounded-xl p-3 text-sm ${listingMessage.tone === "error" ? "bg-danger-pale text-danger" : "bg-leaf-pale text-moss"}`}>{listingMessage.text}{listingUncertain ? <button type="button" disabled={listingBusy} onClick={() => void checkListing()} className="ml-2 font-extrabold underline">最新の状態を確認</button> : null}</p> : null}
    </FieldSection>;
  };
  // プレビュー shows what NIHO has saved: it waits while a save or a reconcile is under way, and says so when changes are not saved yet.
  const previewBlocked = busy || listingBusy || Boolean(latest) || uncertain || listingUncertain;
  const previewButton = (size: "sm" | "md") => <button type="button" disabled={previewBlocked} onClick={() => setPreviewing(true)} aria-haspopup="dialog" className={consoleButtonClass("secondary", size, DISABLED)}>プレビュー</button>;
  const fieldsLocked = busy || listingBusy || Boolean(latest) || uncertain || listingUncertain;
  const writtenJapanese = draft.language === "JA";
  const lang = writtenJapanese ? "ja" : "en";
  const activeTab: EditorTab = writtenJapanese ? tab : "ja";
  const savedAsEnglish = saved.language !== "JA";
  const englishStatus = english.kind === "ready" && !savedAsEnglish ? liveEnglishState(english.english).status : null;
  const listingView = owner && listing ? liveListingView(listing.listing, saved, siteUrl) : null;
  const uncertainOfferCandidates = latest ? latest.offers.filter((offer) => !saved.offers.some((base) => base.id === offer.id)) : [];
  const title = draft.title.trim() || "体験の編集";
  const setLanguage = (language: ExperienceProviderPageDetail["language"]) => { setDraft((current) => current ? { ...current, language } : current); if (language !== "JA") setTab("ja"); };
  /** 集合場所: the page's own meeting point (NIHO keeps it apart from the page) and, from the page's photos, the 外観写真. */
  const meetingPanel = <EditorPanel id="editor-meeting" title="集合場所">
    {meetingState === "loading" ? <p className="text-ink-soft">読み込み中…</p> : meetingState === "error" || !meeting ? <p>集合場所を読めませんでした。</p> : <>
      <fieldset className="flex flex-col gap-1.5 pb-3"><legend className="sr-only">集合場所の決め方</legend>{([["INHERIT", "提供者の既定を使う"], ["OVERRIDE", "この体験だけ別の場所にする"]] as const).map(([mode, label]) => <label key={mode} className="inline-flex min-h-8 items-center gap-2.5 font-bold"><input type="radio" name="live-meeting-mode" value={mode} checked={meeting.mode === mode} onChange={() => setMeeting({ ...meeting, mode })} className="size-4 shrink-0 accent-moss" />{label}</label>)}</fieldset>
      {meeting.mode === "INHERIT" ? <>{meetingDefaults ? <MeetingPointSummary value={meetingDefaults} /> : <p className="text-ink-soft">保存すると、提供者の既定の集合案内を使います。</p>}<p className="border-t border-line pt-3 text-xs text-muted">既定は <a href={`${settingsHref}#settings-meeting`} className="font-bold text-moss underline underline-offset-4">設定 › 既定の集合案内</a> で直せます。</p></> : <MeetingPointFields idPrefix="live-meeting" value={meeting.fields} onChange={(fields) => setMeeting({ ...meeting, fields })} />}
    </>}
    <LiveExteriorPhoto photos={draft.photos} value={draft.content.meetingPoint.exteriorPhotoObjectKey} onChange={(exteriorPhotoObjectKey) => editContent({ meetingPoint: { ...draft.content.meetingPoint, exteriorPhotoObjectKey } })} />
  </EditorPanel>;
  return <div ref={root}><HostSubHeader backHref={backHref} backLabel="体験" title={title} action={previewButton("sm")} /><HostPageBody>
    <h1 className="sr-only">{title}</h1>
    {/* PC: ‹, the title and プレビュー in one row. Phones: the title on its own; ‹ and プレビュー are in the header above. */}
    <div className="mb-3 flex items-center gap-3 md:mb-[18px]">
      <Link href={backHref} aria-label="体験へ戻る" className="grid size-10 shrink-0 place-items-center rounded-full bg-sand hover:bg-line max-md:hidden"><HostIcon name="chevronLeft" className="size-[18px]" /></Link>
      <input aria-label="題名" required maxLength={95} placeholder="題名" disabled={fieldsLocked} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} className="-ml-2 min-w-0 flex-1 rounded-[10px] border border-transparent bg-transparent px-2 py-1 text-[1.0625rem] leading-[1.3] font-extrabold text-ink placeholder:text-muted hover:bg-sand focus:border-line-strong focus:bg-canvas disabled:opacity-70 md:ml-0 md:px-2.5 md:py-1.5 md:text-[1.375rem]" />
      <div className="shrink-0 max-md:hidden">{previewButton("md")}</div>
    </div>
    {dirty ? <p className="mb-3 text-[0.8125rem] text-ink-soft">プレビューには保存した内容が出ます。保存すると反映されます。</p> : null}
    {error ? <div role="alert" className="mb-3 rounded-xl bg-danger-pale p-4 text-danger">{error}{stale || uncertain ? <button type="button" disabled={busy} onClick={() => void reconcile()} className="ml-2 font-extrabold underline">最新の保存内容を読む</button> : null}</div> : null}
    {notice ? <p role="status" className="mb-3 rounded-xl bg-leaf-pale p-4 text-moss">{notice}</p> : null}
    {latest && mergePreview ? <>
      {uncertainOfferIds.length ? <section className="mb-3 rounded-xl border border-warn bg-warn-pale p-4" aria-labelledby="uncertain-offers-title">
        <h2 id="uncertain-offers-title" className="font-extrabold">新規商品の保存結果を確認</h2>
        <p className="mt-1 text-sm">保存応答が失われました。最新の内容にある同じ商品を選ぶと、サーバーが発行したIDへ結び付けます。見当たらないことを確認した場合だけ「再送する」を選んでください。</p>
        <div className="mt-3 grid gap-3">{uncertainOfferIds.map((id) => {
          const pending = draft.offers.find((offer) => offer.id === id);
          const selected = uncertainOfferResolution[id] ?? "";
          return <label key={id} className="grid gap-1 text-sm font-bold">{`保存結果が不明な商品: ${pending?.name || "商品名未設定"}（¥${(pending?.priceYen ?? 0).toLocaleString("ja-JP")}）`}
            <select aria-label={`${pending?.name || "新規商品"}の保存結果`} value={selected} onChange={(event) => setUncertainOfferResolution((current) => ({ ...current, [id]: event.target.value }))} className="min-h-10 w-full rounded-lg border border-line bg-canvas px-3 py-2">
              <option value="">最新の内容を確認して選択</option>
              {uncertainOfferCandidates.map((candidate) => <option key={candidate.id} value={candidate.id} disabled={Object.entries(uncertainOfferResolution).some(([otherId, value]) => otherId !== id && value === candidate.id)}>{candidate.name || "商品名未設定"}（¥{candidate.priceYen.toLocaleString("ja-JP")}）</option>)}
              <option value="retry">最新に見当たらないことを確認し、再送する</option>
            </select>
          </label>;
        })}</div>
      </section> : null}
      <section className="mb-3 rounded-xl border border-warn bg-warn-pale p-4"><h2 className="font-extrabold">最新の保存内容と照合</h2><p className="mt-1 text-sm">自分の入力と、ほかの人が保存した内容を項目ごとに比較しました。</p>{conflicts.length ? <><p className="mt-2 text-sm font-extrabold">同じ項目が変更されています</p><ul className="mt-1 list-disc pl-5 text-sm">{conflicts.map((item) => <li key={item.path} className="mb-3"><strong>{item.label}</strong><dl className="mt-1 grid gap-1"><div><dt className="font-bold">自分の入力</dt><dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{conflictValueText(item.local)}</dd></div><div><dt className="font-bold">最新の内容</dt><dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{conflictValueText(item.remote)}</dd></div></dl></li>)}</ul><div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={!canResolveUncertainOfferCreates()} className={consoleButtonClass("primary", "sm", DISABLED)} onClick={() => applyMerge("local")}>競合項目は自分の入力を残す</button><button type="button" disabled={!canResolveUncertainOfferCreates()} className={consoleButtonClass("secondary", "sm", DISABLED)} onClick={() => applyMerge("remote")}>競合項目は最新を残す</button></div></> : <button type="button" disabled={!canResolveUncertainOfferCreates()} className={`${consoleButtonClass("primary", "sm", DISABLED)} mt-3`} onClick={() => applyMerge("local")}>両方の変更を統合する</button>}</section>
    </> : null}
    {writtenJapanese ? <EditorLanguageTabs tab={activeTab} onTab={setTab} englishPill={englishStatus && englishStatus !== "complete" ? LIVE_ENGLISH_STATUS[englishStatus] : null} englishLabel={LIVE_ENGLISH_TAB_LABEL} /> : null}
    <div id={writtenJapanese ? EDITOR_TAB_PANEL_ID : undefined} role={writtenJapanese ? "tabpanel" : undefined} aria-labelledby={writtenJapanese ? editorTabId(activeTab) : undefined} className="@container">
      {writtenJapanese && activeTab === "en" ? <LiveEnglishState load={english} savedAsEnglish={savedAsEnglish} unsaved={dirty} busy={fieldsLocked} onReload={() => void loadEnglish()} /> : null}
      {/* Two columns once the page is wide enough for the 320px rail; one column (rail first) below. */}
      <div className="flex flex-col gap-3.5 @3xl:grid @3xl:grid-cols-[minmax(0,1fr)_320px] @3xl:items-start @3xl:gap-5">
        <fieldset disabled={fieldsLocked} className="m-0 flex min-w-0 flex-col gap-3.5 border-0 p-0 disabled:opacity-70">
          {activeTab === "en" ? (english.kind === "ready" && !savedAsEnglish ? <LiveEnglishPanels english={english.english} /> : null) : <>
            <LivePhotosSection photos={draft.photos} alts={draft.photoAlts} onUpload={(file) => void upload(file)} onAlt={(index, value) => setDraft({ ...draft, photoAlts: draft.photos.map((_, at) => at === index ? value : draft.photoAlts[at] ?? "") })} onMove={(from, to) => setDraft(movePhoto(draft, from, to))} onCover={(index) => setDraft(makeCoverPhoto(draft, index))} onRemove={(index) => setDraft(removePhoto(draft, index))} />
            <LiveContentPanels content={draft.content} photos={draft.photos} lang={lang} onContent={editContent} meeting={meetingPanel} />
        <HostLiveOfferEditor offers={draft.offers} disabled={fieldsLocked} onChange={editOffers} />
          </>}
        </fieldset>
        <div className="order-first flex min-w-0 flex-col gap-3.5 @3xl:sticky @3xl:top-4 @3xl:order-none">
          {owner ? listingPanel() : null}
          <LivePagePanel language={draft.language} onLanguage={setLanguage} publicUrl={listingView?.kind === "active" ? listingView.href : null} disabled={fieldsLocked} />
        </div>
      </div>
    </div>
    {draft.publishBlockers.length ? <div className="mt-4 rounded-xl bg-warn-pale p-3 text-sm"><p className="font-extrabold">公開前に確認が必要です</p><ul className="mt-1 list-disc pl-5">{draft.publishBlockers.map((blocker) => <li key={blocker}>{publishBlockerText(blocker)}</li>)}</ul></div> : null}
    <div className="mt-4 rounded-xl bg-sand p-3 text-sm text-ink-soft"><p>通常の原稿・開催条件はオーナーとサブホストが更新できます。体験サイトへの初回掲載、販売者としての同意と売上受取はオーナーが行います。</p>{owner ? null : <><p className="mt-1">体験サイトへの掲載の申請はオーナーが行います。</p><p className="mt-1">掲載中の体験は、保存すると NIHO が確認するまで体験サイトから外れます。</p></>}</div>
    {/* The owner's way to the experience site is 掲載 at the top: no 公開する beside 保存. */}
    {owner ? null : <div className="mt-4 flex justify-end"><button type="button" disabled={busy || dirty || Boolean(latest) || uncertain || draft.status === "PUBLISHED"} onClick={() => void publish()} className={consoleButtonClass("secondary")}>公開する</button></div>}
    <SaveBar dirty={dirty} saving={saving} saved={flash && !dirty} disabled={busy || listingBusy || Boolean(latest) || uncertain || listingUncertain} onSave={requestSave} />
    {confirming === "save" ? <HostConfirmDialog title="保存すると掲載が止まります" description="体験サイトから一時的に外れ、NIHO が確認すると掲載に戻ります。" focusRef={stay} stayRef={stay} confirm={<button type="submit" className={consoleButtonClass("primary")}>保存して掲載を止める</button>} onConfirm={() => void save()} onClose={() => setConfirming(null)} /> : null}
    {confirming === "withdraw" ? <HostConfirmDialog title="申請を取り下げますか？" description="体験サイトへの掲載の申請を取り下げます。もう一度載せるには、申請と NIHO の確認が必要です。" focusRef={stay} stayRef={stay} confirm={<button type="submit" className={consoleButtonClass("primary")}>申請を取り下げる</button>} onConfirm={() => void withdrawListing(false)} onClose={() => setConfirming(null)} /> : null}
    {confirming === "stop" ? <HostConfirmDialog title="掲載を止めますか？" description="体験サイトからすぐに外れます。受け付けた予約は残ります。もう一度載せるには申請と NIHO の確認が必要です。" focusRef={stay} stayRef={stay} confirm={<button type="submit" className={consoleButtonClass("primary")}>掲載を止める</button>} onConfirm={() => void withdrawListing(true)} onClose={() => setConfirming(null)} /> : null}
    {previewing ? <HostExperiencePreview endpoint={endpoint} unsaved={dirty} onClose={() => setPreviewing(false)} /> : null}
    {leaveGuard.asking && leaveMode ? <HostLeaveDialog mode={leaveMode} requestKey={leaveGuard.requestKey} onStay={leaveGuard.stay} onLeave={leaveGuard.leave} onDiscard={() => { setUncertain(false); setUncertainOfferIds([]); setUncertainOfferResolution({}); setListingUncertain(false); }} /> : null}
  </HostPageBody></div>;
}
