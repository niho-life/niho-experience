"use client";

import { useId, useState, type ReactNode, type RefObject } from "react";
import { REPLY_DRAFT_FAILED_TEXT, replyDraftState, type ReplyDraft } from "@/host/messages";
import type { HostActionResult } from "@/host/payout";
import { DISABLED, FIELD_LABEL, useFocusAfterRender } from "./editor-parts";
import { TEXTAREA } from "./fields";
import { consoleButtonClass } from "./host-ui";

/*
 * A reply the host writes in Japanese and the guest reads in English, shared by メッセージ (#106)
 * and レビュー (#108): 日本語で書く → 英語にする (NIHO, a server action) → the English to check
 * (英語を作り直す / 英語を直す; or 英語を直接書く) → the screen's own button (この英語で送る,
 * 返信を公開する). English NIHO made from older Japanese waits until it is made again or corrected.
 * While NIHO makes the English, or when it fails, the Japanese stays as written.
 */

/** 英語にする: NIHO's English of the Japanese, or why there is none. */
export type MakeEnglish = (japanese: string) => Promise<HostActionResult<{ english: string }>>;

export interface ReplyDraftControl extends ReplyDraft {
  ids: { japanese: string; english: string };
  /** The host writes (or corrects) the English themselves. */
  editing: boolean;
  /** NIHO is making the English. */
  drafting: boolean;
  error: string;
  /** The Japanese changed after NIHO made the English. */
  stale: boolean;
  /** The English shows: made by NIHO, or being written. */
  hasEnglish: boolean;
  setJapanese: (value: string) => void;
  setEnglish: (value: string) => void;
  makeEnglish: () => Promise<void>;
  /** 英語を直す / 英語を直接書く: the English becomes the host's own, sent as they write it. */
  writeEnglish: () => void;
  /** After sending: an empty reply again. */
  clear: () => void;
}

/**
 * The reply's state. `initial` starts from a reply already there (返信を直す); `onChange` hears
 * every change the host makes (the screen takes its "sent" line away).
 */
export function useReplyDraft(make: MakeEnglish, { initial, onChange }: { initial?: ReplyDraft; onChange?: () => void } = {}): ReplyDraftControl {
  const baseId = useId();
  const ids = { japanese: `${baseId}-ja`, english: `${baseId}-en` };
  const [japanese, setJapaneseValue] = useState(initial?.japanese ?? "");
  const [english, setEnglishValue] = useState(initial?.english ?? "");
  /** The Japanese NIHO made the English from; null once the host corrects or writes it. */
  const [madeFrom, setMadeFrom] = useState<string | null>(initial?.madeFrom ?? null);
  const [editing, setEditing] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState("");
  const focusLater = useFocusAfterRender();
  const { stale } = replyDraftState({ japanese, english, madeFrom });

  const makeEnglish = async () => {
    const source = japanese;
    if (!source.trim() || drafting) return;
    setDrafting(true);
    setError("");
    onChange?.();
    try {
      const result = await make(source);
      if (result.ok) {
        setEnglishValue(result.english);
        setMadeFrom(source);
        setEditing(false);
      } else {
        setError(result.message);
      }
    } catch {
      setError(REPLY_DRAFT_FAILED_TEXT);
    } finally {
      setDrafting(false);
    }
  };

  return {
    ids,
    japanese,
    english,
    madeFrom,
    editing,
    drafting,
    error,
    stale,
    hasEnglish: editing || english !== "",
    setJapanese: (value) => {
      setJapaneseValue(value);
      onChange?.();
    },
    setEnglish: (value) => {
      setEnglishValue(value);
      onChange?.();
    },
    makeEnglish,
    writeEnglish: () => {
      setEditing(true);
      setMadeFrom(null);
      onChange?.();
      focusLater(ids.english);
    },
    clear: () => {
      setJapaneseValue("");
      setEnglishValue("");
      setMadeFrom(null);
      setEditing(false);
      setError("");
    },
  };
}

export interface ReplyDraftFieldsProps {
  draft: ReplyDraftControl;
  japaneseRef?: RefObject<HTMLTextAreaElement | null>;
  maxLength: number;
  /** Over the English: "{名前} さんに届く英語", "公開される英語". */
  englishLabel: string;
  /** The form's own button (type="submit"). */
  submitLabel: string;
  canSubmit: boolean;
  /** Buttons next to the submit one (やめる). */
  extra?: ReactNode;
}

/** The Japanese, the English to check, what stops the English, and the buttons. The form around it is the screen's. */
export function ReplyDraftFields({ draft, japaneseRef, maxLength, englishLabel, submitLabel, canSubmit, extra }: ReplyDraftFieldsProps) {
  const submit = (
    <button type="submit" disabled={!canSubmit || draft.drafting} className={consoleButtonClass("primary", "md", `${extra ? "" : "ml-auto "}${DISABLED}`)}>
      {submitLabel}
    </button>
  );
  return (
    <>
      <label htmlFor={draft.ids.japanese} className={FIELD_LABEL}>
        日本語で書く
      </label>
      <textarea
        ref={japaneseRef}
        id={draft.ids.japanese}
        rows={3}
        maxLength={maxLength}
        value={draft.japanese}
        onChange={(event) => draft.setJapanese(event.currentTarget.value)}
        className={`${TEXTAREA} mt-1.5 min-h-[76px]`}
      />

      {draft.hasEnglish ? (
        draft.editing ? (
          <div className="mt-2.5 flex flex-col gap-1.5">
            <label htmlFor={draft.ids.english} className={FIELD_LABEL}>
              {englishLabel}
            </label>
            <textarea
              id={draft.ids.english}
              lang="en"
              rows={3}
              maxLength={maxLength}
              value={draft.english}
              onChange={(event) => draft.setEnglish(event.currentTarget.value)}
              className={`${TEXTAREA} min-h-[76px]`}
            />
          </div>
        ) : (
          <div className="mt-2.5 rounded-xl bg-info-pale px-3 py-2.5 text-[0.84375rem] leading-normal">
            <p className="text-xs font-extrabold text-info">{englishLabel}</p>
            <p lang="en" className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {draft.english}
            </p>
          </div>
        )
      ) : null}

      <p role="status" className={draft.stale ? "mt-2 text-[0.78125rem] leading-normal font-extrabold text-warn" : "sr-only"}>
        {draft.stale ? "日本語を変えました。英語を作り直してください" : ""}
      </p>
      {draft.error ? (
        <p role="alert" className="mt-2 text-[0.78125rem] leading-normal font-extrabold text-danger">
          {draft.error}
        </p>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button type="button" onClick={draft.makeEnglish} disabled={!draft.japanese.trim() || draft.drafting} className={consoleButtonClass("secondary", "sm", DISABLED)}>
          {draft.drafting ? "英語にしています…" : draft.hasEnglish ? "英語を作り直す" : "英語にする"}
        </button>
        {draft.editing ? null : (
          <button type="button" onClick={draft.writeEnglish} className={consoleButtonClass(draft.hasEnglish ? "secondary" : "ghost", "sm")}>
            {draft.hasEnglish ? "英語を直す" : "英語を直接書く"}
          </button>
        )}
        {extra ? (
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {extra}
            {submit}
          </span>
        ) : (
          submit
        )}
      </div>
    </>
  );
}
