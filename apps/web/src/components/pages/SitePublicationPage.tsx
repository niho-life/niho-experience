import Link from "next/link";
import type { Metadata } from "next";
import { TrackView } from "@/components/Analytics";
import { DesktopGallery, MobileGallery } from "@/components/DetailGallery";
import { HandIcon } from "@/components/HandIcon";
import { Photo } from "@/components/Photo";
import { config } from "@/lib/config";
import { formatDuration, formatYen } from "@/lib/format";
import { iconForText } from "@/lib/themes";
import { publicMetadata } from "@/lib/public-metadata";
import { seoDescription } from "@/lib/seo-description";
import { cancellationSummary, scheduleDescription } from "@/lib/experience/site-card-model";
import type { SitePublicExperience } from "@/lib/experience/site-publications";

export function sitePublicationMetadata(item: SitePublicExperience): Metadata {
  const { publication } = item;
  const canonical = `${config.siteUrl}/experiences/${publication.slug}`;
  return {
    ...publicMetadata(publication.publicTitle, seoDescription(publication.content.lead), canonical),
    robots: config.indexingAllowed ? undefined : { index: false, follow: false },
  };
}

export function SitePublicationPage({ item, cancelled = false }: { item: SitePublicExperience; cancelled?: boolean }) {
  const { publication, saleTerms } = item;
  const photos = publication.photos.map((photo) => ({ url: photo.src, alt: photo.alt }));
  const offers = saleTerms?.offers ?? [];
  const durationValues = [...new Set(offers.map((offer) => offer.durationMinutes))].sort((a, b) => a - b);
  const durations = durationValues.length === 1
    ? formatDuration(durationValues[0]!, "en")
    : durationValues.length > 1 ? `${formatDuration(durationValues[0]!, "en")}–${formatDuration(durationValues.at(-1)!, "en")}` : null;
  const language = publication.content.facts.language.trim();

  return <>
    <TrackView event="experience_view" props={{ experience: publication.slug }} />
    <div className="overflow-x-clip">
      <MobileGallery photos={photos} title={publication.publicTitle} />
      <div className="container-page">
        <nav aria-label="Breadcrumb" className="hidden pt-7 text-sm text-muted lg:block">
          <Link href="/experiences" className="font-extrabold text-ink hover:underline">Experiences</Link>
          <span aria-hidden> / </span><span aria-current="page">{publication.publicTitle}</span>
        </nav>
        {cancelled ? <p role="status" className="mt-5 rounded-2xl bg-sand p-4">Checkout was cancelled. Your booking was not completed.</p> : null}
        <header className="pt-5 lg:pt-3.5">
          <h1 className="text-[2.125rem] leading-[1.1] lg:max-w-[20ch] lg:text-[3.25rem]">{publication.publicTitle}</h1>
          <p className="mt-4 text-[0.9375rem] text-ink-soft">Offered by <b className="text-ink">{publication.sellerDisplayName}</b></p>
          <ul className="mt-[18px] grid grid-cols-2 gap-x-3 gap-y-4 border-y border-line py-[18px] lg:flex lg:flex-wrap lg:gap-x-9 lg:border-0 lg:py-0">
            {durations ? <li><span className="eyebrow">Duration</span><p className="font-extrabold">{durations}</p></li> : null}
            {language ? <li><span className="eyebrow">Language</span><p className="font-extrabold">{language}</p></li> : null}
            {offers.length ? <li><span className="eyebrow">Group size</span><p className="font-extrabold">{Math.min(...offers.map((offer) => offer.minimumParticipants))}–{Math.max(...offers.map((offer) => offer.maxPartySize))} guests</p></li> : null}
          </ul>
        </header>
        <DesktopGallery photos={photos} title={publication.publicTitle} />

        <div className="grid gap-10 pt-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-[72px] lg:pt-4">
          <div className="min-w-0">
            <section className="pt-6" aria-label="Overview">
              <p className="text-lg leading-relaxed">{publication.content.lead}</p>
              {publication.content.highlights.length ? <ul className="mt-6 grid gap-3.5">
                {publication.content.highlights.map((item) => <li key={item} className="flex items-center gap-3.5"><HandIcon name={iconForText(item)} className="size-10" />{item}</li>)}
              </ul> : null}
            </section>

            <section className="border-b border-line py-8 lg:py-10">
              <h2 className="text-2xl">What you’ll do</h2>
              <div className="mt-4 space-y-3.5 whitespace-pre-line text-ink-soft">{publication.content.description}</div>
            </section>
            {publication.content.timeline.length ? <section className="border-b border-line py-8 lg:py-10">
              <h2 className="text-2xl">How the time flows</h2>
              <ol className="mt-6 space-y-6">
                {publication.content.timeline.map((step, index) => {
                  const photo = step.photoIndex === null ? null : photos[step.photoIndex] ?? null;
                  return <li key={`${index}-${step.title}`} className="grid gap-4 sm:grid-cols-[96px_1fr]">
                    {photo ? <Photo image={photo} alt={photo.alt || `${publication.publicTitle}, ${step.title}`} aspect="" rounded="rounded-[18px]" className="size-24" sizes="96px" /> : <span className="grid size-24 place-items-center rounded-[18px] bg-sand"><HandIcon name={iconForText(`${step.title} ${step.text}`, "clock")} className="size-10" /></span>}
                    <div>{step.time ? <p className="hand text-2xl">{step.time} JST</p> : null}<h3 className="mt-1 font-extrabold">{step.title}</h3><p className="mt-1 text-ink-soft">{step.text}</p></div>
                  </li>;
                })}
              </ol>
            </section> : null}
            <section className="border-b border-line py-8 lg:py-10">
              <h2 className="text-2xl">What’s included</h2>
              <div className="mt-5 grid gap-7 sm:grid-cols-2">
                <div><h3 className="font-extrabold">Included</h3><ul className="mt-3 list-disc space-y-2 pl-5 text-ink-soft">{publication.content.included.map((value) => <li key={value}>{value}</li>)}</ul></div>
                <div><h3 className="font-extrabold">Not included</h3><ul className="mt-3 list-disc space-y-2 pl-5 text-ink-soft">{publication.content.notIncluded.map((value) => <li key={value}>{value}</li>)}</ul></div>
              </div>
            </section>
            {publication.content.knowBeforeYouGo.length || publication.content.notSuitableFor.length ? <section className="border-b border-line py-8 lg:py-10">
              <h2 className="text-2xl">Know before you go</h2>
              {publication.content.knowBeforeYouGo.length ? <ul className="mt-4 list-disc space-y-2 pl-5 text-ink-soft">{publication.content.knowBeforeYouGo.map((value) => <li key={value}>{value}</li>)}</ul> : null}
              {publication.content.notSuitableFor.length ? <><h3 className="mt-6 font-extrabold">Not suitable for</h3><ul className="mt-3 list-disc space-y-2 pl-5 text-ink-soft">{publication.content.notSuitableFor.map((value) => <li key={value}>{value}</li>)}</ul></> : null}
            </section> : null}
            {publication.meetingOverview || publication.meetingPointDisclosure === "PUBLIC" || publication.meetingPointDisclosure === "AFTER_BOOKING" ? <section className="border-b border-line py-8 lg:py-10">
              <h2 className="text-2xl">Where you’ll meet</h2>
              {publication.meetingOverview ? <p className="mt-4 whitespace-pre-line text-ink-soft">{publication.meetingOverview}</p> : null}
              {publication.meetingPointDisclosure === "PUBLIC" && publication.meetingPoint ? <div className="mt-4">
                <p className="font-extrabold">{publication.meetingPoint.name}</p>
                {publication.meetingPoint.exteriorPhotoIndex !== null && photos[publication.meetingPoint.exteriorPhotoIndex] ? <Photo image={photos[publication.meetingPoint.exteriorPhotoIndex]!} alt={photos[publication.meetingPoint.exteriorPhotoIndex]!.alt || `${publication.meetingPoint.name} exterior`} aspect="" rounded="rounded-xl" className="mt-4 h-52 w-64" sizes="256px" /> : null}
              </div> : publication.meetingPointDisclosure === "AFTER_BOOKING" ? <p className="mt-4 text-ink-soft">The meeting point is shared after your booking is confirmed.</p> : null}
            </section> : null}
          </div>

          <aside className="h-max rounded-[var(--radius-card)] border border-line bg-white p-5 lg:sticky lg:top-24">
            {offers.length ? <>
              <p className="eyebrow">From</p>
              <p className="mt-1 text-3xl font-extrabold">{formatYen(Math.min(...offers.map((offer) => offer.pricing.adultPriceYen)), "en")} <span className="text-sm font-normal">per adult</span></p>
              <p className="mt-2 text-sm text-ink-soft">{offers.map(scheduleDescription).filter((line, index, all) => all.indexOf(line) === index).join(" · ")}</p>
              {config.bookingsEnabled && config.guestBookingEnabled ? <Link href={`/experiences/${publication.slug}/book`} className="mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-ink px-6 font-extrabold text-white hover:bg-ink/90">Choose a date</Link> : <p className="mt-5 rounded-xl bg-sand p-3 text-sm text-ink-soft">Online booking is temporarily unavailable.</p>}
              <p className="mt-3 text-xs text-muted">{saleTerms?.sellerDisplayName ?? publication.sellerDisplayName} is the seller and receives the booking payment through Stripe Checkout.</p>
              <ul className="mt-5 space-y-3 border-t border-line pt-4 text-sm text-ink-soft">
                {offers.map((offer) => <li key={offer.id}><b className="text-ink">{offer.name}:</b> {cancellationSummary(offer)}{offer.minimumChargeableParticipants > 1 ? ` · Minimum charge: ${offer.minimumChargeableParticipants} guests` : ""}</li>)}
              </ul>
            </> : <p className="text-ink-soft">Online booking is not available for this experience yet.</p>}
          </aside>
        </div>
      </div>
    </div>
  </>;
}
