import Link from "next/link";
import type { ReactNode } from "react";
import type { PublicPerson } from "@niho-experience/experience-store";
import { EXPERIENCE_COMPANIONS, type ExperienceCategoryId } from "@niho-experience/experience-domain";
import type { Guide } from "@/content/guides";
import { guideLinkHref } from "@/lib/guide-markdown";
import { occasionHref, type HomeFeature, type HomeOccasion } from "@/lib/ja-home";
import { CategoryIcon } from "../ja/CategoryIcon";
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

/** 読みもの（#154・#563）：公開中の日本語の記事を数本。記事が無いときは、呼ぶ側が出さない。 */
export function GuidesBand({ guides }: { guides: readonly Guide[] }) {
  return <section aria-labelledby="guides-band" className="container-page my-14 sm:my-16">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><span className="hand text-[1.5rem] text-moss">field notes</span><h2 id="guides-band" className="text-[1.75rem] sm:text-[2rem]">読みもの</h2></div>
      <Link href="/ja/guides" className="font-extrabold underline underline-offset-4">すべて見る</Link>
    </div>
    <ul className="mt-6 grid gap-x-5 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
      {guides.map((guide) => <li key={guide.slug}>
        <Link href={`/ja/guides/${guide.slug}`} className="group block">
          <Photo image={guide.hero ? { url: guideLinkHref(guide.hero.src)?.href ?? guide.hero.src, alt: guide.hero.alt } : null} alt={guide.hero?.alt ?? ""} sizes="(min-width: 1024px) 320px, (min-width: 640px) 45vw, 90vw" aspect="aspect-[3/2]" rounded="rounded-[18px]" />
          {guide.category ? <span className="mt-3 block text-[0.8125rem] font-extrabold text-moss">{guide.category.labelJa ?? guide.category.label}</span> : null}
          <span className="mt-1 block text-[1.125rem] leading-snug font-extrabold group-hover:underline">{guide.title}</span>
          {guide.description ? <span className="mt-1 block text-[0.9375rem] text-ink-soft">{guide.description}</span> : null}
        </Link>
      </li>)}
    </ul>
  </section>;
}

/** さがす欄（なにをする／だれと）：JS なしで動く GET フォーム。一覧（`/ja/experiences`）の `category`・`with` に渡す。 */
export function HomeFinder({ categories }: { categories: readonly { id: string; label: string }[] }) {
  const field = "mt-0.5 block w-full min-w-0 bg-transparent text-[1rem] font-extrabold text-ink outline-none";
  return <form method="get" action="/ja/experiences" role="search" aria-label="体験をさがす" className="container-page relative z-10 -mt-7">
    <div className="grid gap-3 rounded-[22px] border border-line bg-white p-4 shadow-[0_10px_30px_rgba(0,0,0,0.08)] sm:grid-cols-[1fr_1fr_auto] sm:items-center sm:gap-4 sm:p-5">
      <label className="block rounded-xl bg-sand/60 px-4 py-2.5"><small className="block text-[0.75rem] font-bold text-ink-soft">なにをする</small>
        <select name="category" defaultValue="" className={field}><option value="">すべての体験</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      </label>
      <label className="block rounded-xl bg-sand/60 px-4 py-2.5"><small className="block text-[0.75rem] font-bold text-ink-soft">だれと</small>
        <select name="with" defaultValue="" className={field}><option value="">決めていない</option>{EXPERIENCE_COMPANIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      </label>
      <button type="submit" className={buttonClass("primary", "w-full sm:w-auto")}>さがす</button>
    </div>
  </form>;
}

/** カテゴリーの並び（アイコンつき）。公開中の体験があるカテゴリーだけ（呼ぶ側が絞る）。 */
export function CategoryNav({ categories }: { categories: readonly { id: string; label: string }[] }) {
  return <nav aria-label="カテゴリー" className="container-page mt-6">
    <ul className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
      {categories.map((item) => <li key={item.id} className="shrink-0">
        <Link href={`/ja/experiences?category=${item.id}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line-strong bg-white px-4 text-[0.9375rem] font-bold hover:bg-sand">
          <CategoryIcon id={item.id as ExperienceCategoryId} className="size-[1.125rem] text-moss" />{item.label}
        </Link>
      </li>)}
    </ul>
  </nav>;
}

/** 特集：1つのテーマの紹介と一覧への入口（写真は権利の確認できた既存の素材）。 */
export function FeatureBand({ feature }: { feature: HomeFeature }) {
  return <section aria-labelledby="feature-band" className="container-page my-14 sm:my-16">
    <div className="grid items-center gap-8 md:grid-cols-2 md:gap-12">
      <div>
        <span className="hand text-[1.5rem] text-moss">{feature.hand}</span>
        <h2 id="feature-band" className="text-[1.75rem] leading-snug sm:text-[2.25rem]">{feature.title[0]}<br />{feature.title[1]}</h2>
        <p className="mt-3 max-w-[34rem] text-ink-soft">{feature.text}</p>
        <div className="mt-6"><Link href={`/ja/experiences?category=${feature.categoryId}`} className={buttonClass("primary", "w-full sm:w-auto")}>{feature.cta}</Link></div>
      </div>
      <ul className="grid grid-cols-3 gap-2" aria-hidden="true">
        {feature.photos.map((photo) => <li key={photo.src}><Photo image={{ url: photo.src, alt: "" }} alt="" sizes="(min-width: 768px) 20vw, 30vw" aspect="aspect-[3/4]" rounded="rounded-[14px]" imgClassName="" /></li>)}
      </ul>
    </div>
  </section>;
}

/** どんな日に行きますか：絞り込んだ一覧への入口。該当する体験があるものだけ（呼ぶ側が絞る）。 */
export function OccasionStrips({ items }: { items: readonly HomeOccasion[] }) {
  return <section aria-labelledby="occasion-band" className="container-page my-14 sm:my-16">
    <span className="hand text-[1.5rem] text-moss">pick your day</span>
    <h2 id="occasion-band" className="text-[1.75rem] sm:text-[2rem]">どんな日に行きますか</h2>
    {/* 共有の presentation の `.nexp-v1 .grid-cols-2` は特異性が高く、`sm:grid-cols-3` を打ち消す。列の数は任意値で書く。 */}
    <ul className="mt-6 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3 sm:grid-cols-[repeat(3,minmax(0,1fr))]">
      {items.map((item) => <li key={item.id}>
        <Link href={occasionHref(item)} className="group relative block aspect-[4/3] overflow-hidden rounded-[18px] bg-sand">
          <Photo image={{ url: item.photo, alt: "" }} alt="" sizes="(min-width: 640px) 30vw, 45vw" aspect="aspect-[4/3]" rounded="rounded-none" imgClassName="transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none" />
          <span className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
          <span className="absolute right-3 bottom-3 left-3 text-white"><b className="hand block text-[1.25rem] leading-none font-normal">{item.hand}</b><span className="mt-0.5 block text-[0.9375rem] font-extrabold">{item.label}</span></span>
        </Link>
      </li>)}
    </ul>
  </section>;
}
