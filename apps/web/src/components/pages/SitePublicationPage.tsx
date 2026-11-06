import Link from "next/link";
import type { Metadata } from "next";
import { TrackView } from "@/components/Analytics";
import { DesktopGallery, MobileGallery } from "@/components/DetailGallery";
import { HandIcon } from "@/components/HandIcon";
import { JsonLd } from "@/components/JsonLd";
import { NextDateBand } from "@/components/NextDateBand";
import { Photo } from "@/components/Photo";
import { ReviewsSection } from "@/components/ReviewsSection";
import { config } from "@/lib/config";
import { siteNextDates } from "@/lib/guest-booking-source";
import { formatDuration, formatYen } from "@/lib/format";
import { iconForText } from "@/lib/themes";
import { publicMetadata } from "@/lib/public-metadata";
import { seoDescription } from "@/lib/seo-description";
import { cancellationSummary, scheduleDescription } from "@/lib/experience/site-card-model";
import type { SitePublicExperience } from "@/lib/experience/site-publications";
import { getLiveReviews } from "@/lib/journey";
import { reviewDisplay, reviewHeadline } from "@/lib/reviews-ui";
import { reviewsForJsonLd, sitePublicationJsonLd } from "@/lib/structured-data";

export function sitePublicationMetadata(item: SitePublicExperience, locale: "en" | "ja" = "en"): Metadata {
  const { publication } = item;
  const ja = locale === "ja";
  const canonical = `${config.siteUrl}${ja ? "/ja" : ""}/experiences/${encodeURIComponent(publication.slug)}`;
  const english = `${config.siteUrl}/experiences/${encodeURIComponent(publication.slug)}`;
  const japanese = `${config.siteUrl}/ja/experiences/${encodeURIComponent(publication.slug)}`;
  const base = publicMetadata(ja ? publication.japanese!.title : publication.publicTitle, seoDescription(ja ? publication.japanese!.lead : publication.content.lead), canonical);
  return {
    ...base,
    alternates: { canonical, languages: publication.japanese && config.japaneseSiteEnabled ? { en: english, ja: japanese, "x-default": english } : { en: english, "x-default": english } },
    openGraph: { ...base.openGraph, locale: ja ? "ja_JP" : "en_US" },
    robots: config.indexingAllowed ? undefined : { index: false, follow: false },
  };
}

export async function SitePublicationPage({ item, cancelled = false, locale = "en" }: { item: SitePublicExperience; cancelled?: boolean; locale?: "en" | "ja" }) {
  const { publication, saleTerms, sellerDisclosure, hostBio } = item;
  const ja = locale === "ja";
  const content = ja ? publication.japanese! : null;
  const title = content?.title ?? publication.publicTitle;
  const photos = publication.photos.map((photo) => ({ url: photo.src, alt: ja ? (photo.altJa || `${title}の写真`) : photo.alt }));
  const reviews = await getLiveReviews(publication.slug);
  const headline = reviewHeadline(reviewDisplay(reviews), locale);
  const structured = sitePublicationJsonLd(item, config.siteUrl, config.bookingsEnabled && config.guestBookingEnabled, reviewsForJsonLd(reviews), locale);
  const offers = saleTerms?.offers ?? [];
  const durationValues = [...new Set(offers.map((offer) => offer.durationMinutes))].sort((a, b) => a - b);
  const durations = durationValues.length === 1
    ? formatDuration(durationValues[0]!, locale)
    : durationValues.length > 1 ? `${formatDuration(durationValues[0]!, locale)}–${formatDuration(durationValues.at(-1)!, locale)}` : null;
  const language = (content?.language ?? publication.content.facts.language).trim();
  // The next dates and when the next one stops taking bookings (#146), read from the experience DB as the booking page reads them.
  // Only where a guest can book: otherwise there is nothing to book by, and a failed read shows none.
  const bookingHref = `${ja ? "/ja" : ""}/experiences/${publication.slug}/book`;
  const nextDates = config.bookingsEnabled && config.guestBookingEnabled && offers.length ? await siteNextDates(publication.slug) : [];
  // Host-written FAQ in the page's language; none written means no section (never a filler FAQ).
  const faq = content ? content.faq : publication.content.faq;
  // The host's own bio (#146) in the page's language only: English needs the host's confirmed English. No filler.
  const hostBioText = (ja ? hostBio?.ja : hostBio?.en) ?? null;

  return <>
    <JsonLd data={structured.touristTrip} />
    <JsonLd data={structured.product} />
    {ja ? null : <TrackView event="experience_view" props={{ experience: publication.slug }} />}
    <div className="overflow-x-clip">
      <MobileGallery photos={photos} title={title} backHref={ja ? "/ja/experiences" : "/experiences"} />
      <div className="container-page">
        <nav aria-label={ja ? "パンくずリスト" : "Breadcrumb"} className="hidden pt-7 text-sm text-muted lg:block">
          <Link href={ja ? "/ja/experiences" : "/experiences"} className="font-extrabold text-ink hover:underline">{ja ? "体験" : "Experiences"}</Link>
          <span aria-hidden> / </span><span aria-current="page">{title}</span>
        </nav>
        {cancelled ? <p role="status" className="mt-5 rounded-2xl bg-sand p-4">{ja ? "決済がキャンセルされました。予約は完了していません。" : "Checkout was cancelled. Your booking was not completed."}</p> : null}
        <header className="pt-5 lg:pt-3.5">
          <h1 className="text-[2.125rem] leading-[1.1] lg:max-w-[20ch] lg:text-[3.25rem]">{title}</h1>
          {headline ? headline.href
            ? <Link href={headline.href} aria-label={headline.accessibleLabel} className="mt-3 inline-flex font-extrabold text-moss hover:underline">{headline.label}</Link>
            : <span className="mt-3 inline-flex rounded-full bg-sand px-3 py-1 text-sm font-extrabold">{headline.label}</span>
          : null}
          <p className="mt-4 text-[0.9375rem] text-ink-soft">{ja ? "提供者: " : "Offered by "}<b className="text-ink">{publication.sellerDisplayName}</b>{sellerDisclosure ? <> · <a className="font-bold text-ink underline" href={sellerDisclosure.method === "EXTERNAL" ? sellerDisclosure.externalUrl : `/experiences/${encodeURIComponent(publication.slug)}/seller`} rel="noopener noreferrer">{ja ? "販売者情報" : "Seller information"}</a></> : null}</p>
          <ul className="mt-[18px] grid grid-cols-2 gap-x-3 gap-y-4 border-y border-line py-[18px] lg:flex lg:flex-wrap lg:gap-x-9 lg:border-0 lg:py-0">
            {durations ? <li><span className="eyebrow">{ja ? "所要時間" : "Duration"}</span><p className="font-extrabold">{durations}</p></li> : null}
            {language ? <li><span className="eyebrow">{ja ? "対応言語" : "Language"}</span><p className="font-extrabold">{language}</p></li> : null}
            {offers.length ? <li><span className="eyebrow">{ja ? "参加人数" : "Group size"}</span><p className="font-extrabold">{Math.min(...offers.map((offer) => offer.minimumParticipants))}–{Math.max(...offers.map((offer) => offer.maxPartySize))}{ja ? "名" : " guests"}</p></li> : null}
          </ul>
        </header>
        {nextDates.length ? <NextDateBand dates={nextDates} locale={locale} bookingHref={bookingHref} allDatesHref={bookingHref} /> : null}
        <DesktopGallery photos={photos} title={title} />

        <div className="grid gap-10 pt-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-[72px] lg:pt-4">
          <div className="min-w-0">
            <section className="pt-6" aria-label={ja ? "概要" : "Overview"}>
              <p className="text-lg leading-relaxed">{content?.lead ?? publication.content.lead}</p>
              {(content?.highlights ?? publication.content.highlights).length ? <ul className="mt-6 grid gap-3.5">
                {(content?.highlights ?? publication.content.highlights).map((item) => <li key={item} className="flex items-center gap-3.5"><HandIcon name={iconForText(item)} className="size-10" />{item}</li>)}
              </ul> : null}
            </section>

            <section className="border-b border-line py-8 lg:py-10">
              <h2 className="text-2xl">{ja ? "体験内容" : "What you’ll do"}</h2>
              <div className="mt-4 space-y-3.5 whitespace-pre-line text-ink-soft">{content?.description ?? publication.content.description}</div>
            </section>
            {(content?.timeline ?? publication.content.timeline).length ? <section className="border-b border-line py-8 lg:py-10">
              <h2 className="text-2xl">{ja ? "当日の流れ" : "How the time flows"}</h2>
              <ol className="mt-6 space-y-6">
                {(content?.timeline ?? publication.content.timeline).map((step, index) => {
                  const photo = step.photoIndex === null ? null : photos[step.photoIndex] ?? null;
                  return <li key={`${index}-${step.title}`} className="grid gap-4 sm:grid-cols-[96px_1fr]">
                    {photo ? <Photo image={photo} alt={photo.alt || `${title}、${step.title}`} aspect="" rounded="rounded-[18px]" className="size-24" sizes="96px" /> : <span className="grid size-24 place-items-center rounded-[18px] bg-sand"><HandIcon name={iconForText(`${step.title} ${step.text}`, "clock")} className="size-10" /></span>}
                    <div>{step.time ? <p className="hand text-2xl">{step.time} JST</p> : null}<h3 className="mt-1 font-extrabold">{step.title}</h3><p className="mt-1 text-ink-soft">{step.text}</p></div>
                  </li>;
                })}
              </ol>
            </section> : null}
            <section className="border-b border-line py-8 lg:py-10">
              <h2 className="text-2xl">{ja ? "料金に含まれるもの" : "What’s included"}</h2>
              <div className="mt-5 grid gap-7 sm:grid-cols-2">
                <div><h3 className="font-extrabold">{ja ? "含まれるもの" : "Included"}</h3><ul className="mt-3 list-disc space-y-2 pl-5 text-ink-soft">{(content?.included ?? publication.content.included).map((value) => <li key={value}>{value}</li>)}</ul></div>
                <div><h3 className="font-extrabold">{ja ? "含まれないもの" : "Not included"}</h3><ul className="mt-3 list-disc space-y-2 pl-5 text-ink-soft">{(content?.notIncluded ?? publication.content.notIncluded).map((value) => <li key={value}>{value}</li>)}</ul></div>
              </div>
            </section>
            {(content?.knowBeforeYouGo ?? publication.content.knowBeforeYouGo).length || (content?.notSuitableFor ?? publication.content.notSuitableFor).length ? <section className="border-b border-line py-8 lg:py-10">
              <h2 className="text-2xl">{ja ? "参加前にご確認ください" : "Know before you go"}</h2>
              {(content?.knowBeforeYouGo ?? publication.content.knowBeforeYouGo).length ? <ul className="mt-4 list-disc space-y-2 pl-5 text-ink-soft">{(content?.knowBeforeYouGo ?? publication.content.knowBeforeYouGo).map((value) => <li key={value}>{value}</li>)}</ul> : null}
              {(content?.notSuitableFor ?? publication.content.notSuitableFor).length ? <><h3 className="mt-6 font-extrabold">{ja ? "参加に適さない方" : "Not suitable for"}</h3><ul className="mt-3 list-disc space-y-2 pl-5 text-ink-soft">{(content?.notSuitableFor ?? publication.content.notSuitableFor).map((value) => <li key={value}>{value}</li>)}</ul></> : null}
            </section> : null}
            {!ja && (publication.meetingOverview || publication.meetingPointDisclosure === "PUBLIC" || publication.meetingPointDisclosure === "AFTER_BOOKING") ? <section className="border-b border-line py-8 lg:py-10">
              <h2 className="text-2xl">Where you’ll meet</h2>
              {publication.meetingOverview ? <p className="mt-4 whitespace-pre-line text-ink-soft">{publication.meetingOverview}</p> : null}
              {publication.meetingPointDisclosure === "PUBLIC" && publication.meetingPoint ? <div className="mt-4">
                <p className="font-extrabold">{publication.meetingPoint.name}</p>
                {publication.meetingPoint.exteriorPhotoIndex !== null && photos[publication.meetingPoint.exteriorPhotoIndex] ? <Photo image={photos[publication.meetingPoint.exteriorPhotoIndex]!} alt={photos[publication.meetingPoint.exteriorPhotoIndex]!.alt || `${publication.meetingPoint.name} exterior`} aspect="" rounded="rounded-xl" className="mt-4 h-52 w-64" sizes="256px" /> : null}
              </div> : publication.meetingPointDisclosure === "AFTER_BOOKING" ? <p className="mt-4 text-ink-soft">The meeting point is shared after your booking is confirmed.</p> : null}
            </section> : null}
            {hostBioText ? <section id="host" aria-labelledby="host-heading" className="scroll-mt-24 border-b border-line py-8 lg:py-10">
              <h2 id="host-heading" className="text-2xl">{ja ? "ホストについて" : "About your host"}</h2>
              <p className="mt-4 font-extrabold">{publication.sellerDisplayName}</p>
              <p className="mt-2 whitespace-pre-line break-words text-ink-soft">{hostBioText}</p>
            </section> : null}
            {reviews ? <section id="reviews" className="scroll-mt-24 border-b border-line py-8 lg:py-10">
              <h2 className="text-2xl">{ja ? "レビュー" : "Reviews"}</h2>
              <div className="mt-4"><ReviewsSection slug={publication.slug} reviews={reviews} locale={locale} preview={false} nihoWebOrigin={config.nihoWebOrigin} /></div>
            </section> : null}
            {faq.length ? <section id="faq" aria-labelledby="faq-heading" className="scroll-mt-24 border-b border-line py-8 lg:py-10">
              <h2 id="faq-heading" className="text-2xl">{ja ? "よくある質問" : "Questions before you book"}</h2>
              <div className="mt-4 border-t border-line">
                {faq.map((item, index) => <details key={`${index}-${item.question}`} className="group border-b border-line">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center py-4 [&::-webkit-details-marker]:hidden">
                    <h3 className="flex w-full items-center justify-between gap-4 font-sans text-[1.0625rem] leading-[1.5] font-extrabold tracking-normal"><span>{item.question}</span><span aria-hidden className="text-xl text-moss transition-transform group-open:rotate-45">+</span></h3>
                  </summary>
                  <p className="pb-4 whitespace-pre-line text-ink-soft">{item.answer}</p>
                </details>)}
              </div>
            </section> : null}
          </div>

          <aside className="h-max rounded-[var(--radius-card)] border border-line bg-white p-5 lg:sticky lg:top-24">
            {offers.length ? <>
              <p className="eyebrow">{ja ? "料金" : "From"}</p>
              <p className="mt-1 text-3xl font-extrabold">{formatYen(Math.min(...offers.map((offer) => offer.pricing.adultPriceYen)), locale)} <span className="text-sm font-normal">{ja ? "大人1名から" : "per adult"}</span></p>
              <p className="mt-2 text-sm text-ink-soft">{offers.map((offer) => scheduleDescription(offer, locale)).filter((line, index, all) => all.indexOf(line) === index).join(" · ")}</p>
              {config.bookingsEnabled && config.guestBookingEnabled ? <Link href={`${ja ? "/ja" : ""}/experiences/${publication.slug}/book`} className="mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-ink px-6 font-extrabold text-white hover:bg-ink/90">{ja ? "日時を選ぶ" : "Choose a date"}</Link> : <p className="mt-5 rounded-xl bg-sand p-3 text-sm text-ink-soft">{ja ? "現在、オンライン予約はご利用いただけません。" : "Online booking is temporarily unavailable."}</p>}
              <p className="mt-3 text-xs text-muted">{ja ? `${saleTerms?.sellerDisplayName ?? publication.sellerDisplayName}が販売者です。お支払いはStripe Checkoutで受け付けます。` : `${saleTerms?.sellerDisplayName ?? publication.sellerDisplayName} is the seller and receives the booking payment through Stripe Checkout.`}</p>
              <ul className="mt-5 space-y-3 border-t border-line pt-4 text-sm text-ink-soft">
                {offers.map((offer) => <li key={offer.id}><b className="text-ink">{offer.name}:</b> {cancellationSummary(offer, locale)}{offer.minimumChargeableParticipants > 1 ? ja ? ` · 最低請求人数: ${offer.minimumChargeableParticipants}名` : ` · Minimum charge: ${offer.minimumChargeableParticipants} guests` : ""}</li>)}
              </ul>
            </> : <p className="text-ink-soft">{ja ? "この体験は現在予約できません。" : "Online booking is not available for this experience yet."}</p>}
          </aside>
        </div>
      </div>
    </div>
  </>;
}
