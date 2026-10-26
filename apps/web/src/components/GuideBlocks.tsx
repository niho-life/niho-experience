import Link from "next/link";
import type { Guide, GuideFaqItem } from "@/content/guides";
import type { CardModel } from "@/lib/card-model";
import { formatGuideDate } from "@/lib/guides";
import { ExperienceCard } from "./ExperienceCard";

/** A list of guides: the title (a link), the description, the updated date and the author. Used by /guides and the related blocks. */
export function GuideTeasers({ guides, level = 3 }: { guides: readonly Guide[]; level?: 2 | 3 }) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <ul className="border-b border-line">
      {guides.map((guide) => (
        <li key={guide.slug} className="border-t border-line py-5">
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

/** Questions and answers: an h2, then one h3 per question and its short answer. Plain text, all in the server HTML. */
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
            <p className="mt-1.5 whitespace-pre-line text-ink-soft">{item.answer}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
