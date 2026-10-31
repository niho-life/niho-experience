"use client";

import { useRef, useState, type FormEvent } from "react";
import { BOOKING_FIELD_INPUT_CLASS_V1, BOOKING_FIELD_LABEL_CLASS_V1 } from "@niho/experience-presentation/v1";
import type { GuestBookingConversation, GuestBookingMessage } from "@niho-experience/experience-store";
import { zonedMoment, zoneName } from "@/lib/booking-words";
import { BOOKING_MESSAGE_MAX_LENGTH, sendBookingMessage, type BookingMessageResult } from "@/lib/guest-booking-page";
import { HandIcon } from "./HandIcon";
import { TranslationNotice } from "./TranslationNotice";
import { Notice, buttonClass } from "./ui";

type Problem = { tone: "danger" | "warn"; title: string; body?: string };

/** What the page says after a send that did not go through; null when it did. */
export function bookingMessageProblem(result: BookingMessageResult, hostDisplayName: string): Problem | null {
  switch (result.kind) {
    case "sent":
      return null;
    case "closed":
      return { tone: "warn", title: "This booking no longer takes messages", body: "Your message wasn't sent. Questions? Reply to your confirmation email and NIHO support will help." };
    case "limited": {
      const minutes = Math.max(1, Math.ceil(result.retryAfterSeconds / 60));
      return { tone: "warn", title: `You've sent a lot of messages in the last hour. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, body: "Your message is still here." };
    }
    case "invalid":
      return { tone: "danger", title: `Write a message of up to ${BOOKING_MESSAGE_MAX_LENGTH} characters.` };
    case "conflict":
      return { tone: "danger", title: "Something changed. Please press Send again.", body: "Your message is still here." };
    case "signedOut":
      return { tone: "warn", title: "This booking isn't open on this device any more", body: "Open it again from the link in your email, or ask for a new link." };
    case "failed":
      return { tone: "danger", title: `We couldn't confirm your message reached ${hostDisplayName}. Please try again.`, body: "Trying again is safe: it won't be sent twice." };
  }
}

/** A message sent from this page, shown until the page is read again. */
interface SentHere extends GuestBookingMessage {
  readonly sentHere: true;
}

function MessageList({ messages, hostDisplayName, timeZone }: { messages: readonly (GuestBookingMessage | SentHere)[]; hostDisplayName: string; timeZone: string }) {
  return (
    <ol aria-label={`Your messages with ${hostDisplayName}`} className="mt-5 flex flex-col gap-3.5">
      {messages.map((message) => {
        const mine = message.from === "guest";
        return (
          <li key={message.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
            <div className={`max-w-[88%] rounded-2xl px-4 py-3 [overflow-wrap:anywhere] ${mine ? "rounded-tr-md bg-leaf-pale" : "rounded-tl-md bg-sand"}`}>
              <span className="sr-only">{mine ? "You:" : `${hostDisplayName}:`}</span>
              <p className="whitespace-pre-wrap">{message.body}</p>
            </div>
            <p className="mt-1 px-1 text-xs text-muted">
              {mine ? "You" : hostDisplayName} · <time dateTime={message.atUtc}>{zonedMoment(Date.parse(message.atUtc), timeZone)}</time>
              {"sentHere" in message ? " · Sent" : null}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * 予約ごとのメッセージ on the guest's booking page (#285 slice 6b): the messages with the host (the guest's own words
 * and the host's English) and a box to write. The host answers by email and here. A booking that takes no more
 * messages (cancelled, or 30 days after the experience) shows its history only. The key of a message stays the same
 * while its words do, so a retry after a lost answer never sends it twice.
 */
export function BookingMessages({ publicBookingId, hostDisplayName, timeZone, conversation, translationNotice = false }: {
  publicBookingId: string;
  hostDisplayName: string;
  timeZone: string;
  /** null when the messages could not be read: the rest of the page still shows. */
  conversation: GuestBookingConversation | null;
  /** The server says whether messages are translated into Japanese for the host (lib/translation-notice.ts); then one sentence says so. */
  translationNotice?: boolean;
}) {
  const [sent, setSent] = useState<readonly SentHere[]>([]);
  const [open, setOpen] = useState(conversation?.open ?? false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [status, setStatus] = useState("");
  const attempt = useRef<{ words: string; key: string } | null>(null);
  const alertBox = useRef<HTMLDivElement>(null);

  if (!conversation) {
    return (
      <p role="alert" className="mt-3 text-[0.9375rem] text-ink-soft">
        We couldn&apos;t load your messages with {hostDisplayName}. Reloading this page is enough to try again.
      </p>
    );
  }
  const messages = [...conversation.messages, ...sent];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    const words = message.trim();
    if (!words || words.length > BOOKING_MESSAGE_MAX_LENGTH) {
      setProblem(bookingMessageProblem({ kind: "invalid" }, hostDisplayName));
      return;
    }
    if (attempt.current?.words !== words) attempt.current = { words, key: crypto.randomUUID() };
    setSending(true);
    setProblem(null);
    setStatus("");
    const result = await sendBookingMessage({ publicBookingId, clientRequestKey: attempt.current.key, message: words });
    setSending(false);
    if (result.kind === "sent") {
      setSent((current) => [...current, { id: attempt.current!.key, from: "guest", atUtc: new Date().toISOString(), body: words, sentHere: true }]);
      attempt.current = null;
      setMessage("");
      setStatus(`Sent. ${hostDisplayName} gets your message now and will answer here and by email.`);
      return;
    }
    if (result.kind === "closed") setOpen(false);
    if (result.kind === "conflict") attempt.current = null;
    setProblem(bookingMessageProblem(result, hostDisplayName));
    requestAnimationFrame(() => alertBox.current?.focus());
  }

  return (
    <>
      {messages.length ? (
        <MessageList messages={messages} hostDisplayName={hostDisplayName} timeZone={timeZone} />
      ) : (
        <p className="mt-3 text-[0.9375rem] text-ink-soft">
          {open ? `No messages yet. Write to ${hostDisplayName} about this booking: they'll answer here and by email.` : "No messages were sent about this booking."}
        </p>
      )}
      <p role="status" className="mt-3 text-[0.9375rem] font-bold text-moss empty:hidden">{status}</p>
      {problem ? (
        <div ref={alertBox} tabIndex={-1} role="alert" className="mt-4 outline-none">
          <Notice tone={problem.tone} title={problem.title}>{problem.body}</Notice>
        </div>
      ) : null}
      {open ? (
        <form onSubmit={(event) => void submit(event)} noValidate className="mt-6">
          <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
            Write to {hostDisplayName}
            <textarea
              name="message"
              required
              rows={4}
              maxLength={BOOKING_MESSAGE_MAX_LENGTH}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              aria-invalid={problem?.tone === "danger" || undefined}
              className={`${BOOKING_FIELD_INPUT_CLASS_V1} min-h-[110px] resize-y`}
            />
          </label>
          <p className="mt-3.5 flex items-start gap-2.5 text-[0.875rem] text-ink-soft">
            <HandIcon name="chat" className="size-6 shrink-0 text-moss" />
            <span>
              {hostDisplayName} gets your message right away. Their answer comes here and to your email. Times are {zoneName(timeZone)}.
            </span>
          </p>
          {translationNotice ? <TranslationNotice className="mt-2" /> : null}
          <button type="submit" disabled={sending} aria-busy={sending || undefined} className={buttonClass("primary", "mt-5 w-full sm:w-auto")}>
            {sending ? "Sending…" : "Send message"}
          </button>
        </form>
      ) : (
        <p className="mt-4 text-[0.9375rem] text-ink-soft">
          This booking no longer takes messages. Questions? Reply to your confirmation email and NIHO support will help.
        </p>
      )}
    </>
  );
}
