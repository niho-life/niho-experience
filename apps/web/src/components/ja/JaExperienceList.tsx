import Link from "next/link";
import type { DayOption } from "@/lib/date-filter";
import {
  EXPERIENCE_CATEGORIES,
  jaCategoryOf, jaListHref, jaQueryHasFilter, type JaCard, type JaListQuery,
} from "@/lib/ja-catalog";
import { CategoryIcon } from "./CategoryIcon";
import { JaExperienceCard } from "./JaExperienceCard";
import { JaFilterForm } from "./JaFilterForm";

/**
 * 日本語サイトの体験の一覧 (#529): the category switch (すべて＋8つ) and its heading, the days and the area / だれと / こんな日に /
 * 人数 conditions, the count, the cards, and when nothing matches, a way to ask the office. The conditions are plain links
 * and one GET form, so the list works without scripts and every state has an address.
 */
export function JaExperienceList({ cards, query, days, total }: { cards: readonly JaCard[]; query: JaListQuery; days: readonly DayOption[]; total: number }) {
  const category = jaCategoryOf(query.category);
  const filtered = jaQueryHasFilter(query);
  const clearHref = jaListHref({ ...query, area: null, companion: null, occasion: null, guests: null, date: null });
  return (
    <div className="container-page py-8 lg:py-12">
      <header>
        <span className="hand text-[1.5rem]">{category ? category.hand : "find your day"}</span>
        <h1 className="mt-1 font-sans text-[1.625rem] leading-tight font-extrabold tracking-normal md:text-[2rem]">{category ? category.label : "すべての体験"}</h1>
        <p className="mt-2 max-w-2xl text-ink-soft">{category ? category.lead : "鎌倉・逗子・葉山の人と活動に、会いにいく。料金は日本円、時刻は日本時間です。"}</p>
        <nav aria-label="カテゴリー" className="-mx-5 mt-5 flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
          <Link href={jaListHref(query, { category: null })} aria-current={!query.category ? "page" : undefined} className={`inline-flex min-h-10 shrink-0 items-center rounded-full border px-4 text-[0.875rem] font-bold whitespace-nowrap ${!query.category ? "border-leaf bg-leaf-pale text-moss" : "border-line-strong bg-canvas text-ink-soft hover:bg-sand"}`}>すべて</Link>
          {EXPERIENCE_CATEGORIES.map((item) => (
            <Link key={item.id} href={jaListHref(query, { category: item.id })} aria-current={query.category === item.id ? "page" : undefined} className={`inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[0.875rem] font-bold whitespace-nowrap ${query.category === item.id ? "border-leaf bg-leaf-pale text-moss" : "border-line-strong bg-canvas text-ink-soft hover:bg-sand"}`}>
              <CategoryIcon id={item.id} className="size-4" />{item.label}
            </Link>
          ))}
        </nav>
      </header>

      <section aria-label="絞り込み" className="mt-6 rounded-2xl border border-line bg-sand/50 p-3.5 md:p-4">
        <p className="text-[0.8125rem] font-bold text-ink-soft">日にち</p>
        <ul className="-mx-1 mt-1.5 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <li className="shrink-0"><Link href={jaListHref(query, { date: null })} aria-current={!query.date ? "true" : undefined} className={`inline-flex h-14 min-w-16 items-center justify-center rounded-xl border px-3 text-[0.875rem] font-bold ${!query.date ? "border-leaf bg-leaf-pale text-moss" : "border-line-strong bg-canvas hover:bg-sand"}`}>いつでも</Link></li>
          {days.map((day) => (
            <li key={day.key} className="shrink-0"><Link href={jaListHref(query, { date: day.key })} aria-current={query.date === day.key ? "true" : undefined} aria-label={day.label} className={`flex h-14 w-12 flex-col items-center justify-center rounded-xl border leading-tight ${query.date === day.key ? "border-leaf bg-leaf-pale text-moss" : "border-line-strong bg-canvas hover:bg-sand"}`}><small className="text-[0.6875rem] font-bold">{day.weekday.replace("曜", "")}</small><b className="text-[1.0625rem]">{day.day}</b></Link></li>
          ))}
        </ul>
        <JaFilterForm query={query} />
      </section>

      <p className="mt-6 text-[0.9375rem]" role="status" aria-live="polite">
        <b>{cards.length}件</b>の体験{query.date ? `（${days.find((day) => day.key === query.date)?.label ?? ""}に行けるもの）` : ""}
        {filtered || query.category ? <>　<Link href={filtered ? clearHref : jaListHref(query, { category: null })} className="text-[0.8125rem] font-bold text-moss underline underline-offset-4">{filtered ? "条件をクリア" : "すべての体験を見る"}</Link></> : null}
      </p>

      {cards.length ? (
        <ul className="mt-4 grid gap-x-6 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card, index) => <li key={card.slug} className="min-w-0"><JaExperienceCard card={card} priority={index < 3} /></li>)}
        </ul>
      ) : (
        <div className="mt-6 rounded-2xl border border-dashed border-line-strong bg-sand/40 px-5 py-10 text-center">
          <span className="hand text-[1.375rem]">nothing here yet</span>
          <p className="mt-2 text-ink-soft">{total === 0 ? "いま案内できる体験がありません。" : "条件に合う体験がまだありません。"}事務局に相談すると、合う人と場をお探しします。</p>
          <Link href="/ja/inquiry" className="mt-4 inline-flex min-h-11 items-center rounded-full bg-leaf px-6 text-[0.9375rem] font-extrabold text-ink hover:bg-leaf-hover">相談する</Link>
        </div>
      )}

      <aside className="mt-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-sand/60 px-5 py-4">
        <div><h2 className="font-sans text-[1rem] font-extrabold tracking-normal">探しているものが見つからないときは</h2><p className="text-[0.875rem] text-ink-soft">載っていない人や活動も、事務局が知っていることがあります。</p></div>
        <Link href="/ja/inquiry" className="inline-flex min-h-11 items-center rounded-full border border-line-strong bg-canvas px-5 text-[0.9375rem] font-extrabold hover:bg-sand">相談する</Link>
      </aside>
    </div>
  );
}
