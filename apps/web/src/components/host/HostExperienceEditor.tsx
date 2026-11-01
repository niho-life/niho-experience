"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { draftPageEnglish } from "@/host/actions";
import { EDITOR_LIMITS, experienceContent, listingRequirements, pauseListing, sameContent, submitListing, withdrawListing, writtenTitle } from "@/host/editor";
import {
  applyEnglishDraft,
  changeInTab,
  confirmEnglish,
  contentInTab,
  editsToReplace,
  PAGE_ENGLISH_FAILED_TEXT,
  pageEnglishState,
  publicEnglishBehind,
  textHasWords,
  writeInEnglish,
  writeInJapanese,
  type EditorTab,
} from "@/host/page-english";
import { PAGE_ENGLISH_STATUS } from "@/host/status";
import type { HostExperience, HostExperienceContent, HostListing, HostWritingLanguage } from "@/host/types";
import { DISABLED } from "./editor-parts";
import { HostEditorContent } from "./HostEditorContent";
import { ChangedMark, EDITOR_TAB_PANEL_ID, EditorLanguageTabs, editorTabId, EnglishStatePanel } from "./HostEditorEnglish";
import { HostEditorRail } from "./HostEditorRail";
import { HostIcon } from "./HostIcon";
import { HostLeaveDialog, useHostLeaveGuard } from "./HostLeaveGuard";
import { SaveBar } from "./SaveBar";
import { HostSubHeader } from "./HostSubHeader";
import { consoleButtonClass } from "./host-ui";
import { HostPageBody } from "./ui";

const SAVE_DELAY_MS = 500;
const SAVED_NOTICE_MS = 2500;

/** プレビュー: the public page in a new tab once it is on the site (掲載中・審査待ち). A draft has nothing to show yet. */
function PreviewButton({ href, size }: { href: string | null; size: "sm" | "md" }) {
  if (!href) {
    return (
      <button type="button" disabled className={consoleButtonClass("secondary", size, DISABLED)}>
        保存後にプレビュー
      </button>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener" className={consoleButtonClass("secondary", size)}>
      プレビュー<span className="sr-only">（新しいタブで開く）</span>
    </a>
  );
}

export interface HostExperienceEditorProps {
  experience: HostExperience;
  /** The provider the page is NIHO's for (英語の下書きを作る's server action). */
  providerId: string;
  /** 迎える人: the provider's name and introduction (設定 › 提供者情報). */
  host: { name: string; bio: string };
  /** The day 掲載を申請 is dated (YYYY-MM-DD, JST). */
  today: string;
  /** The traveler site's origin (SITE_URL), for the page's public address. */
  siteUrl: string;
  backHref: string;
  settingsHref: string;
}

/**
 * 体験の編集 (#89, mock v2 `screenEditor`). The page text in the public order on the
 * left, 掲載 / 申込の設定 / ページ on the right (first on phones), and one 保存.
 *
 * A page written in Japanese (#110, the journey mock's H5) has two tabs over both columns:
 * 日本語で書く (the default) and 英語（公開）, with the English's state and NIHO's draft on top.
 * The header's title is the title in the language the page is written in.
 *
 * Mock mode only for now: 保存 keeps the page in this screen, photos stay in the browser
 * as object URLs, and 申請・停止・取り下げ change the state shown here. Going back to
 * the list starts again from the synthetic data (the preview note says nothing is kept).
 */
export function HostExperienceEditor({ experience, providerId, host, today, siteUrl, backHref, settingsHref }: HostExperienceEditorProps) {
  const [content, setContent] = useState<HostExperienceContent>(() => experienceContent(experience));
  const [saved, setSaved] = useState<HostExperienceContent>(content);
  const [listing, setListing] = useState<HostListing>(() => ({ status: experience.status, liveSince: experience.liveSince, requestedOn: experience.requestedOn }));
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ at: number } | null>(null);
  const [chosenTab, setTab] = useState<EditorTab>("ja");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const dirty = useMemo(() => !sameContent(content, saved), [content, saved]);
  const requirements = useMemo(() => listingRequirements(content), [content]);
  const english = useMemo(() => pageEnglishState(content), [content]);
  const tab: EditorTab = english ? chosenTab : "en";
  const view = useMemo(() => contentInTab(content, tab), [content, tab]);
  const leaveGuard = useHostLeaveGuard(dirty ? "dirty" : null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), SAVED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const updateIn = useCallback((on: EditorTab, patch: Partial<HostExperienceContent>) => setContent((current) => changeInTab(current, on, patch)), []);
  const update = useCallback((patch: Partial<HostExperienceContent>) => updateIn(tab, patch), [tab, updateIn]);
  /** The header's title is always in the language the page is written in. */
  const updateTitle = (title: string) => updateIn(content.writingLanguage === "ja" ? "ja" : "en", { title });

  /** 英語の下書きを作る / 作り直す: NIHO's English of the Japanese as it is now. While NIHO drafts, the English is locked and the Japanese stays editable; nothing written is lost when it fails. */
  const draftEnglish = async (): Promise<boolean> => {
    const sent = content.japanese;
    if (!sent || drafting) return false;
    setDrafting(true);
    setDraftError("");
    try {
      const result = await draftPageEnglish({ providerId, experienceId: experience.id, japanese: sent });
      if (!result.ok) {
        setDraftError(result.message);
        return false;
      }
      setContent((current) => applyEnglishDraft(current, sent, result.english));
      return true;
    } catch {
      setDraftError(PAGE_ENGLISH_FAILED_TEXT);
      return false;
    } finally {
      setDrafting(false);
    }
  };

  const changeLanguage = (language: HostWritingLanguage) => {
    setDraftError("");
    if (language === "ja") {
      setContent(writeInJapanese);
      setTab("ja");
    } else {
      setContent(writeInEnglish);
    }
  };

  const save = async () => {
    const invalid = root.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input:invalid, textarea:invalid");
    if (invalid) {
      invalid.reportValidity();
      return;
    }
    const kept = content;
    setSaving(true);
    setNotice(null);
    // Mock mode: nothing leaves the browser. TODO(#87): send the page with the
    // x-niho-page-updated-at it was read at; when NIHO answers that it changed since
    // (someone else saved), keep these edits, say so and offer to reload, never overwrite.
    await new Promise((resolve) => window.setTimeout(resolve, SAVE_DELAY_MS));
    setSaved(kept);
    setSaving(false);
    setNotice({ at: Date.now() });
  };

  const title = writtenTitle(content).trim() || content.title.trim() || "無題の体験";
  const changed = english && tab === "en" ? new Set(english.changed) : undefined;
  // English is locked while NIHO drafts it (the Japanese tab stays open to edit).
  const locked = drafting && tab === "en";
  const publicPath = `/experiences/${encodeURIComponent(experience.slug)}`;
  const previewHref = listing.status === "live" || listing.status === "review" ? publicPath : null;

  return (
    <div ref={root}>
      <HostSubHeader backHref={backHref} backLabel="体験" title={title} action={<PreviewButton href={previewHref} size="sm" />} />
      <HostPageBody>
        <h1 className="sr-only">{title}</h1>
        {/* PC: ‹, the title and プレビュー in one row. Phones: the title on its own; ‹ and プレビュー are in the header above. */}
        <div className="mb-3 flex items-center gap-3 md:mb-[18px]">
          <Link href={backHref} aria-label="体験へ戻る" className="grid size-10 shrink-0 place-items-center rounded-full bg-sand hover:bg-line max-md:hidden">
            <HostIcon name="chevronLeft" className="size-[18px]" />
          </Link>
          <input
            aria-label="題名"
            value={writtenTitle(content)}
            maxLength={EDITOR_LIMITS.title}
            placeholder="題名"
            onChange={(event) => updateTitle(event.currentTarget.value)}
            className="-ml-2 min-w-0 flex-1 rounded-[10px] border border-transparent bg-transparent px-2 py-1 text-[1.0625rem] leading-[1.3] font-extrabold text-ink placeholder:text-muted hover:bg-sand focus:border-line-strong focus:bg-canvas md:ml-0 md:px-2.5 md:py-1.5 md:text-[1.375rem]"
          />
          <div className="shrink-0 max-md:hidden">
            <PreviewButton href={previewHref} size="md" />
          </div>
        </div>
        {english ? <EditorLanguageTabs tab={tab} onTab={setTab} englishPill={english.status === "confirmed" ? null : PAGE_ENGLISH_STATUS[english.status]} /> : null}
        {/* The same elements whatever the page is written in, so switching keeps the photos picked in this browser. */}
        <div id={english ? EDITOR_TAB_PANEL_ID : undefined} role={english ? "tabpanel" : undefined} aria-labelledby={english ? editorTabId(tab) : undefined} className="@container">
          {english && tab === "en" ? (
            <EnglishStatePanel
              english={english}
              drafting={drafting}
              error={draftError}
              canDraft={content.japanese !== null && textHasWords(content.japanese)}
              replaceCount={editsToReplace(content).length}
              onDraft={draftEnglish}
              onConfirm={() => {
                setDraftError("");
                setContent(confirmEnglish);
              }}
            />
          ) : null}
          {/* Two columns once the page is wide enough for the 320px rail; one column (rail first) below. */}
          <fieldset disabled={locked} aria-busy={locked || undefined} className={`m-0 min-w-0 border-0 p-0 ${locked ? "opacity-60" : ""}`}>
            <div className="flex flex-col gap-3.5 @3xl:grid @3xl:grid-cols-[minmax(0,1fr)_320px] @3xl:items-start @3xl:gap-5">
              <HostEditorContent content={view} update={update} host={host} settingsHref={settingsHref} lang={tab} englishTitle={english !== null && tab === "en"} changed={changed} />
              <HostEditorRail
                className="order-first @3xl:sticky @3xl:top-4 @3xl:order-none"
                listing={listing}
                requirements={requirements}
                dirty={dirty}
                consent={consent}
                onConsent={setConsent}
                actions={{
                  onSubmit: () => {
                    setListing((current) => submitListing(current, today));
                    setConsent(false);
                  },
                  onPause: () => setListing(pauseListing),
                  onWithdraw: () => setListing(withdrawListing),
                }}
                publicPath={publicPath}
                publicUrl={listing.status === "live" ? `${siteUrl}${publicPath}` : null}
                offers={view.offers}
                onOffers={(offers) => update({ offers })}
                lang={tab}
                offersMarker={changed?.has("offers") ? <ChangedMark /> : null}
                englishBehind={publicEnglishBehind(content, listing.status)}
                language={content.writingLanguage}
                onLanguage={changeLanguage}
                today={today}
              />
            </div>
          </fieldset>
        </div>
        <SaveBar dirty={dirty} saving={saving} saved={notice !== null} onSave={save} />
      </HostPageBody>
      {leaveGuard.asking ? <HostLeaveDialog requestKey={leaveGuard.requestKey} onStay={leaveGuard.stay} onLeave={leaveGuard.leave} /> : null}
    </div>
  );
}
