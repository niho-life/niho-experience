import Link from "next/link";
import { Photo } from "@/components/Photo";
import { Pill } from "@/components/ui";
import { formatGuideDate } from "@/lib/guides/guide";
import type { Guide } from "@/lib/guides/types";

/** One guide on /guides and under "More guides": the title's link covers the card. */
export function GuideCard({ guide }: { guide: Guide }) {
  return (
    <article className="group relative flex h-full min-w-0 flex-col">
      <Photo image={{ url: guide.hero }} alt={guide.heroAlt} aspect="aspect-[3/2]" sizes="(min-width: 64rem) 360px, (min-width: 40rem) 50vw, 100vw" />
      <div className="flex flex-1 flex-col pt-3">
        {guide.draft ? <p className="mb-1.5"><Pill tone="warn">Draft</Pill></p> : null}
        <h3 className="text-[1.375rem] leading-[1.18]">
          <Link href={`/guides/${guide.slug}`} className="bg-[linear-gradient(var(--color-leaf),var(--color-leaf))] bg-[length:0_3px] bg-[position:0_100%] bg-no-repeat transition-[background-size] duration-300 group-hover:bg-[length:100%_3px] after:absolute after:inset-0">
            {guide.title}
          </Link>
        </h3>
        <p className="mt-2 text-[0.9375rem] text-ink-soft">{guide.description}</p>
        <p className="mt-auto pt-2.5 text-sm text-muted">
          Updated <time dateTime={guide.updated}>{formatGuideDate(guide.updated)}</time>
        </p>
      </div>
    </article>
  );
}
