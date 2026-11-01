"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import type { EditorTab, PageEnglishState } from "@/host/page-english";
import { PAGE_ENGLISH_STATUS, type StatusLabel } from "@/host/status";
import { DISABLED } from "./editor-parts";
import { HostConfirmDialog } from "./HostConfirmDialog";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { StatusPill } from "./ui";

/*
 * 日本語で書いて英語の下書きを確かめる (#110, the journey mock's H5): the tabs of a page written in
 * Japanese (日本語で書く / 英語（公開）), the English's state with what can be done with it, and the
 * mark beside an English field whose Japanese changed. The rules are page-english.ts's.
 */

/** Beside an English field whose Japanese changed since the English was made or confirmed. */
export function ChangedMark() {
  return <StatusPill status={{ label: "日本語を変えました", tone: "wait" }} />;
}

const TABS: { value: EditorTab; label: string }[] = [
  { value: "ja", label: "日本語で書く" },
  { value: "en", label: "英語（公開）" },
];
/** NIHO 接続版: the English is NIHO's own, read only (live-english.ts). */
export const LIVE_ENGLISH_TAB_LABEL = "英語（自動訳）";

export const editorTabId = (tab: EditorTab) => `editor-tab-${tab}`;
export const EDITOR_TAB_PANEL_ID = "editor-tab-panel";

/**
 * 日本語で書く / 英語（公開）(mock H5 `.lang-tabs`): underlined tabs. The English tab says its state
 * (`englishPill`) while there is one to say, so it shows from the Japanese tab too. Arrow keys move
 * between the tabs (and open them), Home and End go to either end. `englishLabel` renames the English tab.
 */
export function EditorLanguageTabs({ tab, onTab, englishPill, englishLabel }: { tab: EditorTab; onTab: (tab: EditorTab) => void; englishPill: StatusLabel | null; englishLabel?: string }) {
  const buttons = useRef<Partial<Record<EditorTab, HTMLButtonElement | null>>>({});
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = TABS.length - 1;
    const to = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[event.key];
    const next = to === undefined ? undefined : TABS[to];
    if (!next) return;
    event.preventDefault();
    onTab(next.value);
    buttons.current[next.value]?.focus();
  };
  return (
    <div role="tablist" aria-label="原稿の言語" className="mb-3.5 flex flex-wrap gap-x-5 border-b border-line md:mb-[18px]">
      {TABS.map((item, index) => {
        const selected = tab === item.value;
        return (
          <button
            key={item.value}
            ref={(element) => {
              buttons.current[item.value] = element;
            }}
            id={editorTabId(item.value)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={EDITOR_TAB_PANEL_ID}
            tabIndex={selected ? 0 : -1}
            onClick={() => onTab(item.value)}
            onKeyDown={(event) => move(event, index)}
            className={`-mb-px inline-flex h-[42px] shrink-0 items-center gap-1.5 border-b-2 px-1 text-[0.875rem] font-extrabold whitespace-nowrap ${selected ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {item.value === "en" && englishLabel ? englishLabel : item.label}
            {item.value === "en" && englishPill ? <StatusPill status={englishPill} /> : null}
          </button>
        );
      })}
    </div>
  );
}

const SAYS: Record<PageEnglishState["status"], string> = {
  none: "英語はまだありません。日本語の原稿から NIHO が英語の下書きを作ります。",
  draft: "英語を確かめて、必要なら直してから確定してください。確定するまで審査と公開には使われません。",
  confirmed: "確定した英語です。審査と公開にはこの英語が使われます。英語を直すと下書きに戻ります。",
  stale: "日本語を変えました。英語を作り直すか、英語を直してから確定してください",
};

export interface EnglishStatePanelProps {
  english: PageEnglishState;
  /** NIHO is drafting the English. */
  drafting: boolean;
  /** Why the last draft failed; empty when it did not. */
  error: string;
  /** The Japanese has something to draft from. */
  canDraft: boolean;
  /** The corrected English fields a new draft would replace (asked about first). */
  replaceCount: number;
  /** 英語の下書きを作る / 作り直す: true once the draft is in the page. */
  onDraft: () => Promise<boolean>;
  onConfirm: () => void;
}

const HEADING_ID = "editor-english-state";

/**
 * Over 英語（公開）: the English's state (ピル＋1 文) and its buttons. 未作成 has 英語の下書きを作る;
 * a draft has 英語を作り直す and 英語を確定; stale English has both, 作り直す first; confirmed English
 * has none (correcting it makes a draft again). A draft that would replace English the host
 * corrected asks first. The button pressed goes with the state it belonged to: focus moves to the
 * heading and the result is said.
 */
export function EnglishStatePanel({ english, drafting, error, canDraft, replaceCount, onDraft, onConfirm }: EnglishStatePanelProps) {
  const [said, setSaid] = useState("");
  const [asking, setAsking] = useState(false);
  const stay = useRef<HTMLButtonElement>(null);
  const status = english.status;
  const focusHeading = () => document.getElementById(HEADING_ID)?.focus();

  const draft = async () => {
    setSaid("");
    if (await onDraft()) {
      setSaid("英語の下書きを作りました");
      focusHeading();
    }
  };
  const askThenDraft = () => (replaceCount > 0 ? setAsking(true) : void draft());
  const confirm = () => {
    onConfirm();
    setSaid("英語を確定しました");
    focusHeading();
  };

  const made = status !== "none";
  const draftButton = (primary: boolean) => (
    <button type="button" onClick={askThenDraft} disabled={drafting || !canDraft} className={consoleButtonClass(primary ? "primary" : "secondary", "sm", DISABLED)}>
      {drafting ? "英語の下書きを作っています…" : made ? "英語を作り直す" : "英語の下書きを作る"}
    </button>
  );
  const confirmButton = (primary: boolean) => (
    <button type="button" onClick={confirm} disabled={drafting} className={consoleButtonClass(primary ? "primary" : "secondary", "sm", DISABLED)}>
      英語を確定
    </button>
  );

  return (
    <section aria-labelledby={HEADING_ID} className={`${HOST_SURFACE} mb-3.5 p-4 md:mb-[18px] md:px-5 md:py-[18px]`}>
      <div className="mb-2 flex min-h-[30px] flex-wrap items-center justify-between gap-2.5">
        <h2 id={HEADING_ID} tabIndex={-1} className="font-sans text-[0.78125rem] leading-normal font-bold tracking-normal text-ink-soft focus:outline-none">
          英語の状態
        </h2>
        <StatusPill status={PAGE_ENGLISH_STATUS[status]} />
      </div>
      <p className={status === "stale" ? "text-[0.8125rem] leading-normal font-extrabold text-warn" : "text-[0.8125rem] leading-normal text-ink-soft"}>{SAYS[status]}</p>
      {!canDraft && status === "none" ? <p className="mt-1 text-xs text-muted">日本語の原稿を書くと作れます</p> : null}
      {error ? (
        <p role="alert" className="mt-2 text-[0.78125rem] leading-normal font-extrabold text-danger">
          {error}
        </p>
      ) : null}
      {status === "confirmed" ? null : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {status === "none" ? draftButton(true) : null}
          {status === "draft" ? (
            <>
              {draftButton(false)}
              {confirmButton(true)}
            </>
          ) : null}
          {status === "stale" ? (
            <>
              {draftButton(true)}
              {confirmButton(false)}
            </>
          ) : null}
        </div>
      )}
      <p role="status" className="sr-only">
        {said}
      </p>
      {asking ? (
        <HostConfirmDialog
          title="直した英語を置き換えますか？"
          description={`直した英語 ${replaceCount} か所を作り直した英語で置き換えます。`}
          focusRef={stay}
          stayRef={stay}
          confirm={
            <button type="submit" className={consoleButtonClass("primary")}>
              置き換えて作り直す
            </button>
          }
          onConfirm={() => void draft()}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </section>
  );
}
