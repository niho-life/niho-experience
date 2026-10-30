"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { BOOKING_FIELD_INPUT_CLASS_V1, BOOKING_FIELD_LABEL_CLASS_V1 } from "@niho/experience-presentation/v1";
import { ASK_HOST_INPUT_LIMITS, ASK_HOST_TOPICS, askHostInputProblem, createClientRequestKey, type AskHostRequest, type AskHostResult, type AskHostTopic, type ExperienceApiClient } from "@niho-experience/api-client";
import { getBrowserApi, getSiteQuestionsApi } from "@/lib/browser-api";
import type { Face } from "@/lib/card-model";
import { ASK_HOST_TOPIC_LABELS } from "@/lib/journey-ui";
import { FaceBadge } from "./Face";
import { HandIcon } from "./HandIcon";
import { Notice, buttonClass } from "./ui";

type Field = "topic" | "message" | "guestName" | "guestEmail";
type Problem = { tone: "danger" | "warn"; title: string; body?: string; field?: Field };

const FIELD_PROBLEMS: Record<Field, string> = {
  topic: "Choose what your question is about.",
  message: `Write your question in at least ${ASK_HOST_INPUT_LIMITS.messageMinLength} characters.`,
  guestName: "Please enter your name.",
  guestEmail: "Please check your email address.",
};
const FIELD_IDS: Record<Field, string> = { topic: "ask-topic", message: "ask-message", guestName: "ask-name", guestEmail: "ask-email" };

function isField(value: string | null): value is Field {
  return value === "topic" || value === "message" || value === "guestName" || value === "guestEmail";
}

/** The reason a question could not be sent, in words a traveler can act on. Never an error code. */
function problemFor(result: Exclude<AskHostResult, { ok: true }>, target: string): Problem {
  if (result.kind === "rejected") {
    const { code, field } = result.error;
    if (code === "INPUT_INVALID" && isField(field)) return { tone: "danger", title: FIELD_PROBLEMS[field], field };
    if (code === "RATE_LIMITED") {
      const seconds = result.retryAfterSeconds;
      return { tone: "warn", title: "You've sent a few questions already", body: seconds ? `Please wait ${seconds} ${seconds === 1 ? "second" : "seconds"} before sending another.` : "Please wait a little before sending another." };
    }
    if (code === "UNAVAILABLE") return { tone: "warn", title: `${target === "the host" ? "The host" : target} isn't taking questions about this experience right now`, body: "Please try again later, or see Booking help." };
  }
  if (result.kind === "not_found") return { tone: "warn", title: "This experience is no longer listed", body: "Your question was not sent." };
  return { tone: "danger", title: "We couldn't send your question", body: "Your message is still here. Please try again." };
}

/**
 * "Ask {host} a question": a sheet on a phone, a dialog on a desktop. The preview answers with the contract mock; a real
 * deployment posts to this site's own route, which keeps the question in the experience DB (#105, docs/guest-questions.md).
 * Nothing the traveler types is put in a URL, logged or sent to analytics, and the form is cleared once the question is accepted.
 */
export function AskHost({ slug, target, face, preview, nihoWebOrigin }: { slug: string; target: string; face: Face; preview: boolean; nihoWebOrigin: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const messageField = useRef<HTMLTextAreaElement>(null);
  const alertBox = useRef<HTMLDivElement>(null);
  const doneButton = useRef<HTMLButtonElement>(null);
  const api = useRef<Promise<ExperienceApiClient> | null>(null);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const headingId = useId();
  const [topic, setTopic] = useState<AskHostTopic>("OTHER");
  const [message, setMessage] = useState("");
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [retryUntil, setRetryUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const waitSeconds = retryUntil === null ? 0 : Math.max(0, Math.ceil((retryUntil - now) / 1000));

  useEffect(() => {
    if (retryUntil === null) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= retryUntil) setRetryUntil(null);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryUntil]);

  useEffect(() => {
    if (!problem) return;
    const control = problem.field ? document.getElementById(FIELD_IDS[problem.field]) : null;
    (control ?? alertBox.current)?.focus();
  }, [problem]);
  // The send button is gone once the question is accepted: keep focus inside the dialog, on the way out.
  useEffect(() => {
    if (sentTo) doneButton.current?.focus();
  }, [sentTo]);

  function open() {
    dialog.current?.showModal();
    (sentTo ? doneButton.current : messageField.current)?.focus();
  }
  function close() {
    dialog.current?.close();
  }
  // A question that was accepted starts the next one from a clean form.
  function closed() {
    if (sentTo) {
      setSentTo(null);
      setTopic("OTHER");
      attempt.current = null;
    }
    setProblem(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending || waitSeconds > 0) return;
    setProblem(null);
    const draft = { topic, message: message.trim(), guestName: guestName.trim(), guestEmail: guestEmail.trim() };
    const invalid = askHostInputProblem(draft);
    if (invalid) {
      setProblem({ tone: "danger", title: FIELD_PROBLEMS[invalid], field: invalid });
      return;
    }
    // The same content is resent with the same key (one question on the server); any change gets a new key.
    const signature = JSON.stringify(draft);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: createClientRequestKey() };
    const request: AskHostRequest = { ...draft, clientRequestKey: attempt.current.key };
    setSending(true);
    let result: AskHostResult;
    try {
      api.current ??= preview ? getBrowserApi(true, nihoWebOrigin) : Promise.resolve(getSiteQuestionsApi(window.location.origin));
      result = await (await api.current).askHost(slug, request);
    } catch {
      result = { ok: false, kind: "network_error" };
    }
    setSending(false);
    if (result.ok) {
      setSentTo(draft.guestEmail);
      setMessage("");
      setGuestName("");
      setGuestEmail("");
      attempt.current = null;
      return;
    }
    if (result.kind === "rejected" && result.error.code === "RATE_LIMITED" && result.retryAfterSeconds) {
      const current = Date.now();
      setNow(current);
      setRetryUntil(current + result.retryAfterSeconds * 1000);
    }
    setProblem(problemFor(result, target));
  }

  const subject = target === "the host" ? "the host" : target;
  return (
    <>
      <button type="button" onClick={open} className={buttonClass("secondary", "w-full sm:w-auto")}>
        <HandIcon name="chat" className="size-6" />
        Ask {subject} a question
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={headingId}
        onClose={closed}
        onClick={(event) => { if (event.target === event.currentTarget) close(); }}
        className="m-auto mb-0 max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-[22px] rounded-b-none bg-white p-0 text-ink backdrop:bg-black/60 sm:mb-auto sm:max-w-[34rem] sm:rounded-[22px]"
      >
        <div className="px-5 pt-2.5 pb-6 sm:px-7 sm:pt-6">
          <div aria-hidden className="mx-auto mb-3 h-1 w-10 rounded-full bg-line-strong sm:hidden" />
          <div className="flex items-center gap-3">
            <FaceBadge face={face} className="size-11 shrink-0 rounded-full text-base" sizes="44px" />
            <h2 id={headingId} className="min-w-0 text-[1.5rem] leading-tight">{sentTo ? "Question sent" : `Ask ${subject}`}</h2>
            <button type="button" onClick={close} aria-label="Close" className="-mr-2 ml-auto grid size-11 shrink-0 place-items-center rounded-full hover:bg-sand">
              <HandIcon name="cross" className="size-6" />
            </button>
          </div>
          {sentTo ? (
            <div role="status" className="mt-5">
              <p className="hand text-[1.5rem]">on its way</p>
              <p className="mt-2">The reply will come to <b className="break-all font-extrabold">{sentTo}</b>.</p>
              <p className="mt-2 text-sm text-ink-soft">If you don&apos;t see it, look in your spam folder.</p>
              <button ref={doneButton} type="button" onClick={close} className={buttonClass("primary", "mt-6 w-full")}>Done</button>
            </div>
          ) : (
            <form onSubmit={submit} noValidate className="mt-1">
              {problem ? (
                <div ref={alertBox} tabIndex={-1} role="alert" className="mt-4 outline-none">
                  <Notice tone={problem.tone} title={problem.title}>{problem.body}</Notice>
                </div>
              ) : null}
              <fieldset className="mt-4 min-w-0">
                <legend className="text-[0.90625rem] font-extrabold">What is it about?</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {ASK_HOST_TOPICS.map((value) => (
                    <label key={value} className="relative">
                      <input type="radio" name="ask-topic" id={value === topic ? FIELD_IDS.topic : undefined} value={value} checked={topic === value} onChange={() => setTopic(value)} className="peer absolute inset-0 z-[1] size-full cursor-pointer appearance-none rounded-full opacity-0" />
                      <span className="inline-flex min-h-11 cursor-pointer items-center rounded-full border border-line-strong bg-white px-4 text-[0.9375rem] font-bold peer-checked:border-moss peer-checked:bg-leaf-pale peer-checked:text-moss peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-moss">
                        {ASK_HOST_TOPIC_LABELS[value]}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
                Your question
                <textarea ref={messageField} id={FIELD_IDS.message} name="message" required rows={4} maxLength={ASK_HOST_INPUT_LIMITS.messageMaxLength} value={message} onChange={(event) => setMessage(event.target.value)} aria-invalid={problem?.field === "message" || undefined} className={`${BOOKING_FIELD_INPUT_CLASS_V1} min-h-[110px] resize-y`} />
              </label>
              <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
                Your name
                <input id={FIELD_IDS.guestName} name="guestName" required autoComplete="name" maxLength={ASK_HOST_INPUT_LIMITS.guestNameMaxLength} value={guestName} onChange={(event) => setGuestName(event.target.value)} aria-invalid={problem?.field === "guestName" || undefined} className={BOOKING_FIELD_INPUT_CLASS_V1} />
              </label>
              <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
                Email <small className="font-bold text-muted">(for the reply)</small>
                <input id={FIELD_IDS.guestEmail} name="guestEmail" required type="email" inputMode="email" autoComplete="email" maxLength={ASK_HOST_INPUT_LIMITS.guestEmailMaxLength} value={guestEmail} onChange={(event) => setGuestEmail(event.target.value)} aria-invalid={problem?.field === "guestEmail" || undefined} className={BOOKING_FIELD_INPUT_CLASS_V1} />
              </label>
              <p className="mt-3.5 flex items-start gap-2.5 text-[0.875rem] text-ink-soft">
                <HandIcon name="mail" className="size-6 shrink-0 text-moss" />
                <span>Write in English. NIHO translates your question for {subject}, and the reply comes to your email.</span>
              </p>
              <button type="submit" disabled={sending || waitSeconds > 0} aria-busy={sending || undefined} className={buttonClass("primary", "mt-5 w-full")}>
                {sending ? "Sending…" : waitSeconds > 0 ? `Please wait ${waitSeconds}s` : "Send question"}
              </button>
            </form>
          )}
        </div>
      </dialog>
    </>
  );
}
