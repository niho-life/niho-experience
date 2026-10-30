"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { draftReplyEnglish } from "@/host/actions";
import { bookingsHref, shortDateTime } from "@/host/bookings";
import { guestMessageView, MESSAGE_TEXT_LIMIT, REPLY_STATUS, replyDraftState, threadContext, threadHeading } from "@/host/messages";
import type { HostGuestMessage, HostReplyMessage, HostThread } from "@/host/types";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { HostIcon } from "./HostIcon";
import { ReplyDraftFields, useReplyDraft } from "./ReplyDraftFields";

/*
 * One thread of メッセージ (#106, the journey mock's H2): the guest's words in Japanese with their
 * own under them, the host's replies with the English that was sent, and the reply to write.
 * The host writes Japanese, lets NIHO make the English (英語にする, a server action), checks or
 * corrects it, and sends that English; English NIHO made from older Japanese is never sent.
 */

const BUBBLE = "max-w-[88%] rounded-2xl px-3.5 py-2.5 text-[0.875rem] leading-[1.55] [overflow-wrap:anywhere]";
const BUBBLE_META = "mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5 text-xs leading-normal text-muted";
/** A second part of a bubble under a dashed line: the original, the English that was sent. */
const BUBBLE_PART = "mt-2 border-t border-dashed border-line-strong pt-2 text-[0.8125rem]";

function MessageTime({ at }: { at: string }) {
  return (
    <time dateTime={`${at}+09:00`} className="tabular-nums">
      {shortDateTime(at)}
    </time>
  );
}

/** The guest's message on the left: NIHO's translation, the original under it (or the original alone when it could not be translated). */
function GuestBubble({ message, guest }: { message: HostGuestMessage; guest: string }) {
  const view = guestMessageView(message);
  return (
    <li className="flex flex-col items-start">
      <div className={`${BUBBLE} rounded-tl-md bg-sand`}>
        <span className="sr-only">{guest} さん：</span>
        <p lang={view.lang} className="whitespace-pre-wrap">
          {view.text}
        </p>
        {view.original ? (
          <p lang={message.language} className={`${BUBBLE_PART} whitespace-pre-wrap text-muted`}>
            <span lang="ja" className="sr-only">
              原文：
            </span>
            {view.original}
          </p>
        ) : null}
      </div>
      <p className={BUBBLE_META}>
        {view.note ? (
          <span className={`inline-flex items-center rounded-full px-2 font-extrabold ${view.untranslated ? "bg-warn-pale text-warn" : "bg-info-pale text-info"}`}>{view.note}</span>
        ) : null}
        {message.viaEmail ? <span>メールで返信</span> : null}
        <MessageTime at={message.at} />
      </p>
    </li>
  );
}

/** The host's reply on the right: the Japanese they wrote, and the English the guest got behind 送った英語. */
function ReplyBubble({ message, providerName }: { message: HostReplyMessage; providerName: string }) {
  const sent = message.status === "sent";
  const failed = message.status === "failed";
  return (
    <li className="flex flex-col items-end">
      <div className={`${BUBBLE} rounded-tr-md bg-leaf-pale`}>
        <span className="sr-only">{providerName}：</span>
        {message.japanese ? (
          <>
            <p className="whitespace-pre-wrap">{message.japanese}</p>
            <details className={`group ${BUBBLE_PART}`}>
              <summary className="inline-flex cursor-pointer list-none items-center gap-0.5 text-xs font-extrabold text-moss [&::-webkit-details-marker]:hidden">
                送った英語
                <HostIcon name="chevronDown" className="size-3.5 group-open:rotate-180" />
              </summary>
              <p lang="en" className="mt-1 whitespace-pre-wrap text-ink-soft">
                {message.english}
              </p>
            </details>
          </>
        ) : (
          <p lang="en" className="whitespace-pre-wrap">
            {message.english}
          </p>
        )}
      </div>
      <p className={`${BUBBLE_META} justify-end`}>
        <span className={`inline-flex items-center gap-0.5 font-bold ${sent ? "text-moss" : failed ? "text-danger" : "text-muted"}`}>
          {sent || failed ? <HostIcon name={sent ? "check" : "close"} className="size-3.5" /> : null}
          {REPLY_STATUS[message.status]}
        </span>
        <MessageTime at={message.at} />
      </p>
    </li>
  );
}

export interface ReplyInput {
  japanese: string;
  english: string;
  /** The browser's id for this reply: the same words sent again keep it, so a retry is the same reply. */
  commandId: string;
}

/** What the screen did with a reply: null when it was sent, else why not (the reply stays as written). */
export type SendReply = (reply: ReplyInput) => Promise<string | null>;

/**
 * 送信欄: 日本語で書く → 英語にする → "{名前} さんに届く英語" (英語を作り直す / 英語を直す) →
 * この英語で送る. On phones it stays at the bottom of the screen. While NIHO makes the English,
 * or when it fails, the Japanese stays as written (ReplyDraftFields); so does a reply that could not be sent.
 */
function ReplyComposer({ thread, providerId, onSend }: { thread: HostThread; providerId: string; onSend: SendReply }) {
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const attempt = useRef<{ signature: string; commandId: string } | null>(null);
  const japaneseField = useRef<HTMLTextAreaElement>(null);
  const draft = useReplyDraft((japanese) => draftReplyEnglish({ providerId, threadId: thread.id, japanese }), { onChange: () => setSent(false) });
  const { canSend } = replyDraftState(draft);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSend || draft.drafting || sending) return;
    const signature = JSON.stringify([draft.japanese, draft.english]);
    if (attempt.current?.signature !== signature) attempt.current = { signature, commandId: crypto.randomUUID() };
    setSending(true);
    setProblem(null);
    const failed = await onSend({ japanese: draft.japanese, english: draft.english, commandId: attempt.current.commandId });
    setSending(false);
    if (failed) {
      setProblem(failed);
      return;
    }
    attempt.current = null;
    draft.clear();
    setSent(true);
    // The button pressed waits for the next English: the next reply starts in the Japanese.
    japaneseField.current?.focus();
  };

  return (
    <form onSubmit={(event) => void submit(event)} aria-label="返信" aria-busy={sending || undefined} className="sticky bottom-0 z-10 mt-auto rounded-b-2xl border-t border-line bg-canvas px-4 pt-3 pb-[max(0.875rem,env(safe-area-inset-bottom))] md:px-5">
      <ReplyDraftFields draft={draft} japaneseRef={japaneseField} maxLength={MESSAGE_TEXT_LIMIT} englishLabel={`${thread.guest} さんに届く英語`} submitLabel={sending ? "送っています…" : "この英語で送る"} canSubmit={canSend && !sending} />
      {problem ? (
        <p role="alert" className="mt-2 text-[0.78125rem] leading-normal font-extrabold text-danger">
          {problem}
        </p>
      ) : null}
      <p className="mt-2 text-xs leading-normal text-muted">{thread.guest} さんにはメールで届きます</p>
      <p role="status" className={sent ? "mt-1 flex items-center gap-1 text-[0.78125rem] leading-normal font-extrabold text-moss" : "sr-only"}>
        {sent ? (
          <>
            <HostIcon name="check" className="size-3.5" />
            送りました
          </>
        ) : null}
      </p>
    </form>
  );
}

export interface HostMessageThreadProps {
  thread: HostThread;
  experienceTitle: string;
  /** The heading's id: the page moves focus there when it opens a thread on a phone. */
  headingId: string;
  /** The URL's own `?providerId=`, carried on 予約を見る. */
  linkProviderId: string | null;
  /** The provider the reply is written for (the server action's). */
  providerId: string;
  /** Who the host's replies are from, for screen readers. */
  providerName: string;
  onSend: SendReply;
  /** A question opened from the list while its messages are read (or why they could not be). */
  loading?: { failed: string | null } | null;
}

/** One thread: its title and experience (with the booking when there is one), the messages in time order, and the reply. */
export function HostMessageThread({ thread, experienceTitle, headingId, linkProviderId, providerId, providerName, onSend, loading = null }: HostMessageThreadProps) {
  return (
    <section aria-labelledby={headingId} className={`${HOST_SURFACE} flex flex-col`}>
      <div className="p-4 pb-3 md:px-5 md:pt-[18px]">
        <h2 id={headingId} tabIndex={-1} className="font-sans text-[1.125rem] leading-[1.3] font-extrabold tracking-normal [overflow-wrap:anywhere] focus:outline-none">
          {threadHeading(thread)}
        </h2>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-sand px-3 py-2.5">
          <div className="min-w-0 flex-[1_1_180px]">
            <p className="text-[0.8125rem] leading-[1.4] font-extrabold [overflow-wrap:anywhere]">{experienceTitle}</p>
            <p className="text-xs leading-normal text-muted">{threadContext(thread)}</p>
          </div>
          {thread.booking ? (
            <Link href={bookingsHref({ providerId: linkProviderId, booking: thread.booking.id })} className={consoleButtonClass("secondary", "sm")}>
              予約を見る
            </Link>
          ) : null}
        </div>
      </div>
      {loading ? (
        <p role={loading.failed ? "alert" : "status"} className={`px-4 pb-2 text-[0.8125rem] leading-normal md:px-5 ${loading.failed ? "font-extrabold text-danger" : "text-muted"}`}>
          {loading.failed ?? "前のやりとりを読み込んでいます…"}
        </p>
      ) : null}
      {thread.messages.length ? (
        <ol aria-label="やりとり" className="flex flex-col gap-3.5 px-4 pt-1 pb-4 md:px-5">
          {thread.messages.map((message) => (message.from === "guest" ? <GuestBubble key={message.id} message={message} guest={thread.guest} /> : <ReplyBubble key={message.id} message={message} providerName={providerName} />))}
        </ol>
      ) : null}
      <ReplyComposer thread={thread} providerId={providerId} onSend={onSend} />
    </section>
  );
}
