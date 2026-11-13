import Link from "next/link";
import { TrackView } from "@/components/Analytics";
import { DesktopGallery, MobileGallery } from "@/components/DetailGallery";
import { HandIcon } from "@/components/HandIcon";
import { JsonLd } from "@/components/JsonLd";
import { NextDateBand } from "@/components/NextDateBand";
import { Photo } from "@/components/Photo";
import { ReviewsSection } from "@/components/ReviewsSection";
import { config } from "@/lib/config";
import { dayOption } from "@/lib/date-filter";
import { cancellationSummary } from "@/lib/experience/site-card-model";
import type { SitePublicExperience, SitePublicOffer } from "@/lib/experience/site-publications";
import { siteSellerInformationHref } from "@/lib/experience/site-seller-information";
import { siteNextDates } from "@/lib/guest-booking-source";
import { inquiryHref } from "@/lib/group-inquiry-entry";
import { jaAreaLabel, jaCapacity, jaCategoryOf, jaDuration, jaYen, type JaCard } from "@/lib/ja-catalog";
import { getLiveReviews } from "@/lib/journey";
import { iconForText } from "@/lib/themes";
import { reviewsForJsonLd, sitePublicationJsonLd } from "@/lib/structured-data";
import { CategoryIcon } from "./CategoryIcon";
import { JaExperienceCard } from "./JaExperienceCard";

const H2 = "font-sans text-[1.375rem] leading-snug font-extrabold tracking-normal md:text-[1.5rem]";
const SECTION = "border-b border-line py-8 lg:py-10";

/** Cancellation lines by offer: one line when every offer says the same, else each offer's own. Always the product's own terms. */
export function jaCancellationLines(offers: readonly SitePublicOffer[]): { label: string | null; text: string }[] {
  const lines = offers.map((offer) => ({ name: offer.name, text: cancellationSummary(offer, "ja") }));
  const distinct = [...new Set(lines.map((line) => line.text))];
  return distinct.length <= 1 ? distinct.map((text) => ({ label: null, text })) : lines.map((line) => ({ label: line.name, text: line.text }));
}

/**
 * 日本語の体験のページ (#530): from the top, the photos, the title, who the day is spent with, the time, party size and area, the
 * introduction and highlights, the flow of the day, the person, what the price includes, where to meet, what to know, the
 * cancellation terms, and experiences of the same category; the booking column holds the price, the next dates, the way to
 * book (or to send a request) and the product's own cancellation deadline. No sales method, seller or guarantee label.
 */
export async function JaExperiencePage({ item, cancelled = false, card, related }: { item: SitePublicExperience; cancelled?: boolean; card: JaCard | null; related: readonly JaCard[] }) {
  const { publication, saleTerms, hostBio } = item;
  const content = publication.japanese!;
  const title = content.title;
  const photos = publication.photos.map((photo) => ({ url: photo.src, alt: photo.altJa || `${title}の写真` }));
  const offers = saleTerms?.offers ?? [];
  const category = jaCategoryOf(card?.classification.category ?? null);
  const area = jaAreaLabel(card?.classification.area ?? null);
  const reviews = await getLiveReviews(publication.slug);
  const structured = sitePublicationJsonLd(item, config.siteUrl, config.bookingsEnabled && config.guestBookingEnabled, reviewsForJsonLd(reviews), "ja");
  const bookable = config.bookingsEnabled && config.guestBookingEnabled && offers.length > 0;
  const approval = offers.some((offer) => offer.acceptanceMode === "APPROVAL");
  const nextDates = bookable ? await siteNextDates(publication.slug) : [];
  const bookHref = `/ja/experiences/${encodeURIComponent(publication.slug)}/book`;
  const providerName = publication.providerPublicName?.trim() || null;
  const person = publication.providerKind === "PERSON";
  const identity = providerName ? publication.providerPhoto ?? (publication.providerKind === "BUSINESS" ? publication.businessLogo : null) : null;
  const identityPhoto = identity ? { url: identity.src, alt: identity.altJa } : null;
  const bio = hostBio?.ja ?? null;
  const askHref = inquiryHref("ja", { from: "EXPERIENCE", experienceSlug: publication.slug, experienceTitle: title, hostName: providerName });
  const sellerInformationHref = siteSellerInformationHref(item, "ja");
  const lowest = offers.length ? Math.min(...offers.map((offer) => offer.pricing.adultPriceYen)) : null;
  const durations = [...new Set(offers.map((offer) => offer.durationMinutes))].sort((a, b) => a - b);
  const cancellation = jaCancellationLines(offers);
  const cta = approval ? "申込みを送る" : "日にちを選んで予約へ";
  const meetingNote = publication.meetingPointDisclosure === "AFTER_BOOKING" ? "集合場所は、予約が確定したあとにお伝えします。" : null;

  return <>
    <JsonLd data={structured.touristTrip} />
    <JsonLd data={structured.product} />
    <TrackView event="experience_view" props={{ experience: publication.slug }} />
    <div className="overflow-x-clip pb-24 lg:pb-0">
      <MobileGallery photos={photos} title={title} backHref="/ja/experiences" />
      <div className="container-page">
        <nav aria-label="パンくずリスト" className="hidden pt-7 text-sm text-muted lg:block">
          <Link href="/ja/experiences" className="font-extrabold text-ink hover:underline">体験</Link>
          {category ? <><span aria-hidden> / </span><Link href={`/ja/experiences?category=${category.id}`} className="font-extrabold text-ink hover:underline">{category.label}</Link></> : null}
          <span aria-hidden> / </span><span aria-current="page">{title}</span>
        </nav>
        {cancelled ? <p role="status" className="mt-5 rounded-2xl bg-sand p-4">決済がキャンセルされました。予約は完了していません。</p> : null}
        <header className="pt-5 lg:pt-3.5">
          {category ? <span className="hand inline-flex items-center gap-1.5 text-[1.375rem]"><CategoryIcon id={category.id} className="size-5" />{category.hand}</span> : null}
          <h1 className="mt-1 text-[2rem] leading-[1.15] lg:max-w-[22ch] lg:text-[3rem]">{title}</h1>
          {card?.withLine ? <div className="mt-3 flex items-center gap-2.5 text-[1rem] font-extrabold">{identityPhoto ? <Photo image={identityPhoto} alt="" aspect="" rounded="rounded-full" className="size-9 shrink-0" sizes="36px" /> : null}<span>{card.withLine}</span></div> : null}
          <ul className="mt-5 grid grid-cols-2 gap-x-3 gap-y-4 border-y border-line py-4 sm:flex sm:flex-wrap sm:gap-x-9 lg:border-0 lg:py-0">
            {durations.length ? <li><span className="block text-[0.75rem] font-extrabold text-muted">所要時間</span><p className="font-extrabold">{durations.length === 1 ? jaDuration(durations[0]!) : `${jaDuration(durations[0]!)}〜${jaDuration(durations.at(-1)!)}`}</p></li> : null}
            {card?.capacity ? <li><span className="block text-[0.75rem] font-extrabold text-muted">人数</span><p className="font-extrabold">{jaCapacity(card.capacity)}</p></li> : null}
            {area ? <li><span className="block text-[0.75rem] font-extrabold text-muted">エリア</span><p className="font-extrabold">{area}</p></li> : null}
          </ul>
          {sellerInformationHref ? <a href={sellerInformationHref} rel="noopener noreferrer" className="mt-2 inline-flex min-h-6 items-center text-sm text-muted underline underline-offset-2 hover:text-ink">販売者情報</a> : null}
        </header>
        {nextDates.length ? <NextDateBand dates={nextDates} locale="ja" bookingHref={bookHref} allDatesHref={bookHref} /> : null}
        <DesktopGallery photos={photos} title={title} />

        <div className="grid gap-10 pt-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-[72px] lg:pt-4">
          <div className="min-w-0">
            <section className="pt-6" aria-label="紹介">
              <p className="text-lg leading-relaxed">{content.lead}</p>
              <div className="mt-4 space-y-3.5 whitespace-pre-line text-ink-soft">{content.description}</div>
              {content.highlights.length ? <ul className="mt-6 grid gap-3.5">
                {content.highlights.map((text) => <li key={text} className="flex items-center gap-3.5"><HandIcon name={iconForText(text)} className="size-10" />{text}</li>)}
              </ul> : null}
            </section>

            {content.timeline.length ? <section className={SECTION} aria-labelledby="ja-flow"><h2 id="ja-flow" className={H2}>当日の流れ</h2>
              <ol className="mt-6 space-y-6">
                {content.timeline.map((step, index) => {
                  const photo = step.photoIndex === null ? null : photos[step.photoIndex] ?? null;
                  return <li key={`${index}-${step.title}`} className="grid gap-4 sm:grid-cols-[96px_1fr]">
                    {photo ? <Photo image={photo} alt={photo.alt || `${title}、${step.title}`} aspect="" rounded="rounded-[18px]" className="size-24" sizes="96px" /> : <span aria-hidden className="grid size-24 place-items-center rounded-[18px] bg-sand font-extrabold text-moss">{index + 1}</span>}
                    <div>{step.time ? <p className="hand text-2xl">{step.time}</p> : null}<h3 className="mt-1 font-extrabold">{step.title}</h3><p className="mt-1 text-ink-soft">{step.text}</p></div>
                  </li>;
                })}
              </ol>
            </section> : null}

            {providerName || bio ? <section id="host" className={`${SECTION} scroll-mt-24`} aria-labelledby="ja-person"><h2 id="ja-person" className={H2}>{person ? "会いにいく人" : "案内する人"}</h2>
              <div className="mt-5 flex items-start gap-4">
                {identityPhoto ? <Photo image={identityPhoto} alt={identityPhoto.alt} aspect="" rounded="rounded-full" className="size-20 shrink-0" sizes="80px" /> : null}
                <div className="min-w-0"><p className="font-extrabold">{providerName}</p>{bio ? <p className="mt-2 whitespace-pre-line break-words text-ink-soft">{bio}</p> : null}</div>
              </div>
            </section> : null}

            {content.included.length || content.notIncluded.length ? <section className={SECTION} aria-labelledby="ja-included"><h2 id="ja-included" className={H2}>料金に含まれるもの</h2>
              <div className="mt-5 grid gap-7 sm:grid-cols-2">
                {content.included.length ? <div><h3 className="font-extrabold">含まれるもの</h3><ul className="mt-3 space-y-2 text-ink-soft">{content.included.map((text) => <li key={text} className="flex gap-2"><HandIcon name="check" className="mt-0.5 size-5 shrink-0" />{text}</li>)}</ul></div> : null}
                {content.notIncluded.length ? <div><h3 className="font-extrabold">含まれないもの</h3><ul className="mt-3 space-y-2 text-ink-soft">{content.notIncluded.map((text) => <li key={text} className="flex gap-2"><HandIcon name="cross" className="mt-0.5 size-5 shrink-0" />{text}</li>)}</ul></div> : null}
              </div>
            </section> : null}

            {meetingNote ? <section className={SECTION} aria-labelledby="ja-meet"><h2 id="ja-meet" className={H2}>集合場所</h2><p className="mt-4 text-ink-soft">{meetingNote}</p></section> : null}

            {content.knowBeforeYouGo.length || content.notSuitableFor.length ? <section className={SECTION} aria-labelledby="ja-know"><h2 id="ja-know" className={H2}>知っておいてほしいこと</h2>
              {content.knowBeforeYouGo.length ? <ul className="mt-4 list-disc space-y-2 pl-5 text-ink-soft">{content.knowBeforeYouGo.map((text) => <li key={text}>{text}</li>)}</ul> : null}
              {content.notSuitableFor.length ? <><h3 className="mt-6 font-extrabold">ご参加をおすすめしにくい方</h3><ul className="mt-3 list-disc space-y-2 pl-5 text-ink-soft">{content.notSuitableFor.map((text) => <li key={text}>{text}</li>)}</ul></> : null}
            </section> : null}

            {cancellation.length ? <section className={SECTION} aria-labelledby="ja-cancel"><h2 id="ja-cancel" className={H2}>取消について</h2>
              <ul className="mt-4 space-y-2 text-ink-soft">{cancellation.map((line) => <li key={`${line.label}-${line.text}`}>{line.label ? <b className="text-ink">{line.label}：</b> : null}{line.text}</li>)}</ul>
            </section> : null}

            {reviews ? <section id="reviews" className={`${SECTION} scroll-mt-24`}><h2 className={H2}>レビュー</h2><div className="mt-4"><ReviewsSection slug={publication.slug} reviews={reviews} locale="ja" preview={false} nihoWebOrigin={config.nihoWebOrigin} /></div></section> : null}

            {content.faq.length ? <section id="faq" aria-labelledby="ja-faq" className={`${SECTION} scroll-mt-24`}><h2 id="ja-faq" className={H2}>よくある質問</h2>
              <div className="mt-4 border-t border-line">{content.faq.map((entry, index) => <details key={`${index}-${entry.question}`} className="group border-b border-line">
                <summary className="flex min-h-11 cursor-pointer list-none items-center py-4 [&::-webkit-details-marker]:hidden"><h3 className="flex w-full items-center justify-between gap-4 font-sans text-[1.0625rem] leading-[1.5] font-extrabold tracking-normal"><span>{entry.question}</span><span aria-hidden className="text-moss transition-transform group-open:rotate-45">＋</span></h3></summary>
                <p className="pb-4 whitespace-pre-line text-ink-soft">{entry.answer}</p>
              </details>)}</div>
            </section> : null}
          </div>

          <aside id="book" className="h-max rounded-[var(--radius-card)] border border-line bg-white p-5 lg:sticky lg:top-24" aria-label="予約">
            {lowest !== null ? <>
              <p className="text-3xl font-extrabold">{jaYen(lowest)}<span className="ml-1 text-sm font-normal">〜 / 人（税込）</span></p>
              {nextDates.length ? <>
                <p className="mt-4 text-[0.8125rem] font-extrabold text-ink-soft">次の開催</p>
                <ul className="mt-2 grid grid-cols-3 gap-2">{nextDates.slice(0, 3).map((date) => { const day = dayOption(date.date, "ja"); return <li key={`${date.offerId}-${date.date}`}><Link href={bookHref} className="flex flex-col items-center rounded-xl border border-line-strong py-2 leading-tight hover:bg-sand"><small className="text-[0.6875rem] font-bold">{day.weekday.replace("曜", "")}</small><b>{day.label.replace(/（.+$/, "")}</b></Link></li>; })}</ul>
              </> : null}
              {bookable ? <Link href={bookHref} className="mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-leaf px-6 font-extrabold text-ink hover:bg-leaf-hover">{cta}</Link> : <p className="mt-4 text-ink-soft">この体験は現在、予約を受け付けていません。</p>}
              {approval ? <p className="mt-2 text-sm text-ink-soft">申込みを送ると、日程を確認してご連絡します。お支払いは、確認のあとにご案内します。</p> : null}
              {config.groupInquiryEnabled ? <Link href={askHref} className="mt-3 block text-center text-sm font-bold text-moss underline underline-offset-4">ほかの日を相談する</Link> : null}
              {cancellation.length ? <ul className="mt-5 space-y-1.5 border-t border-line pt-4 text-sm text-ink-soft">{cancellation.map((line) => <li key={`${line.label}-${line.text}`} className="flex gap-2"><HandIcon name="umbrella" className="mt-0.5 size-5 shrink-0" /><span>{line.label ? `${line.label}：` : ""}{line.text}</span></li>)}</ul> : null}
            </> : <p className="text-ink-soft">この体験は現在、予約を受け付けていません。</p>}
          </aside>
        </div>

        {related.length ? <section aria-labelledby="ja-related" className="pt-14"><h2 id="ja-related" className={H2}>{category ? `${category.label}の体験をもっと` : "ほかの体験"}</h2>
          <ul className="mt-6 grid gap-x-6 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">{related.map((entry) => <li key={entry.slug} className="min-w-0"><JaExperienceCard card={entry} /></li>)}</ul>
        </section> : null}
      </div>
      {bookable && lowest !== null ? <div className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-3 border-t border-line bg-white px-5 py-3 lg:hidden">
        <p className="text-[0.9375rem]"><b className="text-[1.125rem]">{jaYen(lowest)}</b><span className="text-[0.8125rem] text-ink-soft">〜 / 人</span></p>
        <Link href={bookHref} className="inline-flex min-h-11 items-center rounded-full bg-leaf px-6 font-extrabold text-ink hover:bg-leaf-hover">{cta}</Link>
      </div> : null}
    </div>
  </>;
}
