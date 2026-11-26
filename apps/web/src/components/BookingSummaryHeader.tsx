import Link from "next/link";
import { HandIcon } from "@/components/HandIcon";
import { Photo } from "@/components/Photo";
import { areaLabel } from "@/lib/experience-categories";
import { providerNameFor } from "@/lib/experience/provider-name";
import { formatDuration } from "@/lib/format";
import type { SitePublicExperience } from "@/lib/experience/site-publications";
import type { ExperienceAreaId } from "@niho-experience/experience-domain";

/**
 * The top of the booking page, one component for both languages (#658): which experience this is (photo, title, who the day is
 * with, time, area, party size), a way back to its page, and, when it takes a request, the three steps of the flow. Nothing says
 * a request is a booking. The English page is the base; the words are written here for both languages.
 */
export function BookingSummaryHeader({ item, locale, area = null, people = [] }: {
  item: SitePublicExperience;
  locale: "en" | "ja";
  area?: ExperienceAreaId | null;
  /** 街の人 the experience is met through (Japanese only): their names make the "who with" line. */
  people?: readonly { readonly name: string }[];
}) {
  const ja = locale === "ja";
  const { publication, saleTerms } = item;
  const offers = saleTerms?.offers ?? [];
  const title = ja ? publication.japanese?.title ?? publication.publicTitle : publication.publicTitle;
  const request = offers.some((offer) => offer.acceptanceMode === "APPROVAL");
  const providerName = providerNameFor(publication, locale)?.trim() || null;
  const business = publication.providerKind === "BUSINESS";
  const withLine = business
    ? providerName ? ja ? people.length ? `${providerName} のみなさんと` : `${providerName}が開催` : `with ${providerName}` : ja ? "ホストのみなさんと" : "with the host team"
    : providerName ? ja ? `${providerName}さんと` : `with ${providerName}` : null;
  const durations = offers.map((offer) => offer.durationMinutes).sort((a, b) => a - b);
  const duration = durations.length ? durations[0] === durations.at(-1) ? formatDuration(durations[0]!, locale) : `${formatDuration(durations[0]!, locale)}–${formatDuration(durations.at(-1)!, locale)}` : null;
  const minimum = offers.length ? Math.min(...offers.map((offer) => offer.minimumParticipants)) : null;
  const maximum = offers.length ? Math.max(...offers.map((offer) => offer.maxPartySize)) : null;
  const capacity = minimum === null || maximum === null ? null : minimum === maximum ? (ja ? `${maximum}名` : `${maximum} guests`) : ja ? `${minimum}〜${maximum}名` : `${minimum}–${maximum} guests`;
  const facts = [duration, area ? areaLabel(area, locale) : null, capacity].filter((value): value is string => Boolean(value));
  const photo = publication.photos[0];
  const cover = photo ? { url: photo.src, alt: ja ? photo.altJa || `${title}の写真` : photo.alt } : null;
  const steps = ja
    ? [["申込みを送る", "カードの入力は、まだ要りません。"], ["事務局が確認", "24時間以内にメールでお返事します。"], ["日程が決まったらお支払い", "メールのリンクから、カードで。"]]
    : [["Send your request", "No card details are needed yet."], ["NIHO reviews it", "We reply by email within 24 hours."], ["Pay once the date is set", "By card, from the link in that email."]];
  return (
    <div className="mb-6">
      <Link href={`${ja ? "/ja" : ""}/experiences/${encodeURIComponent(publication.slug)}`} className="inline-flex min-h-11 items-center gap-1 text-sm font-extrabold text-ink-soft hover:text-ink"><HandIcon name="back" className="size-5" />{ja ? "体験のページへ" : "Back to the experience"}</Link>
      <div className="mt-2 flex items-center gap-4 rounded-2xl border border-line p-3">
        {cover ? <Photo image={cover} alt="" aspect="" rounded="rounded-xl" className="size-20 shrink-0 sm:size-24" sizes="96px" /> : null}
        <div className="min-w-0">
          <p className="font-extrabold [overflow-wrap:anywhere]">{title}</p>
          {withLine ? <p className="text-[0.8125rem] font-bold text-moss">{withLine}</p> : null}
          {facts.length ? <p className="mt-0.5 text-[0.8125rem] text-ink-soft">{facts.join(ja ? "・" : " · ")}</p> : null}
        </div>
      </div>
      {request ? (
        <ol aria-label={ja ? "申込みの流れ" : "How a request works"} className="mt-4 grid gap-2.5 sm:grid-cols-3">
          {steps.map(([head, text], index) => (
            <li key={head} className="flex gap-3 rounded-xl bg-sand/70 p-3"><span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-leaf font-extrabold">{index + 1}</span><div><b className="block text-[0.9375rem]">{head}</b><span className="text-[0.8125rem] text-ink-soft">{text}</span></div></li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
