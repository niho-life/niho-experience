import Link from "next/link";
import type { ReactNode } from "react";
import type { PublicPerson } from "@niho-experience/experience-store";
import { Photo } from "../Photo";
import { buttonClass } from "../ui";
import { inquiryHref } from "@/lib/group-inquiry-entry";

/** 日本語トップの、写真と文字だけで出来るまとまり（#563）。体験のカードを並べるまとまりは `page.tsx` が持つ。 */

export function JapaneseHeroCopy({ title, hand, lead }: { title: string; hand: string; lead: string }) {
  const [first, second] = title.split("、");
  return <>
    <h1 className="text-[2.25rem] leading-[1.25] font-semibold sm:text-[3.25rem]">{second ? <>{first}、<br />{second}</> : title}<span className="hand mt-1 block text-[1.75rem] font-normal text-white/90 sm:text-[2.25rem]">{hand}</span></h1>
    <p className="mt-4 max-w-[34rem] text-[1.0625rem] leading-relaxed text-white [text-shadow:0_1px_10px_rgba(0,0,0,0.5)]">{lead}</p>
    <div className="mt-6"><Link href="/ja/experiences" className={buttonClass("primary")}>体験をさがす</Link></div>
  </>;
}

export function PicksHeading({ total }: { total: number }) {
  return <div className="flex flex-wrap items-end justify-between gap-3">
    <div><span className="hand text-[1.5rem] text-moss">our picks</span><h2 className="text-[1.75rem] sm:text-[2rem]">おすすめの体験</h2></div>
    <Link href="/ja/experiences" className="font-extrabold underline underline-offset-4">{total}件の体験をすべて見る</Link>
  </div>;
}

function Band({ id, hand, title, children, tone }: { id: string; hand: string; title: ReactNode; children: ReactNode; tone: "leaf" | "sand" }) {
  return <section aria-labelledby={id} className="container-page my-14 sm:my-16">
    <div className={`rounded-[22px] px-6 py-9 sm:px-12 sm:py-12 ${tone === "leaf" ? "bg-leaf-pale" : "bg-sand"}`}>
      <span className="hand text-[1.5rem] text-moss">{hand}</span>
      <h2 id={id} className="text-[1.75rem] leading-snug sm:text-[2.25rem]">{title}</h2>
      {children}
    </div>
  </section>;
}

/** 相談：載っていないことも相談できる。学校・法人への入口を添える（#532）。 */
export function ConsultBand() {
  return <Band id="consult-band" hand="ask the town" title={<>載っていないことも、<br className="sm:hidden" />相談できます。</>} tone="leaf">
    <p className="mt-3 max-w-[40rem] text-ink-soft">学校や会社、グループでの参加、探している体験や人のこと。体験を選び切れなくても、日にちが決まっていなくても大丈夫です。目的を聞かせてください。はじめの相談は無料です。</p>
    <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
      <a href={inquiryHref("ja")} className={buttonClass("primary", "w-full sm:w-auto")}>相談する</a>
      <Link href="/ja/schools" className="font-extrabold underline underline-offset-4">学校の方へ</Link>
      <Link href="/ja/business" className="font-extrabold underline underline-offset-4">法人・団体の方へ</Link>
    </div>
  </Band>;
}

/** 体験を載せる：ホストの募集。 */
export function HostBand() {
  return <Band id="host-band" hand="share your craft" title={<>あなたの体験を、<br className="sm:hidden" />街の外の人へ。</>} tone="sand">
    <p className="mt-3 max-w-[40rem] text-ink-soft">予約の受付やお客さんとのやりとりは、事務局が引き受けます。開ける日を教えてもらえれば、あとは当日だけ。</p>
    <div className="mt-6"><Link href="/ja/host" className={buttonClass("secondary", "w-full sm:w-auto")}>体験を載せる</Link></div>
  </Band>;
}

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
        <div className="mt-5"><Link href={`/ja/people/${featured.slug}`} className={buttonClass("primary", "w-full sm:w-auto")}>この人に会いにいく</Link></div>
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
