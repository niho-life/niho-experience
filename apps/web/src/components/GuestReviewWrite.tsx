"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { BOOKING_FIELD_INPUT_CLASS_V1, BOOKING_FIELD_LABEL_CLASS_V1 } from "@niho/experience-presentation/v1";
import { createClientRequestKey } from "@niho-experience/api-client";
import { openReviewInvitation, reviewTokenFromFragment, submitGuestReview, type ReviewInvitationView, type ReviewSubmission } from "@/lib/guest-review";
import { ButtonLink, Notice, buttonClass } from "./ui";

type View =
  | { kind: "ready" }
  | { kind: "loading" }
  | { kind: "closed" }
  | { kind: "failed" }
  | { kind: "sent" }
  | { kind: "open"; invitation: ReviewInvitationView };

const JAPAN_TIME = new Intl.DateTimeFormat("en", {
  timeZone: "Asia/Tokyo", weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

/** The token never leaves memory except in same-origin POST bodies. No review text is placed in analytics or storage. */
export function GuestReviewWrite({ tags }: { tags: readonly { value: string; label: string }[] }) {
  const token = useRef<string | null>(null);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const alertBox = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [originLabel, setOriginLabel] = useState("");
  const [noteToHost, setNoteToHost] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    token.current = reviewTokenFromFragment(window.location.hash);
    if (window.location.hash) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    setView({ kind: token.current ? "ready" : "closed" });
  }, []);

  useEffect(() => {
    if (problem) alertBox.current?.focus();
  }, [problem]);

  async function open() {
    if (!token.current) return setView({ kind: "closed" });
    setView({ kind: "loading" });
    const result = await openReviewInvitation(token.current);
    setView(result.kind === "open" ? { kind: "open", invitation: result.invitation } : { kind: result.kind });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending || !token.current) return;
    const review: Omit<ReviewSubmission, "clientRequestKey"> = {
      language: "EN", rating, body: body.trim(), displayName: displayName.trim(), tags: selectedTags,
      originLabel: originLabel.trim() || null, noteToHost: noteToHost.trim() || null,
    };
    if (rating < 1 || rating > 5 || !review.body || review.body.length > 2000 || !review.displayName || review.displayName.length > 60) {
      setProblem("Please add a rating, a name and a review of up to 2,000 characters.");
      return;
    }
    setProblem(null);
    const signature = JSON.stringify(review);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: createClientRequestKey() };
    setSending(true);
    const result = await submitGuestReview(token.current, { ...review, clientRequestKey: attempt.current.key });
    setSending(false);
    if (result.kind === "sent") {
      token.current = null;
      setView({ kind: "sent" });
    } else if (result.kind === "closed" || result.kind === "used") {
      token.current = null;
      setView({ kind: "closed" });
    } else if (result.kind === "invalid") {
      setProblem("Please check your rating, name, review and note, then try again.");
    } else {
      setProblem("We couldn't save your review. Your words are still here, and trying again is safe.");
    }
  }

  if (view.kind === "ready" || view.kind === "loading") {
    return (
      <div className="container-page max-w-2xl py-12">
        <p className="hand text-[1.75rem]">your experience</p>
        <h1 className="mt-1 text-3xl">Write your review</h1>
        <p className="mt-3 text-ink-soft">Your link opens one review for one booking.</p>
        {view.kind === "ready" ? <button type="button" onClick={() => void open()} className={buttonClass("primary", "mt-6")}>Open your review</button>
          : <p role="status" aria-busy="true" className="mt-6 text-ink-soft">Opening your review…</p>}
      </div>
    );
  }

  if (view.kind === "sent") {
    return (
      <div className="container-page max-w-2xl py-12">
        <p className="hand text-[1.75rem]">thank you</p>
        <h1 className="mt-1 text-3xl">Review published</h1>
        <p role="status" className="mt-3 text-ink-soft">Thank you for sharing your experience with future guests.</p>
        <ButtonLink href="/experiences" variant="secondary">Browse experiences</ButtonLink>
      </div>
    );
  }

  if (view.kind === "closed" || view.kind === "failed") {
    return (
      <div className="container-page max-w-2xl py-12">
        <h1 className="text-3xl">{view.kind === "closed" ? "This review link can't be used" : "We couldn't open your review"}</h1>
        <p className="mt-3 text-ink-soft">{view.kind === "closed" ? "The link may have expired, been used, or no longer be available for this booking." : "Please try again in a moment. Your link is still here."}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          {view.kind === "failed" ? <button type="button" onClick={() => void open()} className={buttonClass("primary")}>Try again</button> : null}
          <ButtonLink href="/bookings" variant={view.kind === "closed" ? "primary" : "secondary"}>Find your booking</ButtonLink>
        </div>
      </div>
    );
  }

  const { invitation } = view;
  return (
    <div className="container-page max-w-2xl py-12">
      <p className="hand text-[1.75rem]">your experience</p>
      <h1 className="mt-1 text-3xl">Review {invitation.experienceTitle}</h1>
      <p className="mt-3 text-ink-soft">Hosted by {invitation.hostDisplayName} · <time dateTime={invitation.sessionStartUtc}>{JAPAN_TIME.format(new Date(invitation.sessionStartUtc))} Japan time</time></p>
      <p className="mt-3 text-ink-soft">Your review will be public as soon as you send it. You can send one review with this link.</p>
      <form onSubmit={(event) => void submit(event)} noValidate className="mt-8 space-y-6">
        {problem ? <div ref={alertBox} tabIndex={-1} role="alert" className="outline-none"><Notice tone="danger" title={problem} /></div> : null}
        <fieldset>
          <legend className={BOOKING_FIELD_LABEL_CLASS_V1}>Your rating</legend>
          <div className="mt-2 flex flex-wrap gap-3">
            {[5, 4, 3, 2, 1].map((value) => (
              <label key={value} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2">
                <input type="radio" name="rating" value={value} checked={rating === value} onChange={() => setRating(value)} disabled={sending} />
                {value} {value === 1 ? "star" : "stars"}
              </label>
            ))}
          </div>
        </fieldset>
        <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
          Your name on the review
          <input className={BOOKING_FIELD_INPUT_CLASS_V1} value={displayName} maxLength={60} required onChange={(event) => setDisplayName(event.target.value)} disabled={sending} />
        </label>
        <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
          Your review
          <textarea className={`${BOOKING_FIELD_INPUT_CLASS_V1} min-h-[140px] resize-y`} rows={5} value={body} maxLength={2000} required onChange={(event) => setBody(event.target.value)} disabled={sending} />
        </label>
        <fieldset>
          <legend className={BOOKING_FIELD_LABEL_CLASS_V1}>What stood out? (optional)</legend>
          <div className="mt-2 flex flex-wrap gap-3">
            {tags.map((tag) => (
              <label key={tag.value} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2">
                <input type="checkbox" checked={selectedTags.includes(tag.value)} onChange={(event) => setSelectedTags((current) => event.target.checked ? [...current, tag.value] : current.filter((value) => value !== tag.value))} disabled={sending} />
                {tag.label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
          Where you&apos;re from (optional, public)
          <input className={BOOKING_FIELD_INPUT_CLASS_V1} value={originLabel} maxLength={60} onChange={(event) => setOriginLabel(event.target.value)} disabled={sending} />
        </label>
        <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
          A private note to your host (optional)
          <textarea className={`${BOOKING_FIELD_INPUT_CLASS_V1} min-h-[90px] resize-y`} rows={3} value={noteToHost} maxLength={500} onChange={(event) => setNoteToHost(event.target.value)} disabled={sending} />
        </label>
        <button type="submit" disabled={sending} aria-busy={sending || undefined} className={buttonClass("primary", "w-full sm:w-auto")}>{sending ? "Publishing…" : "Publish review"}</button>
      </form>
    </div>
  );
}
