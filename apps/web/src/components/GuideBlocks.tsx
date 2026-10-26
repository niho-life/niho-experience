import NextImage from "next/image";
import Link from "next/link";
import type { Guide, GuideFaqItem } from "@/content/guides";
import type { CardModel } from "@/lib/card-model";
import type { GuideDraftProblem } from "@/lib/guide-drafts";
import { imageAlt } from "@/lib/experience-copy";
import { parseGuideAnswer } from "@/lib/guide-markdown";
import { formatGuideDate, guideReadMinutes } from "@/lib/guides";
import { CardDates, type CardDatesSource } from "./CardDates";
import { ExperienceCard } from "./ExperienceCard";
import { GuideInlines } from "./GuideBody";
import { Notice, Pill } from "./ui";

/**
 * A list of guides: the title (a link), the description, the updated date and the author. Used by /guides and the related
 * blocks. Guides shown from a draft (preview only) carry a "Draft" pill above the title.
 */
export function GuideTeasers({ guides, level = 3, draftSlugs = [], columns = "one", descriptions = true, variant = "default" }: { guides: readonly Guide[]; level?: 2 | 3; draftSlugs?: readonly string[]; columns?: "one" | "three"; descriptions?: boolean; variant?: "default" | "detail" }) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <ul className={columns === "three" ? "grid gap-3 md:grid-cols-3" : "grid gap-3"}>
      {guides.map((guide) => (
        <li key={guide.slug} className="rounded-[var(--radius-card)] border border-line bg-white p-4 shadow-[0_1px_2px_rgb(28_28_26/0.03)] sm:p-5">
          {draftSlugs.includes(guide.slug) ? (
            <p className="mb-2">
              <Pill tone="warn">Draft</Pill>
            </p>
          ) : null}
          {variant === "detail" ? <p className="eyebrow mb-2">Guide · {guideReadMinutes(guide)} min</p> : null}
          <Heading className={level === 2 ? "text-[1.625rem] leading-[1.2]" : "font-sans text-[1.1875rem] leading-[1.35] font-extrabold tracking-normal"}>
            <Link href={`/guides/${guide.slug}`} className="underline-offset-4 hover:underline">
              {guide.title}
            </Link>
          </Heading>
          {descriptions ? <p className="mt-1.5 text-[0.9375rem] text-ink-soft">{guide.description}</p> : null}
          {variant !== "detail" ? <p className="mt-2 text-sm text-muted">
            {guideReadMinutes(guide)} min · {guide.checkedAt ? "Checked" : "Updated"}{" "}
            <time dateTime={guide.checkedAt ?? guide.updatedAt}>{formatGuideDate(guide.checkedAt ?? guide.updatedAt)}</time>
          </p> : null}
        </li>
      ))}
    </ul>
  );
}

/** A compact in-article CTA. Every variable fact comes from the same CardModel/CardDates path as public experience cards. */
export function GuideExperienceCta({ card, dates }: { card: CardModel; dates: CardDatesSource }) {
  return (
    <aside aria-label={`Experience: ${card.title}`} className="mt-8 rounded-[var(--radius-card)] border border-line bg-sand p-4 sm:p-5">
      <div className={`grid items-start gap-4${card.cover ? " sm:grid-cols-[96px_1fr]" : ""}`}>
        {card.cover ? (
          <NextImage src={card.cover.url} alt={imageAlt(card.cover, card.title)} width={192} height={144} unoptimized className="aspect-[4/3] w-24 rounded-xl object-cover" />
        ) : null}
        <div className="min-w-0">
          <p className="eyebrow text-[1.25rem]">Experience</p>
          <h3 className="mt-1 font-sans text-[1.0625rem] leading-snug font-extrabold tracking-normal">
            <Link href={`/experiences/${card.slug}`} className="hover:underline">{card.title}</Link>
          </h3>
          <p className="mt-1 text-sm text-ink-soft">
            {card.priceIsFrom ? "From " : ""}{card.priceLabel} / adult · {card.durationLabel}{card.language ? ` · ${card.language.short}` : ""}
          </p>
          <CardDates slug={card.slug} scheduleLabel={card.scheduleLabel} source={dates} />
          <Link href={`/experiences/${card.slug}`} className="link-leaf mt-2 inline-block text-sm">See experience</Link>
        </div>
      </div>
    </aside>
  );
}

/** Experience cards in the list's grid (one column on phones, two on tablets, three on desktops). */
export function ExperienceCardGrid({ cards }: { cards: readonly CardModel[] }) {
  return (
    <ul className="grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((card) => (
        <li key={card.slug}>
          <ExperienceCard card={card} />
        </li>
      ))}
    </ul>
  );
}

/** Questions and answers: an h2, then native details/summary rows (inline formatting only), all in the server HTML. */
export function GuideFaq({ title, items }: { title: string; items: readonly GuideFaqItem[] }) {
  if (!items.length) return null;
  return (
    <section aria-labelledby="guide-faq-heading" className="pt-12">
      <h2 id="guide-faq-heading" className="mb-[18px] text-[1.75rem] lg:text-[2rem]">
        {title}
      </h2>
      <div className="border-t border-line">
        {items.map((item) => (
          <details key={item.question} className="group border-b border-line">
            <summary className="cursor-pointer list-none py-4 text-ink [&::-webkit-details-marker]:hidden">
              <h3 className="flex items-center justify-between gap-4 font-sans text-[1.0625rem] leading-[1.5] font-extrabold tracking-normal">
                <span>{item.question}</span><span aria-hidden className="text-xl text-moss group-open:rotate-45">+</span>
              </h3>
            </summary>
            <p className="pb-4 text-ink-soft">
              <GuideInlines items={parseGuideAnswer(item.answer)} />
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}

/** Preview only: the drafts that /guides could not show, each with its reasons, so the writer can fix the file. */
export function GuideDraftProblems({ problems }: { problems: readonly GuideDraftProblem[] }) {
  if (!problems.length) return null;
  return (
    <Notice tone="warn" title={problems.length === 1 ? "1 draft is not shown" : `${problems.length} drafts are not shown`}>
      <p>Fix these files and reload. Only this preview lists them.</p>
      <ul className="mt-2 space-y-2 [overflow-wrap:anywhere]">
        {problems.map((problem) => (
          <li key={problem.file}>
            <b className="font-extrabold text-ink">{problem.file}</b>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
              {problem.reasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Notice>
  );
}
