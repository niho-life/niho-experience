import NextImage from "next/image";
import Link from "next/link";
import { HandIcon } from "@/components/HandIcon";
import { Photo } from "@/components/Photo";
import { jaAreaLabel, jaCapacity, jaDuration, jaYen, type JaCard } from "@/lib/ja-catalog";

/**
 * 日本語サイトの体験のカード (#529): the photo, who the day is spent with, the title, a one-line lead, the time, area and party
 * size, and the price. No sales method, seller, guarantee or next-date label (owner decision 2026-11-13).
 */
export function JaExperienceCard({ card, priority = false }: { card: JaCard; priority?: boolean }) {
  const href = `/ja/experiences/${encodeURIComponent(card.slug)}`;
  const area = jaAreaLabel(card.classification.area);
  return (
    <article className="group relative flex min-w-0 flex-col">
      <Link href={href} tabIndex={-1} aria-hidden="true" className="relative block">
        <Photo image={card.cover} alt={card.cover?.alt ?? ""} sizes="(min-width: 64rem) 33vw, (min-width: 40rem) 50vw, 100vw" priority={priority} aspect="aspect-[4/3]" imgClassName="transition-transform duration-300 group-hover:scale-[1.02] motion-reduce:transition-none" />
        {card.face ? <span className="absolute bottom-2.5 left-2.5 block size-11 overflow-hidden rounded-full border-2 border-white bg-sand"><NextImage src={card.face.url} alt="" fill sizes="44px" unoptimized className="object-cover" /></span> : null}
      </Link>
      <div className="mt-3 flex flex-1 flex-col">
        {card.withLine ? <p className="text-[0.8125rem] font-bold text-moss">{card.withLine}</p> : null}
        <h3 className="mt-0.5 text-[1.0625rem] leading-snug font-bold [overflow-wrap:anywhere]">
          <Link href={href} className="after:absolute after:inset-0 hover:underline focus-visible:underline">{card.title}</Link>
        </h3>
        <p className="mt-1 line-clamp-2 text-[0.875rem] leading-normal text-ink-soft">{card.lead}</p>
        <ul className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-[0.8125rem] text-ink-soft">
          {card.durationMinutes ? <li className="inline-flex items-center gap-1"><HandIcon name="clock" className="size-4 text-moss" />{jaDuration(card.durationMinutes)}</li> : null}
          {area ? <li className="inline-flex items-center gap-1"><HandIcon name="pin" className="size-4 text-moss" />{area}</li> : null}
          {card.capacity ? <li className="inline-flex items-center gap-1"><HandIcon name="people" className="size-4 text-moss" />{jaCapacity(card.capacity)}</li> : null}
        </ul>
        {card.priceFromYen !== null ? <p className="mt-auto pt-2.5 text-[0.9375rem]"><b className="text-[1.0625rem]">{jaYen(card.priceFromYen)}</b><span className="text-[0.8125rem] text-ink-soft">〜 / 人</span></p> : null}
      </div>
    </article>
  );
}
