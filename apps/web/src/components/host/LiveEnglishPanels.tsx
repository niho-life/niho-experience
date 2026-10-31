"use client";

import type { ReactNode } from "react";
import { EditorPanel, DISABLED, SUB_HEADING } from "./editor-parts";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { LIVE_ENGLISH_STATUS, liveEnglishState, pairsOf, type LiveEnglish, type LiveEnglishField, type LivePair } from "./live-english";
import { StatusPill } from "./ui";

/*
 * 英語（自動訳） (#89 / #110, NIHO 接続版): the English tab of a page written in Japanese. The panels of the mock editor's English
 * tab, but only to read: the English is NIHO's own (live-english.ts), and a host cannot correct or confirm it. An item NIHO has
 * not made (or made from older Japanese) says so and shows its Japanese, so the gap is plain; nothing is filled in by guessing.
 */

export type LiveEnglishLoad = { kind: "loading" } | { kind: "ready"; english: LiveEnglish } | { kind: "missing" } | { kind: "error"; text: string };

const HEADING_ID = "editor-english-state";
const NOT_MADE: Parameters<typeof StatusPill>[0]["status"] = { label: "未作成", tone: "draft" };

function NotMade({ ja }: { ja: string }) {
  return (
    <div>
      <p className="text-[0.8125rem] font-extrabold text-warn">英語はまだありません</p>
      <p lang="ja" className="mt-0.5 text-xs text-muted [overflow-wrap:anywhere]">日本語: {ja}</p>
    </div>
  );
}

/** NIHO's English where it has one, otherwise the gap with the Japanese; a blank Japanese has nothing to translate. */
function EnglishText({ pair }: { pair: LivePair }) {
  if (pair.en?.trim()) return <p lang="en" className="whitespace-pre-wrap text-[0.875rem] leading-relaxed [overflow-wrap:anywhere]">{pair.en}</p>;
  if (pair.ja.trim()) return <NotMade ja={pair.ja} />;
  return <p className="text-[0.8125rem] text-muted">日本語がまだありません</p>;
}

function EnglishList({ items }: { items: readonly LivePair[] }) {
  if (!items.length) return <p className="text-[0.8125rem] text-muted">日本語がまだありません</p>;
  return (
    <ul className="flex flex-col gap-2">
      {items.map((pair, index) => <li key={index} className="rounded-[10px] bg-sand px-3 py-2"><EnglishText pair={pair} /></li>)}
    </ul>
  );
}

/** 未作成 beside a panel whose Japanese has an item NIHO has not put into English. */
function Panel({ id, title, english, field, children }: { id: string; title: string; english: LiveEnglish; field: LiveEnglishField; children: ReactNode }) {
  const missing = pairsOf(english, field).some((pair) => pair.ja.trim() !== "" && !pair.en?.trim());
  return <EditorPanel id={id} title={title} marker={missing ? <StatusPill status={NOT_MADE} /> : null}>{children}</EditorPanel>;
}

/** The English tab's panels, in the public order of the Japanese tab. Photos, 集合場所 and the offers are not translated, so they are not here. */
export function LiveEnglishPanels({ english }: { english: LiveEnglish }) {
  return (
    <>
      <Panel id="editor-english-title" title="英語の題名" english={english} field="title"><EnglishText pair={english.title} /></Panel>
      <Panel id="editor-english-lead" title="ひとこと紹介" english={english} field="lead"><EnglishText pair={english.lead} /></Panel>
      <Panel id="editor-english-day-language" title="当日の言語" english={english} field="dayLanguage"><EnglishText pair={english.dayLanguage} /></Panel>
      <Panel id="editor-english-highlights" title="見どころ" english={english} field="highlights"><EnglishList items={english.highlights} /></Panel>
      <Panel id="editor-english-description" title="詳しい説明" english={english} field="description"><EnglishText pair={english.description} /></Panel>
      <EditorPanel id="editor-english-included" title="含まれるもの・含まれないもの" marker={(["included", "notIncluded"] as const).some((field) => pairsOf(english, field).some((pair) => pair.ja.trim() !== "" && !pair.en?.trim())) ? <StatusPill status={NOT_MADE} /> : null}>
        <div className="@container">
          <div className="grid gap-4 @lg:grid-cols-2 @lg:gap-5">
            <div className="min-w-0"><h3 className={SUB_HEADING}>含まれるもの</h3><EnglishList items={english.included} /></div>
            <div className="min-w-0"><h3 className={SUB_HEADING}>含まれないもの</h3><EnglishList items={english.notIncluded} /></div>
          </div>
        </div>
      </EditorPanel>
      <Panel id="editor-english-not-suitable" title="向かない人" english={english} field="notSuitableFor"><EnglishList items={english.notSuitableFor} /></Panel>
      <Panel id="editor-english-timeline" title="当日の流れ" english={english} field="timeline">
        {english.timeline.length ? (
          <ol>
            {english.timeline.map((step, index) => (
              <li key={index} className="flex items-start gap-3 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
                <span className="w-[72px] shrink-0 pt-0.5 text-[0.875rem] font-extrabold tabular-nums md:w-[84px]">{step.time || "—"}</span>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <EnglishText pair={step.title} />
                  {step.text.ja.trim() || step.text.en ? <EnglishText pair={step.text} /> : null}
                </div>
              </li>
            ))}
          </ol>
        ) : <p className="text-[0.8125rem] text-muted">日本語がまだありません</p>}
      </Panel>
      <Panel id="editor-english-know" title="注意事項" english={english} field="knowBeforeYouGo"><EnglishList items={english.knowBeforeYouGo} /></Panel>
    </>
  );
}

export interface LiveEnglishStateProps {
  load: LiveEnglishLoad;
  /** The page as NIHO has it saved is written in English: it has no English to read. */
  savedAsEnglish: boolean;
  /** Changes to the Japanese not saved yet (the English follows what is saved). */
  unsaved: boolean;
  busy: boolean;
  onReload: () => void;
}

/** Over 英語（自動訳）: the English's state (ピル＋1 文), what a host can and cannot do with it, and 読み直す. */
export function LiveEnglishState({ load, savedAsEnglish, unsaved, busy, onReload }: LiveEnglishStateProps) {
  const state = load.kind === "ready" && !savedAsEnglish ? liveEnglishState(load.english) : null;
  let says: string;
  if (savedAsEnglish) says = "保存してあるページは英語で書かれているので、自動訳はありません。日本語で書く形に切り替えて保存すると、NIHO が英語を作り、できしだいここに出ます。";
  else if (load.kind === "loading") says = "読み込み中…";
  else if (load.kind === "missing") says = "英語を読めませんでした。有効な商品を 1 つ以上保存すると、保存した内容から読めます。";
  else if (load.kind === "error") says = load.text;
  else if (state?.status === "complete") says = "NIHO の自動訳です。今の日本語から作られた英語だけを出しています。";
  else if (state?.status === "partial") says = "英語がまだない項目があります。日本語を直した項目は、NIHO が作り直すまで空になります。";
  else says = "英語はまだありません。NIHO が日本語から作ると、ここに出ます。";
  const failed = load.kind === "error" || load.kind === "missing";
  return (
    <section aria-labelledby={HEADING_ID} aria-busy={load.kind === "loading" || undefined} className={`${HOST_SURFACE} mb-3.5 p-4 md:mb-[18px] md:px-5 md:py-[18px]`}>
      <div className="mb-2 flex min-h-[30px] flex-wrap items-center justify-between gap-2.5">
        <h2 id={HEADING_ID} tabIndex={-1} className="font-sans text-[0.78125rem] leading-normal font-bold tracking-normal text-ink-soft focus:outline-none">英語の状態</h2>
        {state ? <StatusPill status={LIVE_ENGLISH_STATUS[state.status]} /> : null}
      </div>
      <p role={failed ? "alert" : undefined} className={failed ? "text-[0.8125rem] leading-normal font-extrabold text-danger" : "text-[0.8125rem] leading-normal text-ink-soft"}>{says}</p>
      <p className="mt-1 text-xs text-muted">英語は NIHO が作ります。この画面では直せません。体験サイトに載せられるのは、英語で書いたページです。集合場所と商品（名前・説明・質問）は、自動訳の対象ではありません。</p>
      {unsaved ? <p className="mt-1 text-xs font-bold text-warn">未保存の変更があります。英語は保存した日本語から作られるので、保存するまで反映されません。</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={onReload} disabled={busy || load.kind === "loading"} className={consoleButtonClass("secondary", "sm", DISABLED)}>英語を読み直す</button>
      </div>
    </section>
  );
}
