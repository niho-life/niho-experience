import Link from "next/link";
import type { PublicPerson } from "@niho-experience/experience-store";
import { Photo } from "../Photo";
import { buttonClass } from "../ui";

/**
 * 街の人（#564・#563）：1人の紹介、顔の並び、「街の人 ◯人」への入口。載せる人が0人のときは、呼ぶ側が出さない。
 * 紹介する人は事務局が選ぶ（`JA_HOME_FEATURED_PERSON_SLUG`）。
 */
export function PeopleBand({ featured, people, facesLimit }: { featured: PublicPerson; people: readonly PublicPerson[]; facesLimit: number }) {
  const faces = people.slice(0, facesLimit);
  return <section aria-labelledby="people-band" className="bg-sand py-14 sm:py-16">
    <div className="container-page grid gap-8 md:grid-cols-[minmax(0,16rem)_1fr] md:items-center md:gap-12">
      <Link href={`/ja/people/${featured.slug}`} aria-label={`${featured.name}さんのページ`} className="mx-auto block w-full max-w-[16rem] md:mx-0">
        <Photo image={{ url: featured.photo.src, alt: featured.photo.altJa }} alt={featured.photo.altJa} sizes="(min-width: 768px) 256px, 70vw" aspect="aspect-[4/5]" rounded="rounded-[18px]" />
      </Link>
      <div>
        <span className="hand text-[1.5rem] text-moss">neighbors</span>
        <h2 id="people-band" className="text-[1.75rem] leading-snug sm:text-[2.25rem]">街の人</h2>
        <p className="mt-3 text-[1.25rem] font-extrabold">{featured.name}</p>
        <p className="text-ink-soft">{featured.roleJa}・{featured.areaJa}</p>
        {featured.quoteJa ? <p className="mt-4 text-[1.1875rem] leading-snug">「{featured.quoteJa}」</p> : null}
        {featured.introJa ? <p className="mt-3 line-clamp-3 max-w-[40rem] text-ink-soft">{featured.introJa}</p> : null}
        <div className="mt-5"><Link href={`/ja/people/${featured.slug}`} className={buttonClass("primary", "max-sm:w-full")}>この人に会いにいく</Link></div>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <ul className="flex flex-wrap gap-2" aria-label="街の人">
            {faces.map((person) => <li key={person.slug}>
              <Link href={`/ja/people/${person.slug}`} aria-label={person.name} className={`block size-12 overflow-hidden rounded-full border-2 ${person.slug === featured.slug ? "border-moss" : "border-white"}`}>
                <Photo image={{ url: person.photo.src, alt: person.photo.altJa }} alt="" sizes="48px" aspect="aspect-square" rounded="rounded-full" />
              </Link>
            </li>)}
          </ul>
          <Link href="/ja/people" className="font-extrabold underline underline-offset-4">街の人 {people.length}人</Link>
        </div>
      </div>
    </div>
  </section>;
}
