import Link from "next/link";
import { HandIcon } from "@/components/HandIcon";
import { Photo } from "@/components/Photo";
import { jaAreaLabel, jaCapacity, jaDuration, type JaCard } from "@/lib/ja-catalog";

/**
 * 予約・申込みの画面の上 (#530): which experience this is (photo, title, who the day is with, time, area), a way back to its page,
 * and, when it takes a request, the three steps of the flow. Nothing says a request is a booking.
 */
export function JaBookingSummary({ slug, title, card, request }: { slug: string; title: string; card: JaCard | null; request: boolean }) {
  const area = jaAreaLabel(card?.classification.area ?? null);
  const facts = [card?.durationMinutes ? jaDuration(card.durationMinutes) : null, area, card?.capacity ? jaCapacity(card.capacity) : null].filter((value): value is string => Boolean(value));
  return (
    <div className="mb-6">
      <Link href={`/ja/experiences/${encodeURIComponent(slug)}`} className="inline-flex min-h-11 items-center gap-1 text-sm font-extrabold text-ink-soft hover:text-ink"><HandIcon name="back" className="size-5" />体験のページへ</Link>
      <div className="mt-2 flex items-center gap-4 rounded-2xl border border-line p-3">
        {card?.cover ? <Photo image={card.cover} alt="" aspect="" rounded="rounded-xl" className="size-20 shrink-0 sm:size-24" sizes="96px" /> : null}
        <div className="min-w-0">
          <p className="font-extrabold [overflow-wrap:anywhere]">{title}</p>
          {card?.withLine ? <p className="text-[0.8125rem] font-bold text-moss">{card.withLine}</p> : null}
          {facts.length ? <p className="mt-0.5 text-[0.8125rem] text-ink-soft">{facts.join("・")}</p> : null}
        </div>
      </div>
      {request ? (
        <ol aria-label="申込みの流れ" className="mt-4 grid gap-2.5 sm:grid-cols-3">
          {[["申込みを送る", "カードの入力は、まだ要りません。"], ["事務局が確認", "24時間以内にメールでお返事します。"], ["日程が決まったらお支払い", "メールのリンクから、カードで。"]].map(([head, text], index) => (
            <li key={head} className="flex gap-3 rounded-xl bg-sand/70 p-3"><span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-leaf font-extrabold">{index + 1}</span><div><b className="block text-[0.9375rem]">{head}</b><span className="text-[0.8125rem] text-ink-soft">{text}</span></div></li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
