"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { BOOKING_FIELD_INPUT_CLASS_V1, BOOKING_FIELD_LABEL_CLASS_V1 } from "@niho/experience-presentation/v1";
import {
  BUDGET_UNITS,
  GROUP_INQUIRY_FIELDS,
  GROUP_INQUIRY_KINDS,
  GROUP_INQUIRY_LIMITS,
  checkGroupInquiry,
  type GroupInquiryEntry,
  type GroupInquiryField,
  type GroupInquiryKind,
  type GroupInquiryLocale,
} from "@niho-experience/experience-store/group-inquiry-fields";
import { captureBookingAttribution, readBookingAttribution } from "@/lib/booking-attribution";
import {
  INQUIRY_CHOICE_LABEL,
  INQUIRY_FIELD_LABEL,
  INQUIRY_FIELD_PLACEHOLDER,
  INQUIRY_FREE_NOTE,
  INQUIRY_KIND_HINT,
  INQUIRY_KIND_LABEL,
  INQUIRY_NOT_BOOKED,
  INQUIRY_PRIVACY_NOTE,
  inquiryDateLabel,
} from "@/lib/group-inquiry-copy";
import { Notice, buttonClass } from "./ui";

/** Where the person came from, as the entry page told the form. It stays on screen until the inquiry is sent. */
export type InquiryContext = {
  readonly entry: GroupInquiryEntry;
  readonly experienceSlug: string | null;
  readonly experienceTitle: string | null;
  readonly hostName: string | null;
};

type Problem = { readonly tone: "danger" | "warn"; readonly title: string; readonly body?: string; readonly field?: string };
type Accepted = { readonly inquiryRef: string; readonly replyByDate: string };

const TEXT = {
  ja: {
    kind: "ご相談の種類",
    optional: "任意",
    required: "必須",
    name: "お名前",
    email: "メールアドレス",
    emailHint: "返信と受付のお知らせをお送りします",
    message: "ご相談の内容",
    messageHint: "決まっていないことは書かなくて大丈夫です。わかる範囲で、やりたいことを教えてください。",
    moreTitle: "わかる範囲で教えてください（すべて任意・未定のままで送れます）",
    interest: "気になる体験・人（任意）",
    interestHint: "ページから来た場合は、その体験を自動で添えています。",
    contextExperience: "この体験についての相談",
    contextHost: (host: string) => `${host}さんへの相談`,
    contextSchool: "学校向けの相談",
    contextCorporate: "法人・団体向けの相談",
    contextListing: "体験を載せたい方の相談",
    send: "相談を送る",
    sending: "送信中…",
    wait: (seconds: number) => `${seconds}秒お待ちください`,
    receivedTitle: "ご相談を受け付けました",
    receivedLead: "受け付けた内容を、入力されたメールアドレスにお送りしました。",
    reference: "受付番号",
    replyBy: (date: string) => `返信の目安：${date}までにご連絡します（土日は含みません）`,
    spam: "届かないときは、迷惑メールのフォルダもご確認ください。",
    another: "別の相談を送る",
    problems: {
      kind: "相談の種類を選んでください。",
      name: "お名前を入力してください。",
      email: "メールアドレスの形式を確認してください。",
      message: "ご相談の内容を入力してください。",
      invalid: "入力内容を確認してください。",
    },
    rateLimited: "短い時間に何度も送信されました",
    rateWait: (seconds: number) => `${seconds}秒ほど待ってから、もう一度お試しください。`,
    rateGeneric: "しばらく待ってから、もう一度お試しください。",
    failedTitle: "送信できませんでした",
    failedBody: "入力した内容は、この画面にそのまま残っています。通信の状態を確認して、もう一度お試しください。",
    close: "閉じる",
  },
  en: {
    kind: "What is this about?",
    optional: "optional",
    required: "required",
    name: "Your name",
    email: "Email",
    emailHint: "We reply here and send you a receipt",
    message: "What would you like to ask?",
    messageHint: "No need to have it all decided. Tell us what you have in mind so far.",
    moreTitle: "Tell us what you know (all optional; you can send it undecided)",
    interest: "Experience or host you are interested in (optional)",
    interestHint: "If you came from a page, that experience is attached for you.",
    contextExperience: "An inquiry about this experience",
    contextHost: (host: string) => `An inquiry for ${host}`,
    contextSchool: "An inquiry for schools",
    contextCorporate: "An inquiry for companies and organizations",
    contextListing: "An inquiry about listing an experience",
    send: "Send inquiry",
    sending: "Sending…",
    wait: (seconds: number) => `Please wait ${seconds}s`,
    receivedTitle: "We received your inquiry",
    receivedLead: "We sent what we received to the email address you gave.",
    reference: "Reference",
    replyBy: (date: string) => `When to expect a reply: by ${date} (weekends not counted)`,
    spam: "If it does not arrive, please check your spam folder.",
    another: "Send another inquiry",
    problems: {
      kind: "Choose what the inquiry is about.",
      name: "Please enter your name.",
      email: "Please check your email address.",
      message: "Please write what you would like to ask.",
      invalid: "Please check what you entered.",
    },
    rateLimited: "Too many inquiries in a short time",
    rateWait: (seconds: number) => `Please wait about ${seconds} seconds and try again.`,
    rateGeneric: "Please wait a little and try again.",
    failedTitle: "We couldn't send your inquiry",
    failedBody: "What you typed is still here. Please check your connection and try again.",
    close: "Close",
  },
} as const;

const FIELD_ID = (key: string) => `inquiry-${key}`;
const REQUEST_KEY_PREFIX = "inq-";

function newRequestKey(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${REQUEST_KEY_PREFIX}${random}`;
}

/** The sentence at the top that says what this inquiry is about, from the page the person came from. */
function contextLine(context: InquiryContext, kind: GroupInquiryKind, locale: GroupInquiryLocale): string | null {
  const text = TEXT[locale];
  if (context.hostName) return text.contextHost(context.hostName);
  if (context.entry === "EXPERIENCE") return text.contextExperience;
  if (context.entry === "SCHOOL" && kind === "SCHOOL") return text.contextSchool;
  if (context.entry === "CORPORATE" && kind === "CORPORATE") return text.contextCorporate;
  if (context.entry === "LISTING" && kind === "LISTING") return text.contextListing;
  return null;
}

/**
 * 団体・個別の相談 (#532, docs/group-inquiry.md). Three things are required (name, email, message); every other question
 * is optional and an inquiry goes out with them left undecided. The context the entry page passed stays on screen until
 * the inquiry is accepted, and the same content is resent with the same key (one inquiry on the server). Nothing the
 * person types goes into a URL, a log or analytics. "Received" is shown only after the server accepted the inquiry; a
 * failure keeps every field as typed.
 */
export function GroupInquiryForm({ locale, initialKind, context }: { locale: GroupInquiryLocale; initialKind: GroupInquiryKind; context: InquiryContext }) {
  const text = TEXT[locale];
  const [kind, setKind] = useState<GroupInquiryKind>(initialKind);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [details, setDetails] = useState<Record<string, string>>({});
  const [interest, setInterest] = useState(context.experienceTitle ?? "");
  const [sending, setSending] = useState(false);
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [retryUntil, setRetryUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const alertBox = useRef<HTMLDivElement>(null);
  const receivedBox = useRef<HTMLDivElement>(null);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const waitSeconds = retryUntil === null ? 0 : Math.max(0, Math.ceil((retryUntil - now) / 1000));

  // The first touch's tracking values (utm_*), held in memory only and never in a cookie, honoring Do Not Track.
  useEffect(() => {
    captureBookingAttribution(window.location.search, navigator.doNotTrack);
  }, []);
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
    const control = problem.field ? document.getElementById(FIELD_ID(problem.field)) : null;
    (control ?? alertBox.current)?.focus();
  }, [problem]);
  useEffect(() => {
    if (accepted) receivedBox.current?.focus();
  }, [accepted]);

  const fields = GROUP_INQUIRY_FIELDS[kind];
  const budget = fields.some((field) => field.key === "budget");
  const line = contextLine(context, kind, locale);
  const keepSlug = context.experienceSlug !== null && interest.trim() === (context.experienceTitle ?? "").trim() && interest.trim() !== "";

  function detail(key: string, value: string) {
    setDetails((current) => ({ ...current, [key]: value }));
  }

  function problemFor(field: string | null): Problem {
    if (field === "kind" || field === "name" || field === "email" || field === "message") return { tone: "danger", title: text.problems[field], field };
    if (field?.startsWith("details.")) return { tone: "danger", title: text.problems.invalid, field: field.slice("details.".length) };
    return { tone: "danger", title: text.problems.invalid };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || sending || waitSeconds > 0) return;
    setProblem(null);
    const tracking = readBookingAttribution(navigator.doNotTrack);
    const draft = {
      kind,
      locale,
      name,
      email,
      message,
      details,
      entry: context.entry,
      experienceSlug: keepSlug ? context.experienceSlug : null,
      experienceTitle: interest.trim() === "" ? null : interest.trim().slice(0, GROUP_INQUIRY_LIMITS.experienceTitleMaxLength),
      hostName: context.hostName,
      utmSource: tracking.utmSource ?? null,
      utmMedium: tracking.utmMedium ?? null,
      utmCampaign: tracking.utmCampaign ?? null,
    };
    const checked = checkGroupInquiry(draft);
    if (!checked.ok) {
      setProblem(problemFor(checked.problem));
      return;
    }
    // The same content is resent with the same key (one inquiry on the server); any change gets a new key.
    const signature = JSON.stringify(draft);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: newRequestKey() };
    inFlight.current = true;
    setSending(true);
    try {
      const response = await fetch("/api/public/group-inquiries", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        referrerPolicy: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...draft, clientRequestKey: attempt.current.key }),
      });
      const body = (await response.json().catch(() => null)) as { accepted?: boolean; inquiryRef?: string; replyByDate?: string; error?: { code?: string; field?: string | null } } | null;
      if (response.status === 201 && body?.accepted === true && typeof body.inquiryRef === "string" && typeof body.replyByDate === "string") {
        setAccepted({ inquiryRef: body.inquiryRef, replyByDate: body.replyByDate });
        setName("");
        setEmail("");
        setMessage("");
        setDetails({});
        attempt.current = null;
        return;
      }
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        if (Number.isFinite(seconds) && seconds > 0) {
          const current = Date.now();
          setNow(current);
          setRetryUntil(current + seconds * 1000);
          setProblem({ tone: "warn", title: text.rateLimited, body: text.rateWait(Math.ceil(seconds)) });
        } else {
          setProblem({ tone: "warn", title: text.rateLimited, body: text.rateGeneric });
        }
        return;
      }
      if (response.status === 422 || response.status === 400) {
        setProblem(problemFor(body?.error?.field ?? null));
        return;
      }
      setProblem({ tone: "danger", title: text.failedTitle, body: text.failedBody });
    } catch {
      setProblem({ tone: "danger", title: text.failedTitle, body: text.failedBody });
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  function startAnother() {
    setAccepted(null);
    setProblem(null);
  }

  if (accepted) {
    return (
      <div ref={receivedBox} tabIndex={-1} role="status" className="rounded-[18px] border border-line bg-white p-5 outline-none sm:p-7">
        <h2 className="text-[1.5rem] leading-tight">{text.receivedTitle}</h2>
        <p className="mt-3">{text.receivedLead}</p>
        <dl className="mt-4 grid gap-1">
          <div className="flex flex-wrap gap-x-3">
            <dt className="font-extrabold">{text.reference}</dt>
            <dd className="font-mono">{accepted.inquiryRef}</dd>
          </div>
        </dl>
        <p className="mt-3">{text.replyBy(inquiryDateLabel(accepted.replyByDate, locale))}</p>
        <p className="mt-3 font-extrabold">{INQUIRY_NOT_BOOKED[locale]}</p>
        <p className="mt-3 text-sm text-ink-soft">{INQUIRY_FREE_NOTE[locale]}</p>
        <p className="mt-3 text-sm text-ink-soft">{text.spam}</p>
        <button type="button" onClick={startAnother} className={buttonClass("secondary", "mt-5 w-full sm:w-auto")}>{text.another}</button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-1">
      {line ? <p className="rounded-[14px] bg-leaf-pale px-4 py-3 font-extrabold text-moss">{line}{context.experienceTitle && context.entry === "EXPERIENCE" ? <span className="mt-0.5 block text-[0.9375rem] font-bold text-ink">{context.experienceTitle}</span> : null}</p> : null}
      {problem ? (
        <div ref={alertBox} tabIndex={-1} role="alert" className="mt-3 outline-none">
          <Notice tone={problem.tone} title={problem.title}>{problem.body}</Notice>
        </div>
      ) : null}

      <fieldset className="mt-4 min-w-0">
        <legend className="text-[0.90625rem] font-extrabold">{text.kind}</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {GROUP_INQUIRY_KINDS.map((value) => (
            <label key={value} className="relative block">
              <input type="radio" name="inquiry-kind" id={value === kind ? FIELD_ID("kind") : undefined} value={value} checked={kind === value} onChange={() => setKind(value)} className="peer absolute inset-0 z-[1] size-full cursor-pointer appearance-none rounded-[14px] opacity-0" />
              <span className="block min-h-11 cursor-pointer rounded-[14px] border border-line-strong bg-white px-4 py-2.5 peer-checked:border-moss peer-checked:bg-leaf-pale peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-moss">
                <span className="block font-extrabold">{INQUIRY_KIND_LABEL[value][locale]}</span>
                <span className="block text-[0.8125rem] text-ink-soft">{INQUIRY_KIND_HINT[value][locale]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
        {text.name} <small className="font-bold text-muted">（{text.required}）</small>
        <input id={FIELD_ID("name")} name="name" required autoComplete="name" maxLength={GROUP_INQUIRY_LIMITS.nameMaxLength} value={name} onChange={(event) => setName(event.target.value)} aria-invalid={problem?.field === "name" || undefined} className={BOOKING_FIELD_INPUT_CLASS_V1} />
      </label>
      <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
        {text.email} <small className="font-bold text-muted">（{text.required}）</small>
        <input id={FIELD_ID("email")} name="email" required type="email" inputMode="email" autoComplete="email" maxLength={GROUP_INQUIRY_LIMITS.emailMaxLength} value={email} onChange={(event) => setEmail(event.target.value)} aria-invalid={problem?.field === "email" || undefined} aria-describedby="inquiry-email-hint" className={BOOKING_FIELD_INPUT_CLASS_V1} />
        <small id="inquiry-email-hint" className="mt-1 block font-normal text-ink-soft">{text.emailHint}</small>
      </label>
      <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
        {text.message} <small className="font-bold text-muted">（{text.required}）</small>
        <textarea id={FIELD_ID("message")} name="message" required rows={5} maxLength={GROUP_INQUIRY_LIMITS.messageMaxLength} value={message} onChange={(event) => setMessage(event.target.value)} aria-invalid={problem?.field === "message" || undefined} aria-describedby="inquiry-message-hint" className={`${BOOKING_FIELD_INPUT_CLASS_V1} min-h-[130px] resize-y`} />
        <small id="inquiry-message-hint" className="mt-1 block font-normal text-ink-soft">{text.messageHint}</small>
      </label>

      <fieldset className="mt-4 min-w-0 rounded-[14px] border border-line p-4">
        <legend className="px-1 text-[0.90625rem] font-extrabold">{text.moreTitle}</legend>
        <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
          {text.interest}
          <input id={FIELD_ID("interest")} name="interest" maxLength={GROUP_INQUIRY_LIMITS.experienceTitleMaxLength} value={interest} onChange={(event) => setInterest(event.target.value)} className={BOOKING_FIELD_INPUT_CLASS_V1} />
          {context.experienceTitle ? <small className="mt-1 block font-normal text-ink-soft">{text.interestHint}</small> : null}
        </label>
        {fields.filter((field) => field.key !== "budget" && field.key !== "budgetUnit").map((field) => (
          <DetailField key={field.key} field={field} locale={locale} value={details[field.key] ?? ""} invalid={problem?.field === field.key} onChange={(value) => detail(field.key, value)} optional={text.optional} />
        ))}
        {budget ? (
          <div className="mt-3.5 grid gap-1">
            <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
              {INQUIRY_FIELD_LABEL.budget![locale]} <small className="font-bold text-muted">（{text.optional}）</small>
              <input id={FIELD_ID("budget")} name="budget" inputMode="text" maxLength={120} placeholder={INQUIRY_FIELD_PLACEHOLDER.budget?.[locale]} value={details.budget ?? ""} onChange={(event) => detail("budget", event.target.value)} aria-invalid={problem?.field === "budget" || undefined} className={BOOKING_FIELD_INPUT_CLASS_V1} />
            </label>
            <fieldset className="min-w-0">
              <legend className="sr-only">{INQUIRY_FIELD_LABEL.budgetUnit![locale]}</legend>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {BUDGET_UNITS.map((unit) => (
                  <label key={unit} className="relative">
                    <input type="radio" name="inquiry-budget-unit" id={unit === (details.budgetUnit ?? "") ? FIELD_ID("budgetUnit") : undefined} value={unit} checked={details.budgetUnit === unit} onChange={() => detail("budgetUnit", unit)} onClick={() => { if (details.budgetUnit === unit) detail("budgetUnit", ""); }} className="peer absolute inset-0 z-[1] size-full cursor-pointer appearance-none rounded-full opacity-0" />
                    <span className="inline-flex min-h-11 cursor-pointer items-center rounded-full border border-line-strong bg-white px-4 text-[0.9375rem] font-bold peer-checked:border-moss peer-checked:bg-leaf-pale peer-checked:text-moss peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-moss">{INQUIRY_CHOICE_LABEL[unit]![locale]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        ) : null}
      </fieldset>

      <button type="submit" disabled={sending || waitSeconds > 0} aria-busy={sending || undefined} className={buttonClass("primary", "mt-5 w-full")}>
        {sending ? text.sending : waitSeconds > 0 ? text.wait(waitSeconds) : text.send}
      </button>
      <p className="mt-3 text-[0.875rem] text-ink-soft">{INQUIRY_FREE_NOTE[locale]}</p>
      <p className="mt-1 text-[0.8125rem] text-muted">{INQUIRY_PRIVACY_NOTE[locale]}</p>
    </form>
  );
}

function DetailField({ field, locale, value, invalid, onChange, optional }: { field: GroupInquiryField; locale: GroupInquiryLocale; value: string; invalid: boolean; onChange: (value: string) => void; optional: string }) {
  const label = INQUIRY_FIELD_LABEL[field.key]?.[locale] ?? field.key;
  const hint = <small className="font-bold text-muted">（{optional}）</small>;
  if (field.type === "choice") {
    return (
      <fieldset className="mt-3.5 min-w-0">
        <legend className="text-[0.90625rem] font-extrabold">{label} {hint}</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {field.choices!.map((choice) => (
            <label key={choice} className="relative">
              <input type="radio" name={`inquiry-${field.key}`} id={choice === value ? FIELD_ID(field.key) : undefined} value={choice} checked={value === choice} onChange={() => onChange(choice)} onClick={() => { if (value === choice) onChange(""); }} className="peer absolute inset-0 z-[1] size-full cursor-pointer appearance-none rounded-full opacity-0" />
              <span className="inline-flex min-h-11 cursor-pointer items-center rounded-full border border-line-strong bg-white px-4 text-[0.9375rem] font-bold peer-checked:border-moss peer-checked:bg-leaf-pale peer-checked:text-moss peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-moss">{INQUIRY_CHOICE_LABEL[choice]?.[locale] ?? choice}</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  if (field.type === "longText") {
    return (
      <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
        {label} {hint}
        <textarea id={FIELD_ID(field.key)} name={field.key} rows={3} maxLength={field.maxLength} value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={invalid || undefined} className={`${BOOKING_FIELD_INPUT_CLASS_V1} min-h-[90px] resize-y`} />
      </label>
    );
  }
  return (
    <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
      {label} {hint}
      <input id={FIELD_ID(field.key)} name={field.key} maxLength={field.maxLength} placeholder={INQUIRY_FIELD_PLACEHOLDER[field.key]?.[locale]} value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={invalid || undefined} className={BOOKING_FIELD_INPUT_CLASS_V1} />
    </label>
  );
}
