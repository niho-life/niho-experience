"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { REVIEW_LIMITS, type ExperienceReview, type JourneyReviews } from "@niho-experience/api-client";
import { getBrowserApi } from "@/lib/browser-api";
import { initialOf } from "@/lib/card-model";
import { averageLabel, countLabel, monthYear, ratingLabel, reviewDisplay } from "@/lib/reviews-ui";
import { HandIcon } from "./HandIcon";
import { Notice, buttonClass } from "./ui";

/** Filled stars out of five for a rating or an average. The meaning is in the spoken label; the glyphs are decoration. */
function Stars({ rating }: { rating: number }) {
  const filled = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <span className="inline-flex items-center">
      <span aria-hidden className="text-[0.9375rem] tracking-[1px] text-moss">{"★".repeat(filled)}<span className="text-line-strong">{"★".repeat(5 - filled)}</span></span>
      <span className="sr-only">{ratingLabel(rating)}</span>
    </span>
  );
}

/** One written review. `showStars` is off while there are fewer than three reviews: then only the count and the words are shown. */
function ReviewItem({ item, showStars }: { item: ExperienceReview; showStars: boolean }) {
  const where = [item.originLabel, monthYear(item.publishedAt)].filter(Boolean).join(" · ");
  return (
    <article className="py-5">
      <header className="flex items-center gap-3">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-leaf-pale font-extrabold text-moss">{initialOf(item.displayName)}</span>
        <div className="min-w-0">
          <b className="block leading-tight font-extrabold">{item.displayName}</b>
          {where ? <small className="block text-[0.8125rem] text-muted">{where}</small> : null}
        </div>
      </header>
      {showStars || item.fromBooking ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {showStars ? <Stars rating={item.rating} /> : null}
          {item.fromBooking ? (
            <span className="inline-flex items-center gap-1 text-[0.75rem] font-extrabold text-moss">
              <HandIcon name="check" className="size-4" />
              Booked on NIHO
            </span>
          ) : null}
        </p>
      ) : null}
      <p className="mt-2 whitespace-pre-line">{item.body}</p>
      {item.reply ? (
        <div className="mt-3 rounded-xl bg-sand px-3.5 py-3 text-[0.875rem] text-ink-soft">
          <b className="block text-[0.8125rem] font-extrabold text-ink">Reply from {item.reply.hostName}</b>
          {item.reply.body}
        </div>
      ) : null}
    </article>
  );
}

type All = { status: "idle" | "loading" | "error" } | { status: "ready"; items: ExperienceReview[] };

/** "Show all N reviews": a dialog like the photos, read from NIHO when it is opened (the page itself carries only the newest). */
function AllReviews({ slug, count, showStars, preview, nihoWebOrigin }: { slug: string; count: number; showStars: boolean; preview: boolean; nihoWebOrigin: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [all, setAll] = useState<All>({ status: "idle" });

  async function load() {
    setAll({ status: "loading" });
    try {
      const api = await getBrowserApi(preview, nihoWebOrigin);
      const result = await api.listReviews(slug, { limit: REVIEW_LIMITS.listMaxItems });
      setAll(result.ok ? { status: "ready", items: result.data.reviews } : { status: "error" });
    } catch {
      setAll({ status: "error" });
    }
  }
  function open() {
    dialog.current?.showModal();
    if (all.status === "idle" || all.status === "error") void load();
  }
  const close = () => dialog.current?.close();

  return (
    <>
      <button type="button" onClick={open} className={buttonClass("secondary", "mt-4 w-full sm:w-auto")}>Show all {count} reviews</button>
      <dialog
        ref={dialog}
        aria-labelledby={headingId}
        onClick={(event) => { if (event.target === event.currentTarget) close(); }}
        className="m-auto max-h-[90dvh] w-[min(40rem,calc(100vw_-_2rem))] overflow-y-auto rounded-3xl bg-white p-0 text-ink backdrop:bg-black/60"
      >
        <div className="sticky top-0 z-[2] flex items-center justify-between gap-4 border-b border-line bg-white px-6 py-4">
          <h2 id={headingId} className="text-2xl">All reviews</h2>
          <button type="button" onClick={close} className="rounded-full px-4 py-2 text-sm font-extrabold shadow-[inset_0_0_0_1.5px_var(--color-ink)] hover:bg-sand">Close</button>
        </div>
        <div className="px-6 pb-6">
          {all.status === "ready" ? (
            <ul className="divide-y divide-line">
              {all.items.map((item) => <li key={item.id}><ReviewItem item={item} showStars={showStars} /></li>)}
            </ul>
          ) : all.status === "error" ? (
            <div className="pt-5">
              <Notice role="alert" tone="warn" title="Reviews can't be loaded right now" action={<button type="button" onClick={() => void load()} className="font-bold text-moss underline underline-offset-4">Try again</button>} />
            </div>
          ) : (
            <p role="status" className="pt-5 text-muted">Loading reviews…</p>
          )}
        </div>
      </dialog>
    </>
  );
}

/**
 * The content of the "Reviews" section (the heading comes with the presentation's section). Epic #103 / niho-experience#104,
 * niho-coliving/niho-app#19314: reviews come from guests who booked, NIHO checks them before they appear, and the host
 * may reply once. Mock only until NIHO's review API exists (`config.journeyApi`).
 */
export function ReviewsSection({ slug, reviews, preview, nihoWebOrigin }: { slug: string; reviews: JourneyReviews; preview: boolean; nihoWebOrigin: string }) {
  const router = useRouter();
  const display = reviewDisplay(reviews);
  if (reviews.status === "unavailable") {
    return <Notice role="alert" tone="warn" title="Reviews can't be loaded right now" action={<button type="button" onClick={() => router.refresh()} className="font-bold text-moss underline underline-offset-4">Try again</button>} />;
  }
  const { summary, items } = reviews;
  if (display.kind === "none") {
    return (
      <div className="rounded-[18px] border border-dashed border-line-strong p-5 text-center">
        <span className="hand block text-[1.5rem]">be one of the first</span>
        <p className="mt-1 text-[0.9375rem] text-ink-soft">Reviews appear here after guests who booked share how it went.</p>
      </div>
    );
  }
  const rated = display.kind === "rated";
  return (
    <>
      {rated ? (
        <div>
          <div className="flex items-end gap-3">
            <span className="font-display text-[3rem] leading-none font-light">{averageLabel(display.average)}</span>
            <div>
              <Stars rating={display.average} />
              <p className="text-[0.8125rem] text-muted">{countLabel(display.count)} from guests who booked</p>
            </div>
          </div>
          {summary.tags.length ? (
            <ul className="mt-3.5 flex flex-wrap gap-2" aria-label="What guests liked">
              {summary.tags.map((tag) => <li key={tag.label} className="rounded-full bg-sand px-3 py-1 text-[0.8125rem] font-bold text-ink-soft">{tag.label} · {tag.count}</li>)}
            </ul>
          ) : null}
        </div>
      ) : (
        <p className="font-extrabold">{countLabel(summary.count)} from guests who booked</p>
      )}
      <ul className="mt-2 divide-y divide-line">
        {items.map((item) => <li key={item.id}><ReviewItem item={item} showStars={rated} /></li>)}
      </ul>
      {summary.count > items.length ? <AllReviews slug={slug} count={summary.count} showStars={rated} preview={preview} nihoWebOrigin={nihoWebOrigin} /> : null}
    </>
  );
}
