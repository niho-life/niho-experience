"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { BOOKING_FIELD_INPUT_CLASS_V1, BOOKING_FIELD_LABEL_CLASS_V1 } from "@niho/experience-presentation/v1";
import { createClientRequestKey } from "@niho-experience/api-client";
import { REPLY_PAGE_MESSAGE_MAX_LENGTH, openReplyLink, sendGuestReply, tokenFromFragment, type ReplyLinkView } from "@/lib/guest-reply";
import { HandIcon } from "./HandIcon";
import { TranslationNotice } from "./TranslationNotice";
import { ButtonLink, Notice, buttonClass } from "./ui";

type View =
  | { kind: "loading" }
  /** Unknown, expired or already used: the page does not say which. */
  | { kind: "closed" }
  | { kind: "failed" }
  | { kind: "open"; link: ReplyLinkView }
  | { kind: "sent"; host: string };

const TIME = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function Conversation({ link }: { link: ReplyLinkView }) {
  return (
    <ol aria-label="Your conversation" className="mt-6 flex flex-col gap-3.5">
      {link.messages.map((message, index) => {
        const mine = message.from === "guest";
        return (
          <li key={`${message.atUtc}-${index}`} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
            <div className={`max-w-[88%] rounded-2xl px-4 py-3 [overflow-wrap:anywhere] ${mine ? "rounded-tr-md bg-leaf-pale" : "rounded-tl-md bg-sand"}`}>
              <span className="sr-only">{mine ? "You:" : `${link.hostDisplayName}:`}</span>
              <p className="whitespace-pre-wrap">{message.body}</p>
            </div>
            <p className="mt-1 px-1 text-xs text-muted">
              {mine ? "You" : link.hostDisplayName} · <time dateTime={message.atUtc}>{TIME.format(new Date(message.atUtc))}</time>
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/** What to know before writing the reply: English, where the answer arrives, one reply per link, and (when it applies) the translation notice. */
export function ReplyWritingNote({ hostDisplayName, translationNotice }: { hostDisplayName: string; translationNotice: boolean }) {
  return (
    <>
      <p className="mt-3.5 flex items-start gap-2.5 text-[0.875rem] text-ink-soft">
        <HandIcon name="mail" className="size-6 shrink-0 text-moss" />
        <span>Write in English. {hostDisplayName}&apos;s answer comes to your email. This link works for one reply.</span>
      </p>
      {translationNotice ? <TranslationNotice className="mt-2" /> : null}
    </>
  );
}

/**
 * The guest's reply page (#105, docs/guest-questions.md). The host's reply email links to `/questions/reply#t=<token>`:
 * the token is read from the fragment, taken out of the address bar at once and kept in memory only, then posted to this
 * site's own routes. The page shows the guest's words and the host's English and takes one reply per link. Nothing typed
 * goes to analytics, a URL or storage.
 */
export function GuestReply({ translationNotice = false }: {
  /** The server says whether the answer is translated into Japanese for the host (lib/translation-notice.ts); then one sentence says so. */
  translationNotice?: boolean;
} = {}) {
  const token = useRef<string | null>(null);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const alertBox = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function load() {
    if (!token.current) {
      setView({ kind: "closed" });
      return;
    }
    setView({ kind: "loading" });
    const result = await openReplyLink(token.current);
    setView(result.kind === "open" ? { kind: "open", link: result.link } : { kind: result.kind });
  }

  useEffect(() => {
    // The token leaves the address bar before anything else: not in history, a bookmark or a shared screenshot.
    token.current = tokenFromFragment(window.location.hash) ?? token.current;
    if (window.location.hash) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    void load();
  }, []);

  useEffect(() => {
    if (problem) alertBox.current?.focus();
  }, [problem]);

  async function submit(event: FormEvent<HTMLFormElement>, link: ReplyLinkView) {
    event.preventDefault();
    if (sending || !token.current) return;
    const text = message.trim();
    if (!text || text.length > REPLY_PAGE_MESSAGE_MAX_LENGTH) {
      setProblem(`Please write your reply in up to ${REPLY_PAGE_MESSAGE_MAX_LENGTH} characters.`);
      return;
    }
    setProblem(null);
    // The same words are sent again with the same key (one reply on the server); any change gets a new key.
    if (attempt.current?.signature !== text) attempt.current = { signature: text, key: createClientRequestKey() };
    setSending(true);
    const result = await sendGuestReply(token.current, text, attempt.current.key);
    setSending(false);
    if (result.kind === "sent") {
      token.current = null;
      setMessage("");
      setView({ kind: "sent", host: link.hostDisplayName });
    } else if (result.kind === "closed" || result.kind === "used") {
      token.current = null;
      setView({ kind: "closed" });
    } else if (result.kind === "invalid") {
      setProblem(`Please write your reply in up to ${REPLY_PAGE_MESSAGE_MAX_LENGTH} characters.`);
    } else {
      setProblem("We couldn't send your reply. Your message is still here. Please try again.");
    }
  }

  if (view.kind === "loading") {
    return (
      <div className="container-page max-w-2xl py-12" aria-busy="true">
        <p role="status" className="text-ink-soft">Opening your conversation…</p>
      </div>
    );
  }

  if (view.kind === "closed" || view.kind === "failed") {
    const closed = view.kind === "closed";
    return (
      <div className="container-page max-w-2xl py-12">
        <p className="hand text-[1.75rem]">{closed ? "this link has closed" : "something went wrong"}</p>
        <h1 className="mt-1 text-3xl">{closed ? "This reply link can't be used any more" : "We couldn't open your conversation"}</h1>
        <p className="mt-3 text-ink-soft">
          {closed
            ? "Each link in the host's email works for one reply, for a limited time. If you still have a question, ask the host again from the experience page."
            : "Please try again in a moment. Your link still works."}
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          {closed ? null : (
            <button type="button" onClick={() => void load()} className={buttonClass("primary")}>
              Try again
            </button>
          )}
          <ButtonLink href="/experiences" variant={closed ? "primary" : "secondary"}>Browse experiences</ButtonLink>
        </div>
      </div>
    );
  }

  if (view.kind === "sent") {
    return (
      <div className="container-page max-w-2xl py-12">
        <p className="hand text-[1.75rem]">on its way</p>
        <h1 className="mt-1 text-3xl">Reply sent</h1>
        <p role="status" className="mt-3 text-ink-soft">{view.host} will answer by email. If you don&apos;t see it, look in your spam folder.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <ButtonLink href="/experiences" variant="secondary">Browse experiences</ButtonLink>
        </div>
      </div>
    );
  }

  const { link } = view;
  return (
    <div className="container-page max-w-2xl py-12">
      <p className="hand text-[1.75rem]">reply to your host</p>
      <h1 className="mt-1 text-3xl">Your conversation with {link.hostDisplayName}</h1>
      <p className="mt-3 text-ink-soft">About {link.experienceTitle}</p>
      <Conversation link={link} />
      <form onSubmit={(event) => void submit(event, link)} noValidate className="mt-8 border-t border-line pt-6">
        {problem ? (
          <div ref={alertBox} tabIndex={-1} role="alert" className="mb-4 outline-none">
            <Notice tone="danger" title={problem} />
          </div>
        ) : null}
        <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
          Your reply
          <textarea
            name="message"
            required
            rows={4}
            maxLength={REPLY_PAGE_MESSAGE_MAX_LENGTH}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            aria-invalid={problem ? true : undefined}
            className={`${BOOKING_FIELD_INPUT_CLASS_V1} min-h-[110px] resize-y`}
          />
        </label>
        <ReplyWritingNote hostDisplayName={link.hostDisplayName} translationNotice={translationNotice} />
        <button type="submit" disabled={sending} aria-busy={sending || undefined} className={buttonClass("primary", "mt-5 w-full sm:w-auto")}>
          {sending ? "Sending…" : "Send reply"}
        </button>
      </form>
    </div>
  );
}
