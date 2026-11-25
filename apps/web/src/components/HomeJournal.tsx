"use client";

import NextImage from "next/image";
import Link from "next/link";
import { useState } from "react";
import type { HomeJournal as HomeJournalModel, HomeJournalItem } from "@/lib/home-journal";
import type { SiteLocale } from "@/lib/experience-categories";
import { guideText } from "@/lib/guide-text";

/*
 * The home's journal (owner-approved mock A, 2026-10-29): a large feature with up to three guides beside it, then a grid
 * of thumbnails. Every card is in the server HTML; the topic chips only filter what is already there. Responsive values are
 * written as max-*: / min-*: pairs because the page sits inside the presentation scope (docs/design-system.md §2.3).
 */

const SIDE = 3;

function Thumb({ item, sizes, className, locale }: { item: HomeJournalItem; sizes: string; className: string; locale: SiteLocale }) {
  return (
    <div className={`relative overflow-hidden bg-sand ${className}`}>
      {item.image ? (
        <NextImage src={item.image.src} alt="" fill unoptimized sizes={sizes} className="object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
      ) : (
        <span aria-hidden className="absolute inset-0 grid place-items-center px-3 text-center font-hand text-[1.625rem] leading-none text-moss">{item.topic?.label ?? (locale === "ja" ? "鎌倉" : "Kamakura")}</span>
      )}
    </div>
  );
}

function Label({ item, locale }: { item: HomeJournalItem; locale: SiteLocale }) {
  const parts = [item.topic?.label, item.badge ? guideText(locale).draft : null].filter(Boolean);
  return parts.length ? <p className="text-[0.8125rem] font-extrabold tracking-[0.04em] text-moss uppercase">{parts.join(" · ")}</p> : null;
}

function Meta({ item, locale }: { item: HomeJournalItem; locale: SiteLocale }) {
  const text = guideText(locale);
  return (
    <p className="mt-2 text-sm text-muted">
      {text.readTime(item.readMinutes)} · {item.dateKind === "Checked" ? text.checked : text.updated} <time dateTime={item.dateTime}>{item.dateLabel}</time>
    </p>
  );
}

const titleHover = "decoration-leaf decoration-[3px] underline-offset-4 group-hover:underline";

/**
 * The first card: wide beside its text when it is the only guide, otherwise large above its text. Without a photo the text
 * itself fills a sand card, so the largest slot never shows an empty frame.
 */
function Feature({ item, alone, locale }: { item: HomeJournalItem; alone: boolean; locale: SiteLocale }) {
  const href = `${locale === "ja" ? "/ja" : ""}/guides/${item.slug}`;
  if (!item.image) return (
    <Link href={href} className="group flex h-full flex-col justify-end rounded-[var(--radius-card)] bg-sand max-lg:p-6 lg:min-h-[22rem] lg:p-10">
      {item.topic ? <p aria-hidden className="font-hand text-[2.25rem] leading-none text-moss">{item.topic.label}</p> : null}
      <div className="mt-6 max-w-[40rem]">
        {item.topic ? (item.badge ? <p className="text-[0.8125rem] font-extrabold tracking-[0.04em] text-moss uppercase">{guideText(locale).draft}</p> : null) : <Label item={item} locale={locale} />}
        <h3 className={`mt-1.5 max-lg:text-[1.75rem] lg:text-[2.5rem] ${titleHover}`}>{item.title}</h3>
        <p className="mt-3 text-ink-soft">{item.description}</p>
        <Meta item={item} locale={locale} />
      </div>
    </Link>
  );
  return (
    <Link href={href} className={`group grid ${alone ? "max-lg:gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-center lg:gap-10" : "gap-4"}`}>
      <Thumb item={item} sizes={alone ? "(min-width: 64rem) 640px, 100vw" : "(min-width: 64rem) 700px, 100vw"} className="aspect-[16/10] rounded-[var(--radius-card)]" locale={locale} />
      <div className="min-w-0">
        <Label item={item} locale={locale} />
        <h3 className={`mt-1.5 max-lg:text-[1.625rem] lg:text-[2.125rem] ${titleHover}`}>{item.title}</h3>
        <p className="mt-2.5 line-clamp-3 text-ink-soft">{item.description}</p>
        <Meta item={item} locale={locale} />
      </div>
    </Link>
  );
}

/** A thumbnail beside the title: the guides next to the feature. */
function Row({ item, locale }: { item: HomeJournalItem; locale: SiteLocale }) {
  const href = `${locale === "ja" ? "/ja" : ""}/guides/${item.slug}`;
  return (
    <Link href={href} className="group grid items-start gap-x-4 max-lg:grid-cols-[6.5rem_minmax(0,1fr)] lg:grid-cols-[9.375rem_minmax(0,1fr)]">
      <Thumb item={item} sizes="150px" className="aspect-square rounded-2xl" locale={locale} />
      <div className="min-w-0">
        <Label item={item} locale={locale} />
        <h3 className={`mt-1 text-[1.125rem] leading-snug ${titleHover}`}>{item.title}</h3>
        <p className="mt-1.5 line-clamp-2 text-[0.9375rem] text-ink-soft max-lg:hidden">{item.description}</p>
        <Meta item={item} locale={locale} />
      </div>
    </Link>
  );
}

/** The grid: a compact row with a square thumbnail on phones, a photo card from tablets up. */
function Tile({ item, locale }: { item: HomeJournalItem; locale: SiteLocale }) {
  const href = `${locale === "ja" ? "/ja" : ""}/guides/${item.slug}`;
  return (
    <Link href={href} className="group grid items-start max-sm:grid-cols-[6.5rem_minmax(0,1fr)] max-sm:gap-x-3.5 sm:gap-3">
      <Thumb item={item} sizes="(min-width: 64rem) 380px, (min-width: 40rem) 50vw, 104px" className="rounded-2xl max-sm:aspect-square sm:aspect-[3/2]" locale={locale} />
      <div className="min-w-0">
        <Label item={item} locale={locale} />
        <h3 className={`mt-1 leading-snug max-sm:text-[1.0625rem] sm:text-[1.25rem] ${titleHover}`}>{item.title}</h3>
        <p className="mt-1.5 line-clamp-2 text-[0.9375rem] text-ink-soft max-sm:hidden">{item.description}</p>
        <Meta item={item} locale={locale} />
      </div>
    </Link>
  );
}

function Tiles({ items, className = "", locale }: { items: readonly HomeJournalItem[]; className?: string; locale: SiteLocale }) {
  return items.length ? (
    <ul className={`grid max-sm:gap-6 sm:gap-y-10 sm:max-lg:grid-cols-2 sm:max-lg:gap-x-6 lg:grid-cols-3 lg:gap-x-7 ${className}`}>
      {items.map((item) => <li key={item.slug}><Tile item={item} locale={locale} /></li>)}
    </ul>
  ) : null;
}

export function HomeJournal({ journal, allHref, moreClassName, locale = "en" }: { journal: HomeJournalModel; allHref: string | null; moreClassName: string; locale?: SiteLocale }) {
  const [topic, setTopic] = useState<string | null>(null);
  const text = guideText(locale);
  const { items, topics } = journal;
  const [feature, ...rest] = items;
  if (!feature) return null;
  const filtered = topic === null ? null : items.filter((item) => item.topic?.key === topic);
  return (
    <section className="container-page pt-[72px] lg:pt-[104px]" aria-labelledby="home-guides-heading">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <p className="eyebrow">{text.homeEyebrow}</p>
          <h2 id="home-guides-heading" className="mt-1 max-lg:text-[2rem] lg:text-[2.75rem]">{text.homeTitle}</h2>
          <p className="mt-2 max-w-[40rem] text-ink-soft">{text.homeDescription}</p>
        </div>
        {allHref ? <Link href={allHref} className="link-leaf shrink-0 text-sm">{text.seeAll}</Link> : null}
      </div>
      {topics.length > 1 ? (
        <div role="group" aria-label={text.filterLabel} className="scrollbar-none mb-7 flex gap-2 overflow-x-auto max-sm:-mx-5 max-sm:px-5">
          {[{ key: null, label: text.all }, ...topics].map((entry) => {
            const on = topic === entry.key;
            return (
              <button key={entry.key ?? "all"} type="button" aria-pressed={on} onClick={() => setTopic(entry.key)} className={`shrink-0 rounded-full border-[1.5px] px-4 py-2 text-[0.9375rem] font-extrabold whitespace-nowrap ${on ? "border-ink bg-ink text-white" : "border-line-strong bg-white text-ink-soft hover:border-ink"}`}>
                {entry.label}
              </button>
            );
          })}
        </div>
      ) : null}
      {filtered ? <Tiles items={filtered} locale={locale} /> : (
        <ul className={`grid ${rest.length ? "max-lg:gap-8 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] lg:gap-9" : ""}`}>
          <li><Feature item={feature} alone={!rest.length} locale={locale} /></li>
          {rest.length ? (
            <li>
              <ul className="grid content-start gap-6">
                {rest.slice(0, SIDE).map((item) => <li key={item.slug}><Row item={item} locale={locale} /></li>)}
              </ul>
            </li>
          ) : null}
        </ul>
      )}
      {filtered ? null : <Tiles items={rest.slice(SIDE)} className="max-lg:mt-10 lg:mt-12" locale={locale} />}
      {journal.more && allHref ? (
        <div className="mt-11 flex justify-center">
          <Link href={allHref} className={moreClassName}>{text.moreGuides}</Link>
        </div>
      ) : null}
    </section>
  );
}
