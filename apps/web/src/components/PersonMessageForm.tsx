"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { BOOKING_FIELD_INPUT_CLASS_V1, BOOKING_FIELD_LABEL_CLASS_V1 } from "@niho/experience-presentation/v1";
import { createClientRequestKey } from "@niho-experience/api-client";
import { PERSON_MESSAGE_LIMITS, personMessageProblem, type PersonMessageField } from "@/lib/person-message";
import { HandIcon } from "./HandIcon";
import { Notice, buttonClass } from "./ui";

type Problem = { tone: "danger" | "warn"; title: string; body?: string; field?: PersonMessageField };

const FIELD_PROBLEMS: Record<PersonMessageField, string> = {
  message: `メッセージを${PERSON_MESSAGE_LIMITS.messageMinLength}文字以上で書いてください。`,
  guestName: "お名前を入力してください。",
  guestEmail: "メールアドレスを確かめてください。",
};
const FIELD_IDS: Record<PersonMessageField, string> = { message: "person-message", guestName: "person-name", guestEmail: "person-email" };

const isField = (value: unknown): value is PersonMessageField => value === "message" || value === "guestName" || value === "guestEmail";

/**
 * 「◯◯さんにメッセージを送る」 on a person's page (#589): a sheet on a phone, a dialog on a desktop. Name, address and the
 * message, and nothing else; the reply comes to the address. The page says where the message goes ("◯◯さんに送りました") and
 * nothing about how it gets there. It posts to this site's own route, which keeps the message in the experience DB for the
 * person's OWNER account (docs/guest-questions.md). What is typed is never put in a URL, logged or sent to analytics, and the
 * form is cleared once the message is accepted.
 */
export function PersonMessageForm({ slug, name }: { slug: string; name: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const messageField = useRef<HTMLTextAreaElement>(null);
  const alertBox = useRef<HTMLDivElement>(null);
  const doneButton = useRef<HTMLButtonElement>(null);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const headingId = useId();
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
  // The send button is gone once the message is accepted: keep focus inside the dialog, on the way out.
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
  // A message that was accepted starts the next one from a clean form.
  function closed() {
    if (sentTo) {
      setSentTo(null);
      attempt.current = null;
    }
    setProblem(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || sending || waitSeconds > 0) return;
    setProblem(null);
    const draft = { message: message.trim(), guestName: guestName.trim(), guestEmail: guestEmail.trim() };
    const invalid = personMessageProblem(draft);
    if (invalid) {
      setProblem({ tone: "danger", title: FIELD_PROBLEMS[invalid], field: invalid });
      return;
    }
    // The same content is resent with the same key (one message on the server); any change gets a new key.
    const signature = JSON.stringify(draft);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: createClientRequestKey() };
    inFlight.current = true;
    setSending(true);
    try {
      const response = await fetch(`/api/public/people/${encodeURIComponent(slug)}/messages`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...draft, clientRequestKey: attempt.current.key }),
      });
      const body = (await response.json().catch(() => null)) as { accepted?: boolean; error?: { field?: string | null } } | null;
      if (response.status === 201 && body?.accepted === true) {
        setSentTo(draft.guestEmail);
        setMessage("");
        setGuestName("");
        setGuestEmail("");
        attempt.current = null;
        return;
      }
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        if (Number.isFinite(seconds) && seconds > 0) {
          const current = Date.now();
          setNow(current);
          setRetryUntil(current + seconds * 1000);
          setProblem({ tone: "warn", title: "続けて送りすぎています", body: `${Math.ceil(seconds)}秒ほど待ってから、もう一度お試しください。` });
        } else {
          setProblem({ tone: "warn", title: "続けて送りすぎています", body: "少し待ってから、もう一度お試しください。" });
        }
        return;
      }
      if (response.status === 422 && isField(body?.error?.field)) {
        setProblem({ tone: "danger", title: FIELD_PROBLEMS[body.error.field], field: body.error.field });
        return;
      }
      if (response.status === 404) {
        setProblem({ tone: "warn", title: `いま、${name}さんにはメッセージを送れません`, body: "時間をおいて、もう一度お試しください。" });
        return;
      }
      setProblem({ tone: "danger", title: "送れませんでした", body: "メッセージは残っています。もう一度お試しください。" });
    } catch {
      setProblem({ tone: "danger", title: "送れませんでした", body: "メッセージは残っています。もう一度お試しください。" });
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return (
    <>
      <button type="button" onClick={open} className={buttonClass("secondary", "mt-6 w-full sm:w-auto")}>
        <HandIcon name="chat" className="size-6" />
        {name}さんにメッセージを送る
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
            <h2 id={headingId} className="min-w-0 text-[1.5rem] leading-tight">{sentTo ? `${name}さんに送りました` : `${name}さんにメッセージ`}</h2>
            <button type="button" onClick={close} aria-label="閉じる" className="-mr-2 ml-auto grid size-11 shrink-0 place-items-center rounded-full hover:bg-sand">
              <HandIcon name="cross" className="size-6" />
            </button>
          </div>
          {sentTo ? (
            <div role="status" className="mt-5">
              <p>返事は <b className="break-all font-extrabold">{sentTo}</b> に届きます。</p>
              <p className="mt-2 text-sm text-ink-soft">見当たらないときは、迷惑メールのフォルダーもご確認ください。</p>
              <button ref={doneButton} type="button" onClick={close} className={buttonClass("primary", "mt-6 w-full")}>閉じる</button>
            </div>
          ) : (
            <form onSubmit={submit} noValidate className="mt-1">
              {problem ? (
                <div ref={alertBox} tabIndex={-1} role="alert" className="mt-4 outline-none">
                  <Notice tone={problem.tone} title={problem.title}>{problem.body}</Notice>
                </div>
              ) : null}
              <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
                メッセージ
                <textarea ref={messageField} id={FIELD_IDS.message} name="message" required rows={5} maxLength={PERSON_MESSAGE_LIMITS.messageMaxLength} value={message} onChange={(event) => setMessage(event.target.value)} aria-invalid={problem?.field === "message" || undefined} className={`${BOOKING_FIELD_INPUT_CLASS_V1} min-h-[130px] resize-y`} />
              </label>
              <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
                お名前
                <input id={FIELD_IDS.guestName} name="guestName" required autoComplete="name" maxLength={PERSON_MESSAGE_LIMITS.nameMaxLength} value={guestName} onChange={(event) => setGuestName(event.target.value)} aria-invalid={problem?.field === "guestName" || undefined} className={BOOKING_FIELD_INPUT_CLASS_V1} />
              </label>
              <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
                メールアドレス <small className="font-bold text-muted">（返信はこのアドレスに届きます）</small>
                <input id={FIELD_IDS.guestEmail} name="guestEmail" required type="email" inputMode="email" autoComplete="email" maxLength={PERSON_MESSAGE_LIMITS.emailMaxLength} value={guestEmail} onChange={(event) => setGuestEmail(event.target.value)} aria-invalid={problem?.field === "guestEmail" || undefined} className={BOOKING_FIELD_INPUT_CLASS_V1} />
              </label>
              <button type="submit" disabled={sending || waitSeconds > 0} aria-busy={sending || undefined} className={buttonClass("primary", "mt-5 w-full")}>
                {sending ? "送っています…" : waitSeconds > 0 ? `${waitSeconds}秒お待ちください` : "送る"}
              </button>
            </form>
          )}
        </div>
      </dialog>
    </>
  );
}
