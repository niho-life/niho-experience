import Link from "next/link";
import type { Guide, GuideFaqItem } from "@/content/guides";
import type { CardModel } from "@/lib/card-model";
import type { GuideDraftProblem } from "@/lib/guide-drafts";
import { parseGuideAnswer } from "@/lib/guide-markdown";
import { formatGuideDate } from "@/lib/guides";
import { ExperienceCard } from "./ExperienceCard";
import { GuideInlines } from "./GuideBody";
import { Notice, Pill } from "./ui";

/**
 * A list of guides: the title (a link), the description, the updated date and the author. Used by /guides and the related
 * blocks. Guides shown from a draft (preview only) carry a "Draft" pill above the title.
 */
export function GuideTeasers({ guides, level = 3, draftSlugs = [] }: { guides: readonly Guide[]; level?: 2 | 3; draftSlugs?: readonly string[] }) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <ul className="border-b border-line">
      {guides.map((guide) => (
        <li key={guide.slug} className="border-t border-line py-5">
          {draftSlugs.includes(guide.slug) ? (
            <p className="mb-2">
              <Pill tone="warn">Draft</Pill>
            </p>
          ) : null}
          <Heading className={level === 2 ? "text-[1.625rem] leading-[1.2]" : "font-sans text-[1.1875rem] leading-[1.35] font-extrabold tracking-normal"}>
            <Link href={`/guides/${guide.slug}`} className="underline-offset-4 hover:underline">
              {guide.title}
            </Link>
          </Heading>
          <p className="mt-1.5 text-ink-soft">{guide.description}</p>
          <p className="mt-2 text-sm text-muted">
            Updated <time dateTime={guide.updatedAt}>{formatGuideDate(guide.updatedAt)}</time> · by {guide.author.name}
          </p>
        </li>
      ))}
    </ul>
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

/** Questions and answers: an h2, then one h3 per question and its short answer (inline formatting only), all in the server HTML. */
export function GuideFaq({ title, items }: { title: string; items: readonly GuideFaqItem[] }) {
  if (!items.length) return null;
  return (
    <section aria-labelledby="guide-faq-heading" className="pt-12">
      <h2 id="guide-faq-heading" className="mb-[18px] text-[1.75rem] lg:text-[2rem]">
        {title}
      </h2>
      <div className="border-t border-line">
        {items.map((item) => (
          <div key={item.question} className="border-b border-line py-4">
            <h3 className="font-sans text-[1.0625rem] leading-[1.5] font-extrabold tracking-normal">{item.question}</h3>
            <p className="mt-1.5 text-ink-soft">
              <GuideInlines items={parseGuideAnswer(item.answer)} />
            </p>
          </div>
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
