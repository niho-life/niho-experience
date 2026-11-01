"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { EDITOR_LIMITS, emptyOffer, moveItem, offerChildPriceLabel, offerPriceLabel, offerScheduleLabel } from "@/host/editor";
import { fullDateJa, monthDayJa } from "@/host/format";
import { LISTING_STATUS } from "@/host/status";
import type { HostListing, HostOffer, HostWritingLanguage, ListingStatus } from "@/host/types";
import { DISABLED, EditorPanel } from "./editor-parts";
import { HostConfirmDialog } from "./HostConfirmDialog";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { HostIcon } from "./HostIcon";
import { HostOfferDialog } from "./HostOfferDialog";
import { StatusPill } from "./ui";

const STEPS = ["下書き", "審査", "掲載中"] as const;
type StepState = "done" | "current" | "todo";

const STEP_STATES: Record<ListingStatus, readonly StepState[]> = {
  draft: ["current", "todo", "todo"],
  review: ["done", "current", "todo"],
  live: ["done", "done", "current"],
  // Stopped after being live: the way back is a new application.
  paused: ["done", "done", "todo"],
};

const STEP_TEXT: Record<StepState, string> = { done: "text-ink-soft", current: "text-ink", todo: "text-muted" };
const STEP_DOT: Record<StepState, string> = { done: "bg-moss", current: "bg-leaf shadow-[0_0_0_3px_rgb(178_214_124/0.4)]", todo: "bg-line-strong" };
const STEP_SPOKEN: Record<StepState, string> = { done: "（済み）", current: "（現在）", todo: "" };

/** 下書き → 審査 → 掲載中: done steps have a deep green dot, the current one a leaf dot with a ring. */
export function ListingSteps({ status }: { status: ListingStatus }) {
  const states = STEP_STATES[status];
  return (
    <ol aria-label="掲載までの流れ" className="mb-3 flex flex-wrap items-center gap-y-1">
      {STEPS.map((label, index) => {
        const state = states[index] ?? "todo";
        return (
          <li key={label} className={`flex items-center gap-1.5 text-xs font-extrabold whitespace-nowrap ${STEP_TEXT[state]}`}>
            {index > 0 ? <span aria-hidden="true" className="mx-1.5 h-px w-[18px] bg-line-strong" /> : null}
            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${STEP_DOT[state]}`} />
            {label}
            {STEP_SPOKEN[state] ? <span className="sr-only">{STEP_SPOKEN[state]}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

const LINE = "mb-3 text-[0.78125rem] text-ink-soft";

/** Why a button is off while the page has unsaved changes. */
function SaveFirst({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-2 text-xs text-muted">
      {children}
    </p>
  );
}

export interface ListingActions {
  onSubmit: () => void;
  onPause: () => void;
  onWithdraw: () => void;
}

/**
 * 掲載 (owner decision 2026-10-21, #84): one state per listing and one button to apply.
 * 申請, 停止 and 取り下げ wait until the page is saved, so NIHO reviews what was kept.
 */
function ListingPanel({ listing, requirements, dirty, consent, onConsent, publicPath, englishBehind, actions }: { listing: HostListing; requirements: readonly string[]; dirty: boolean; consent: boolean; onConsent: (agreed: boolean) => void; publicPath: string; englishBehind: boolean; actions: ListingActions }) {
  const baseId = useId();
  const hintId = `${baseId}-hint`;
  const headingId = "editor-listing";
  const [said, setSaid] = useState("");
  const describedBy = dirty ? hintId : undefined;
  // The button pressed goes away with the state it belonged to: keep focus in the panel and say what happened.
  const after = (action: () => void, message: string) => {
    action();
    setSaid(message);
    document.getElementById(headingId)?.focus();
  };

  let body: ReactNode;
  if (listing.status === "live") {
    body = (
      <>
        <p className={LINE}>体験サイトで公開中{listing.liveSince ? ` · ${fullDateJa(listing.liveSince)}から` : ""}</p>
        {/* Saving does not publish English that is not confirmed (#110). */}
        {englishBehind ? <p className={`${LINE} -mt-2`}>公開中の英語は前に確定したままです</p> : null}
        <div className="flex flex-wrap gap-2">
          <a href={publicPath} target="_blank" rel="noopener" className={consoleButtonClass("secondary", "sm")}>
            <HostIcon name="external" className="size-3.5" />
            体験サイトで見る<span className="sr-only">（新しいタブで開く）</span>
          </a>
          <button type="button" disabled={dirty} aria-describedby={describedBy} onClick={() => after(actions.onPause, "掲載を止めました")} className={consoleButtonClass("ghost", "sm", DISABLED)}>
            掲載を止める
          </button>
        </div>
        {dirty ? <SaveFirst id={hintId}>保存後に操作できます</SaveFirst> : null}
      </>
    );
  } else if (listing.status === "review") {
    body = (
      <>
        <p className={LINE}>{[listing.requestedOn ? `${monthDayJa(listing.requestedOn)}に申請` : null, "NIHO が確認中"].filter(Boolean).join(" · ")}</p>
        <button type="button" disabled={dirty} aria-describedby={describedBy} onClick={() => after(actions.onWithdraw, "申請を取り下げました")} className={consoleButtonClass("ghost", "sm", DISABLED)}>
          申請を取り下げる
        </button>
        {dirty ? <SaveFirst id={hintId}>保存後に操作できます</SaveFirst> : null}
      </>
    );
  } else {
    const ready = requirements.length === 0;
    body = (
      <>
        {listing.status === "paused" ? <p className={LINE}>掲載を止めています · 再開には NIHO の確認が必要です</p> : null}
        {ready ? (
          <label className="mb-3 flex items-center gap-2 text-[0.8125rem] font-bold">
            <input type="checkbox" checked={consent} onChange={(event) => onConsent(event.currentTarget.checked)} className="size-5 shrink-0 accent-moss" />
            掲載の条件に同意する
          </label>
        ) : (
          <div className="mb-3">
            <p id={`${baseId}-needs`} className="mb-1.5 text-xs font-extrabold text-ink-soft">
              掲載までに必要
            </p>
            <ul aria-labelledby={`${baseId}-needs`} className="flex flex-wrap gap-1.5">
              {requirements.map((item) => (
                <li key={item} className="inline-flex h-[26px] items-center rounded-full bg-warn-pale px-2.5 text-xs font-extrabold text-warn">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
        <button
          type="button"
          disabled={!ready || !consent || dirty}
          aria-describedby={describedBy}
          onClick={() => after(actions.onSubmit, "掲載を申請しました。NIHO が確認します")}
          className={consoleButtonClass("primary", "sm", DISABLED)}
        >
          掲載を申請
        </button>
        {dirty ? <SaveFirst id={hintId}>保存後に申請できます</SaveFirst> : null}
      </>
    );
  }

  return (
    <section aria-labelledby={headingId} className={`${HOST_SURFACE} p-4 md:px-5 md:py-[18px]`}>
      <div className="mb-2.5 flex min-h-[30px] items-center justify-between gap-2.5">
        <h2 id={headingId} tabIndex={-1} className="font-sans text-[0.78125rem] leading-normal font-bold tracking-normal text-ink-soft focus:outline-none">
          掲載
        </h2>
        <StatusPill status={LISTING_STATUS[listing.status]} />
      </div>
      <ListingSteps status={listing.status} />
      {body}
      <p role="status" className="sr-only">
        {said}
      </p>
    </section>
  );
}

function OfferText({ offer, lang }: { offer: HostOffer; lang: "ja" | "en" }) {
  const child = offerChildPriceLabel(offer);
  return (
    <>
      <span className="min-w-0 flex-1">
        <span lang={offer.name ? lang : undefined} className="block truncate text-[0.84375rem] font-extrabold">
          {offer.name || "名前のない商品"}
        </span>
        <span className="block truncate text-xs text-muted">{offerScheduleLabel(offer)}</span>
      </span>
      <span className="shrink-0 text-right tabular-nums">
        <span className="block text-[0.84375rem] font-extrabold">{offerPriceLabel(offer)}</span>
        {child ? <span className="block text-xs text-muted">{child}</span> : null}
      </span>
    </>
  );
}

const ARROW = "grid size-8 shrink-0 place-items-center rounded-lg bg-sand text-ink hover:bg-line disabled:pointer-events-none disabled:opacity-40";

/** 申込の設定: the offers as rows; a row opens its dialog. 並び替え shows ↑↓ instead. Names and questions are in the tab's language. */
function OffersPanel({ offers, onOffers, today, lang, marker }: { offers: readonly HostOffer[]; onOffers: (offers: HostOffer[]) => void; today: string; lang: "ja" | "en"; marker: ReactNode }) {
  const [editing, setEditing] = useState<{ index: number | null; offer: HostOffer } | null>(null);
  const [reordering, setReordering] = useState(false);
  const added = useRef(0);
  const sorting = reordering && offers.length > 1;
  const full = offers.length >= EDITOR_LIMITS.offers;
  const addOffer = () => {
    added.current += 1;
    setEditing({ index: null, offer: emptyOffer(`offer-new-${added.current}`) });
  };
  const save = (offer: HostOffer) => {
    if (!editing) return;
    onOffers(editing.index === null ? [...offers, offer] : offers.map((other, index) => (index === editing.index ? offer : other)));
  };
  const remove = () => {
    if (editing && editing.index !== null) onOffers(offers.filter((_, index) => index !== editing.index));
  };

  return (
    <EditorPanel
      id="editor-offers"
      title="申込の設定"
      marker={marker}
      actions={
        <>
          {offers.length > 1 ? (
            <button type="button" onClick={() => setReordering(!sorting)} className={consoleButtonClass("ghost", "sm")}>
              {sorting ? "完了" : "並び替え"}
            </button>
          ) : null}
          {sorting ? null : (
            <button type="button" onClick={addOffer} disabled={full} className={consoleButtonClass("secondary", "sm", DISABLED)}>
              <HostIcon name="plus" className="size-3.5" />
              商品を追加
            </button>
          )}
        </>
      }
    >
      {offers.length ? (
        <ul className="-mt-1 -mb-1.5">
          {offers.map((offer, index) => (
            <li key={offer.id} className="border-t border-line first:border-t-0">
              {sorting ? (
                <div className="flex min-h-12 items-center gap-2 py-2">
                  <OfferText offer={offer} lang={lang} />
                  <button type="button" aria-label={`${offer.name || "名前のない商品"}を上へ`} disabled={index === 0} onClick={() => onOffers(moveItem(offers, index, -1))} className={ARROW}>
                    <HostIcon name="chevronUp" className="size-4" />
                  </button>
                  <button type="button" aria-label={`${offer.name || "名前のない商品"}を下へ`} disabled={index === offers.length - 1} onClick={() => onOffers(moveItem(offers, index, 1))} className={ARROW}>
                    <HostIcon name="chevronDown" className="size-4" />
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setEditing({ index, offer })} className="group flex min-h-12 w-full items-center gap-2.5 py-2.5 text-left">
                  <OfferText offer={offer} lang={lang} />
                  <HostIcon name="chevronRight" className="size-4 text-line-strong group-hover:text-muted" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[0.8125rem] text-muted">商品がありません。「商品を追加」から料金と日程を入れます。</p>
      )}
      {full ? <p className="mt-2 text-xs text-muted">商品は{EDITOR_LIMITS.offers}件までです</p> : null}
      {editing ? <HostOfferDialog offer={editing.offer} isNew={editing.index === null} today={today} lang={lang} onSave={save} onDelete={remove} onClose={() => setEditing(null)} /> : null}
    </EditorPanel>
  );
}

const LANGUAGES: { value: HostWritingLanguage; label: string; lang: string }[] = [
  { value: "ja", label: "日本語", lang: "ja" },
  { value: "en", label: "English", lang: "en" },
];

const KV = "grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 border-t border-line py-[9px] text-[0.8125rem] first:border-t-0 first:pt-0.5";
const KV_KEY = "text-xs font-extrabold text-muted";

/**
 * ページ: the language the host writes in (書く言語, #110) and, once it is live, its public address.
 * 日本語 keeps the English as it is as the confirmed English; going back to English asks first
 * (the Japanese stays, and comes back with 日本語).
 */
function PagePanel({ language, onLanguage, publicUrl }: { language: HostWritingLanguage; onLanguage: (language: HostWritingLanguage) => void; publicUrl: string | null }) {
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const [asking, setAsking] = useState(false);
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 2500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  };
  const choose = (next: HostWritingLanguage) => {
    if (next === language) return;
    if (next === "en") setAsking(true);
    else onLanguage(next);
  };
  return (
    <EditorPanel id="editor-page" title="ページ">
      <div>
        <div className={KV}>
          <span id="editor-language-label" className={KV_KEY}>
            書く言語
          </span>
          <span role="radiogroup" aria-labelledby="editor-language-label" className="inline-flex w-fit rounded-full bg-sand p-0.5">
            {LANGUAGES.map((option) => (
              <label
                key={option.value}
                lang={option.lang}
                className="relative block h-8 rounded-full px-3 text-xs leading-8 font-extrabold text-ink-soft has-[:checked]:bg-canvas has-[:checked]:text-ink has-[:checked]:shadow-[0_1px_2px_rgb(0_0_0/0.08)] has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-moss"
              >
                <input type="radio" name="editor-language" value={option.value} checked={language === option.value} onChange={() => choose(option.value)} className="absolute inset-0 z-[1] size-full cursor-pointer appearance-none rounded-full opacity-0 focus-visible:outline-none" />
                {option.label}
              </label>
            ))}
          </span>
        </div>
        {publicUrl ? (
          <div className={KV}>
            <span className={KV_KEY}>URL</span>
            <span className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 text-xs [overflow-wrap:anywhere]">{publicUrl.replace(/^https?:\/\//, "")}</span>
              <button type="button" aria-label="URL をコピー" onClick={copy} className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-sand hover:text-ink">
                <HostIcon name="copy" className="size-3.5" />
              </button>
            </span>
          </div>
        ) : null}
      </div>
      <p className="mt-1 text-xs leading-normal text-muted">{language === "ja" ? "日本語で書くと、英語の下書きを NIHO が作ります。体験サイトには確定した英語が出ます。" : "体験サイトには、書いた英語がそのまま出ます。"}</p>
      <p role="status" className="text-xs font-bold text-moss">
        {copied === "done" ? "URL をコピーしました" : copied === "failed" ? "コピーできませんでした" : ""}
      </p>
      {asking ? (
        <HostConfirmDialog
          title="英語で書く形に戻しますか？"
          description="日本語の原稿は残りますが、英語を直接書く形に戻ります。"
          focusRef={stay}
          stayRef={stay}
          confirm={
            <button type="submit" className={consoleButtonClass("primary")}>
              英語で書く
            </button>
          }
          onConfirm={() => onLanguage("en")}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </EditorPanel>
  );
}

export interface HostEditorRailProps {
  className?: string;
  listing: HostListing;
  requirements: readonly string[];
  dirty: boolean;
  consent: boolean;
  onConsent: (agreed: boolean) => void;
  actions: ListingActions;
  /** The public page on this site (/experiences/{slug}). */
  publicPath: string;
  /** The public page's full address, shown while the listing is live. */
  publicUrl: string | null;
  /** As the tab shows them: names and questions in its language. */
  offers: readonly HostOffer[];
  onOffers: (offers: HostOffer[]) => void;
  /** The words' language (the tab's). */
  lang: "ja" | "en";
  /** 日本語を変えました beside 申込の設定, on 英語（公開）. */
  offersMarker?: ReactNode;
  /** A live page written in Japanese whose English is not confirmed: the public English is the last confirmed one. */
  englishBehind: boolean;
  language: HostWritingLanguage;
  onLanguage: (language: HostWritingLanguage) => void;
  today: string;
}

/** The right rail (mock v2 `.rail`): 掲載, 申込の設定 and ページ. */
export function HostEditorRail({ className = "", listing, requirements, dirty, consent, onConsent, actions, publicPath, publicUrl, offers, onOffers, lang, offersMarker, englishBehind, language, onLanguage, today }: HostEditorRailProps) {
  return (
    <div className={`flex min-w-0 flex-col gap-3.5 ${className}`.trim()}>
      <ListingPanel listing={listing} requirements={requirements} dirty={dirty} consent={consent} onConsent={onConsent} publicPath={publicPath} englishBehind={englishBehind} actions={actions} />
      <OffersPanel offers={offers} onOffers={onOffers} today={today} lang={lang} marker={offersMarker} />
      <PagePanel language={language} onLanguage={onLanguage} publicUrl={publicUrl} />
    </div>
  );
}
