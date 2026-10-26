import Link from "next/link";
import { Pill } from "@/components/ui";
import type { Guide } from "@/lib/guides/types";

/**
 * Guides that recommend this experience (their `experiences`), at most three. It follows the detail view,
 * in its main column, with the same section heading as the sections above it.
 */
export function ReadBeforeYouGo({ guides }: { guides: Guide[] }) {
  if (!guides.length) return null;
  return (
    <div className="container-page">
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-[72px]">
        <section aria-labelledby="read-before-you-go" className="pt-12">
          <h2 id="read-before-you-go" className="mb-[18px] text-[1.75rem] lg:text-[2rem]">Read before you go</h2>
          <ul className="divide-y divide-line border-y border-line">
            {guides.map((guide) => (
              <li key={guide.slug} className="py-4">
                {guide.draft ? <p className="mb-1"><Pill tone="warn">Draft</Pill></p> : null}
                <Link href={`/guides/${guide.slug}`} className="link-leaf text-[1.0625rem]">{guide.title}</Link>
                <p className="mt-1.5 text-[0.9375rem] text-ink-soft">{guide.description}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
