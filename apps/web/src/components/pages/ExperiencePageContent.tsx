import type { Metadata } from "next";
import { DetailViewV1, EN_STATIC_COPY_V1, type DetailViewModelV1, type StaticCopyAccessorV1 } from "@niho/experience-presentation/v1";
import NextLink from "next/link";
import { notFound } from "next/navigation";
import { TrackView } from "@/components/Analytics";
import { BookingCard, BookingDatesController, MobileBookingBar, type BookingSummary } from "@/components/DetailBooking";
import { bookingCardModel } from "@/lib/presentation-booking-model";
import { browseHref, readBrowseContext } from "@/lib/browse-context";
import { DesktopGallery, MobileGallery } from "@/components/DetailGallery";
import { FaceBadge } from "@/components/Face";
import { HandIcon, RubberStamp, type HandIconName } from "@/components/HandIcon";
import { JsonLd } from "@/components/JsonLd";
import { Photo } from "@/components/Photo";
import { Notice } from "@/components/ui";
import { getApi, getExperienceForSite } from "@/lib/api";
import { faceOf, groupSizeLabel, hostNames, initialOf } from "@/lib/card-model";
import { config, isPreview } from "@/lib/config";
import { childParticipationCopy, hostBio, imageAlt } from "@/lib/experience-copy";
import type { ExperienceDetailForSite, PublicImageForSite } from "@/lib/experience-types";
import type { SearchParams } from "@/lib/filters";
import { formatDuration, formatTime, formatYen } from "@/lib/format";
import { safeHttpsUrl } from "@/lib/safe-url";
import { addMinutesToClock, formatClock, scheduleLine, scheduleSummary } from "@/lib/schedule";
import { seoDescription } from "@/lib/seo-description";
import { breadcrumbJsonLd, experienceJsonLd, experienceProductJsonLd, reviewsForJsonLd } from "@/lib/structured-data";
import { iconForText } from "@/lib/themes";
import { PRESENTATION_PRIMITIVES_V1 } from "@/components/PresentationV1";
import { publicMetadata } from "@/lib/public-metadata";
import { experienceAlternates } from "@/lib/locale-metadata";
import { assertSameJapaneseRelease, getJapaneseCopy, getJapaneseDetail, getPreparedJapaneseStaticRelease, type SiteLocale } from "@/lib/localized-content";
import { JapaneseUnavailable } from "@/components/JapaneseUnavailable";
import { LocalizedLink as Link } from "@/components/LocalizedLink";
import { AskHost } from "@/components/AskHost";
import { ReviewsSection } from "@/components/ReviewsSection";
import { NO_JOURNEY_EXTRAS, type Occurrence } from "@niho-experience/api-client";
import { getJourneyExtras, getLiveReviews } from "@/lib/journey";
import { askHostTarget, conditionRows } from "@/lib/journey-ui";
import { reviewDisplay, reviewHeadline } from "@/lib/reviews-ui";
import { ExperienceCardGrid, GuideTeasers } from "@/components/GuideBlocks";
import { relatedExperienceCards } from "@/lib/experience-cards";
import { guidesAboutExperience } from "@/lib/guide-registry";
import { videoForExperience } from "@/lib/videos";
import { YouTubeVideo } from "@/components/YouTubeVideo";
import { dayOption } from "@/lib/date-filter";
import { detailFromTokyoLine, detailGuideHeading, detailNextDates } from "@/lib/detail-page";
import { bookingSourceOf, detailForSale, guestBookingSale, japaneseBookingOpen, siteNextDates, type GuestBookingSale } from "@/lib/guest-booking-source";

type BlockProps = Record<string, unknown>;
const blockText = (props: BlockProps, key: string, fallback: string) => typeof props[key] === "string" ? String(props[key]) : fallback;

export type ExperiencePageContentProps = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams>; locale: SiteLocale };
async function readExperience(slug: string, query: SearchParams, locale: SiteLocale = "en") {
  if (locale === "ja") return (await getJapaneseDetail(slug)).experience;
  const result = await getExperienceForSite(slug, query);
  if (!result.ok) {
    if (result.kind === "not_found") notFound();
    throw new Error("Public experience unavailable");
  }
  return result.data.experience;
}

/** Availability is authoritative and no-store in the public client. Failure or release mismatch means no band. */
async function readInitialAvailability(slug: string, query: SearchParams, locale: SiteLocale, releaseId: string | null): Promise<Occurrence[]> {
  try {
    const api = await getApi(query);
    if (locale === "ja") {
      if (!releaseId) return [];
      const result = await api.getJapaneseAvailability(slug);
      return result.ok && result.data.releaseId === releaseId ? detailNextDates(result.data.occurrences) : [];
    }
    const result = await api.getAvailability(slug);
    return result.ok ? detailNextDates(result.data.occurrences) : [];
  } catch {
    return [];
  }
}
export async function englishExperienceMetadata({ params, searchParams }: Omit<ExperiencePageContentProps, "locale">): Promise<Metadata> {
  const e = await readExperience((await params).slug, await searchParams);
  const description = seoDescription(e.lead);
  // The public image DTO has no rights/OG approval flag. Do not publish a
  // provisional image as a share image until approved photos are available.
  return { ...publicMetadata(e.title, description, e.canonicalUrl), alternates: await experienceAlternates(e.slug, e.canonicalUrl) };
}
export async function japaneseExperienceMetadata({ params }: Omit<ExperiencePageContentProps, "locale">): Promise<Metadata> {
  try {
    const slug = (await params).slug;
    // The /ja layout renders nothing but "unavailable" without the static release: no hreflang or index for that.
    const [detail, copy, release] = await Promise.all([getJapaneseDetail(slug), getJapaneseCopy(), getPreparedJapaneseStaticRelease()]);
    assertSameJapaneseRelease(copy.releaseId, detail, release);
    const canonical = `${config.siteUrl}/ja/experiences/${detail.experience.slug}`;
    const english = `${config.siteUrl}/experiences/${detail.experience.slug}`;
    return { title: detail.experience.title, description: seoDescription(detail.experience.lead), alternates: { canonical, languages: { en: english, ja: canonical, "x-default": english } }, robots: config.indexingAllowed ? undefined : { index: false, follow: false }, openGraph: { title: detail.experience.title, description: seoDescription(detail.experience.lead), url: canonical, locale: "ja_JP", images: [] } };
  } catch { return { title: "Japanese experience unavailable", robots: { index: false, follow: false } }; }
}

/** Cover first, then the other photos, without repeating the cover. */
function galleryPhotos(e: ExperienceDetailForSite): PublicImageForSite[] {
  const seen = new Set<string>();
  return [e.cover, ...e.photos].filter((photo): photo is PublicImageForSite => {
    if (!photo || seen.has(photo.url)) return false;
    seen.add(photo.url);
    return true;
  });
}

function durationFact(e: ExperienceDetailForSite, locale: SiteLocale, copy: StaticCopyAccessorV1): { main: string; sub: string | null } {
  const durations = [...new Set(e.offers.map((offer) => offer.durationMinutes))].sort((a, b) => a - b);
  const main = durations.length ? (durations.length === 1 ? formatDuration(durations[0]!, locale) : `${formatDuration(durations[0]!, locale)}–${formatDuration(durations.at(-1)!, locale)}`) : copy.text("detail.notListed");
  const first = e.offers[0];
  const sameTimes = first && e.offers.every((offer) => offer.startTime === first.startTime && offer.durationMinutes === first.durationMinutes);
  const sub = first && sameTimes ? `${formatClock(first.startTime, locale)} – ${formatClock(addMinutesToClock(first.startTime, first.durationMinutes), locale)} JST` : first ? copy.text("detail.chooseDate") : null;
  return { main, sub };
}

function shorten(text: string, max: number): string {
  const clean = text.replace(/\.$/, "");
  if (clean.length <= max) return clean;
  const space = clean.lastIndexOf(" ", max - 1);
  return `${clean.slice(0, space > 0 ? space : max - 1)}…`;
}

/** "English, with an English-speaking guide" → "English" / "with an English-speaking guide"; otherwise the note and "language". */
function languageFact(note: string): { main: string; sub: string } {
  const split = /^(.+?),\s+(with .+)$/i.exec(note.trim());
  return split ? { main: split[1]!, sub: split[2]! } : { main: note, sub: "language" };
}

/** "2-minute walk from Kamakura Station West Exit." → "2-minute walk" / "from Kamakura Station West Exit". */
function accessFact(accessNote: string, placeName: string): { main: string; sub: string } {
  const split = /^(.{3,24}?)\s+(from .+)$/i.exec(accessNote.replace(/\.$/, ""));
  return split ? { main: split[1]!, sub: shorten(split[2]!, 40) } : { main: shorten(accessNote, 44), sub: placeName };
}

export async function ExperiencePageContent({ params, searchParams, locale }: ExperiencePageContentProps) {
  const query = await searchParams;
  const slug = (await params).slug;
  let e: ExperienceDetailForSite, copy = EN_STATIC_COPY_V1, japaneseBookingReady = true, japaneseReleaseId: string | null = null;
  // Where this experience is sold (#285): NIHO, this site (the sale comes from the experience DB), or unknown (not bookable now).
  let sale: GuestBookingSale = { kind: "niho" };
  try {
    if (locale === "ja") {
      const [selected, siteCopy, selectedSale] = await Promise.all([getJapaneseDetail(slug), getJapaneseCopy(), guestBookingSale(slug)]);
      assertSameJapaneseRelease(siteCopy.releaseId, selected);
      sale = selectedSale;
      e = selected.experience; copy = siteCopy.copy; japaneseBookingReady = japaneseBookingOpen(sale, selected); japaneseReleaseId = selected.releaseId;
    } else {
      const detail = await readExperience(slug, query);
      sale = await guestBookingSale(detail.slug);
      e = detailForSale(detail, sale);
    }
  } catch (error) {
    if (locale === "ja") return <JapaneseUnavailable />;
    throw error;
  }
  // Conditions, questions to the host and the FAQ have no NIHO contract yet: the mock serves them, a real API shows none (src/lib/journey.ts).
  // Related experiences and guides are English-only for now; both disappear when there are none or the catalogue cannot be read.
  const [extras, relatedCards, liveReviews] = locale === "en"
    ? await Promise.all([getJourneyExtras(e.slug, query), relatedExperienceCards(e.slug, query), getLiveReviews(e.slug)])
    : [NO_JOURNEY_EXTRAS, [], null];
  // 予約者のレビュー kept in the experience DB (#104; http mode with its flag only) take the extras' place.
  const journey = liveReviews ? { ...extras, reviews: liveReviews } : extras;
  const relatedGuides = locale === "en" ? await guidesAboutExperience(e.slug) : { guides: [], draftSlugs: [] };
  const checkoutCancelled = query.checkout === "cancelled";
  const browseContext = readBrowseContext(query);
  const preferredOfferId = typeof query.offer === "string" && e.offers.some((offer) => offer.id === query.offer) ? query.offer : undefined;
  const bookingHref = browseHref(`/experiences/${e.slug}/book`, browseContext, preferredOfferId);
  const sellerLegalUrl = safeHttpsUrl(e.seller.legalNoticeUrl);
  // One policy for every option: show it here so travelers see it before choosing a date.
  const firstPolicy = e.offers[0]?.cancellationPolicy;
  const sharedPolicy = firstPolicy && e.offers.every((offer) =>
    offer.cancellationPolicy.code === firstPolicy.code &&
    offer.cancellationPolicy.freeCancellationHoursBefore === firstPolicy.freeCancellationHoursBefore
  ) ? firstPolicy : null;
  const policyTitle = sharedPolicy
    ? sharedPolicy.code === "NONE"
      ? copy.text("detail.nonRefundable")
      : locale === "ja" ? `開始${sharedPolicy.freeCancellationHoursBefore}時間前までキャンセル無料` : `Free cancellation until ${sharedPolicy.freeCancellationHoursBefore} hours before the start`
    : null;
  const photos = galleryPhotos(e);
  const video = locale === "en" && e.cover ? videoForExperience(e.slug) : null;
  const line = scheduleLine(e.offers, { locale });
  const duration = durationFact(e, locale, copy);
  const children = childParticipationCopy(e.offers, locale);
  const group = groupSizeLabel(e.offers, locale, copy);
  const meeting = e.meetingPointDisclosure === "PUBLIC" ? e.meetingPoint : null;
  const meetingOverview = "meetingOverview" in e && typeof e.meetingOverview === "string" ? e.meetingOverview : null;
  const exterior = meeting && meeting.exteriorPhotoIndex !== null ? (e.photos[meeting.exteriorPhotoIndex] ?? null) : null;
  const mapUrl = meeting?.mapUrl ? safeHttpsUrl(meeting.mapUrl) : null;
  const paragraphs = e.description.split(/\n\s*\n/).filter((paragraph) => paragraph.trim());
  // Owner decision 2026-10-20 (the approved mock): the second photo, or the cover, inside the stamp edge.
  // Hosts' own faces stay on the chips next to their names.
  const hostPhoto = e.photos[1] ?? e.cover ?? null;
  const modes = new Set(e.offers.map((offer) => offer.acceptanceMode));
  const acceptanceNote =
    modes.size === 1 && modes.has("APPROVAL")
      ? copy.text("booking.approvalNote")
      : modes.size === 1 && modes.has("INSTANT")
        ? copy.text("booking.instantNote")
        : copy.text("detail.policyApplies");
  const adultPrices = e.offers.map((offer) => offer.pricing.adultPriceYen);
  const canBook = config.bookingsEnabled && e.booking.checkoutAvailable && japaneseBookingReady;
  const approval = e.offers.filter((offer) => offer.acceptanceMode === "APPROVAL").length;
  const upcomingDates = !canBook ? [] : sale.kind === "site" ? await siteNextDates(e.slug) : await readInitialAvailability(e.slug, query, locale, japaneseReleaseId);
  const hostStoryGuide = relatedGuides.guides.find((guide) => "pillar" in guide && guide.pillar === "hosts" && !relatedGuides.draftSlugs.includes(guide.slug));

  const assurances: BookingSummary["assurances"] = [];
  if (sharedPolicy) {
    assurances.push({
      icon: "check",
      text: sharedPolicy.code === "NONE" ? copy.text("detail.nonRefundable") : (locale === "ja" ? `${sharedPolicy.freeCancellationHoursBefore}時間前までキャンセル無料` : `Free cancellation until ${sharedPolicy.freeCancellationHoursBefore} h before`),
    });
  }
  if (approval) {
    assurances.push({
      icon: "people",
      text:
        approval === e.offers.length
          ? locale === "en" ? "Your hosts confirm each request — you're only charged if they accept" : copy.text("booking.approvalNote")
          : locale === "en" ? "Some options are confirmed by your hosts — you're only charged if they accept" : copy.text("detail.policyApplies"),
    });
  }
  assurances.push({ icon: "mail", text: copy.text("detail.noAccount") }, { icon: "card", text: copy.text("detail.secureStripe") });

  const booking: BookingSummary = {
    slug: e.slug,
    offers: e.offers.map((offer) => ({ id: offer.id, name: offer.name, adultPriceYen: offer.pricing.adultPriceYen })),
    price: adultPrices.length ? formatYen(Math.min(...adultPrices), locale) : "—",
    priceIsFrom: new Set(adultPrices).size > 1,
    childNote: children.price,
    schedule: scheduleSummary(e.offers, locale),
    canBook,
    assurances,
    preview: isPreview,
    availabilityIsProvisional: isPreview && config.mockCatalog === "pilot",
    bookingSource: bookingSourceOf(sale),
    browseContext,
    preferredOfferId,
  };

  const hostFaces = e.hosts.length
    ? e.hosts.map((host) => ({ name: host.displayName, initial: initialOf(host.displayName), image: host.avatar }))
    : [faceOf(e)];

  const renderDetail = (props: BlockProps = {}, includeBooking = true) => (
    // clip (not hidden) keeps the tilted stamp from widening the page without breaking the sticky card and bar.
    <div className="overflow-x-clip">
      <MobileGallery photos={photos} title={e.title} backHref={browseHref("/experiences", browseContext)} />

      <div className="container-page">
        <nav aria-label="Breadcrumb" className="hidden pt-7 text-sm text-muted lg:block">
          <Link href={browseHref("/experiences", browseContext)} className="font-extrabold text-ink hover:underline">
            Experiences
          </Link>
          <span aria-hidden> / </span>
          <span aria-current="page">{e.title}</span>
        </nav>
        {checkoutCancelled ? (
          <div className="mt-5">
            <Notice
              tone="info"
              title="Checkout cancelled"
              role="status"
              action={
                <Link href={bookingHref} className="font-bold text-moss underline underline-offset-4">
                  Choose a date
                </Link>
              }
            />
          </div>
        ) : null}

        <header className="pt-5 lg:pt-3.5">
          {line ? <p className="eyebrow">{line}</p> : null}
          <h1 className="mt-1.5 text-[2.125rem] leading-[1.1] lg:max-w-[20ch] lg:text-[3.25rem]">{e.title}</h1>
          <div className="mt-4 flex flex-wrap items-center gap-2.5 text-[0.9375rem] text-ink-soft">
            <span className="flex">
              {hostFaces.map((face, index) => (
                <FaceBadge key={`${face.name}-${index}`} face={face} className={`size-[38px] rounded-full border-2 border-white text-sm ${index ? "-ml-2.5" : ""}`} sizes="38px" />
              ))}
            </span>
            <span>
              Hosted by <b className="text-ink">{hostNames(e)}</b>
              {e.hosts.length ? <> {e.provider.kind === "SPOT" ? "at" : "of"} {e.provider.name}</> : null}
            </span>
          </div>
          <ul className="mt-[18px] grid grid-cols-2 gap-x-3 gap-y-4 border-y border-line py-[18px] lg:mt-[22px] lg:flex lg:flex-wrap lg:gap-x-9 lg:border-0 lg:py-0">
            <Fact icon="clock" label="Duration" main={duration.main} sub={duration.sub} />
            <Fact icon="chat" label="Language" {...languageFact(e.languageNote)} />
            {group ? <Fact icon="people" label="Group size" main={group} sub={children.fact ?? "small group"} /> : null}
            {meeting?.accessNote ? <Fact icon="train" label="Getting there" {...accessFact(meeting.accessNote, meeting.name)} /> : null}
          </ul>
        </header>

        <DesktopGallery photos={photos} title={e.title} />

        <div className={includeBooking ? "grid gap-10 pt-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-[72px] lg:pt-4" : "grid gap-10 pt-6 lg:pt-4"}>
          <div className="min-w-0">
            <section className="pt-6" aria-label="Overview">
              <p className="text-lg leading-relaxed">{e.lead}</p>
              {e.highlights.length ? (
                <ul className="mt-6 grid gap-3.5">
                  {e.highlights.map((item) => (
                    <li key={item} className="flex items-center gap-3.5">
                      <HandIcon name={iconForText(item)} className="size-10" />
                      {item}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>

            <Section title={blockText(props, "overviewHeading", "What you'll do")}>
              <div className="space-y-3.5 text-ink-soft">
                {paragraphs.slice(0, 2).map((paragraph, i) => (
                  <p key={i}>{paragraph}</p>
                ))}
              </div>
              {paragraphs.length > 2 ? (
                <details className="group mt-4">
                  <summary className="link-leaf w-max cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                    <span className="group-open:hidden">Read more</span>
                    <span className="hidden group-open:inline">Show less</span>
                  </summary>
                  <div className="mt-3.5 space-y-3.5 text-ink-soft">
                    {paragraphs.slice(2).map((paragraph, i) => (
                      <p key={i}>{paragraph}</p>
                    ))}
                  </div>
                </details>
              ) : null}
            </Section>

            {e.timeline.length ? (
              <Section title={blockText(props, "detailsHeading", "How the time flows")}>
                <ol>
                  {e.timeline.map((step, i) => {
                    const photo = step.photoIndex !== null ? (e.photos[step.photoIndex] ?? null) : null;
                    return (
                      <li key={i} className="relative grid grid-cols-[96px_1fr] gap-4 pb-[22px] lg:grid-cols-[130px_1fr] lg:gap-[22px]">
                        {i < e.timeline.length - 1 ? (
                          <span aria-hidden className="absolute top-[102px] bottom-1 left-12 border-l-2 border-dashed border-line-strong lg:top-[136px] lg:left-[65px]" />
                        ) : null}
                        {photo ? (
                          <Photo image={photo} alt={imageAlt(photo, `${e.title}, ${step.title}`)} aspect="" rounded="rounded-[18px]" className="size-24 lg:size-[130px]" sizes="130px" />
                        ) : (
                          <span className="grid size-24 place-items-center rounded-[18px] bg-sand lg:size-[130px]">
                            <HandIcon name={iconForText(`${step.title} ${step.text}`, "clock")} className="size-[42px]" />
                          </span>
                        )}
                        <div>
                          {step.time ? <p className="hand text-[1.5625rem]">{formatClock(step.time)}</p> : null}
                          <h3 className="mt-1 font-sans text-[1.0625rem] leading-[1.6] font-extrabold tracking-normal">{step.title}</h3>
                          <p className="mt-0.5 text-[0.9375rem] text-ink-soft">{step.text}</p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </Section>
            ) : null}

            <Section title={e.hosts.length > 1 ? "Your hosts" : e.hosts.length ? "Your host" : "Who runs it"}>
              <div className={`grid items-center gap-[30px] sm:gap-10 ${hostPhoto ? "sm:grid-cols-[300px_1fr]" : "sm:grid-cols-[140px_1fr]"}`}>
                {hostPhoto ? (
                  <div className="postage aspect-[5/4] w-[min(100%,320px)] justify-self-center">
                    <div className="postage-paper [--pad:11px]">
                      <Photo image={hostPhoto} alt="" aspect="" rounded="" className="h-full w-full" sizes="320px" />
                    </div>
                    <RubberStamp className="absolute -right-3 -bottom-[26px] size-[100px] -rotate-[14deg] text-moss" />
                  </div>
                ) : (
                  <RubberStamp className="size-[132px] -rotate-[10deg] justify-self-center text-moss sm:justify-self-start" />
                )}
                <div>
                  {e.provider.tagline ? <p className="hand text-[1.8125rem] leading-[1.12]">“{e.provider.tagline}”</p> : null}
                  <p className="mt-3 text-ink-soft">
                    Offered by <strong className="text-ink">{e.provider.name}</strong>.
                  </p>
                  {e.hosts.length ? (
                    <ul className="mt-4 flex flex-wrap gap-2">
                      {e.hosts.map((host) => (
                        <li key={host.displayName} className="flex items-center gap-2 rounded-full bg-sand py-1 pr-3.5 pl-1 text-sm font-extrabold">
                          <FaceBadge face={{ name: host.displayName, initial: initialOf(host.displayName), image: host.avatar }} className="size-8 rounded-full text-[0.8125rem]" sizes="32px" />
                          {host.displayName}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            </Section>

            <Section title="What's included">
              <div className="grid gap-[26px] sm:grid-cols-2">
                <IconList title="Included" items={e.included} icon="check" iconClass="text-moss" />
                <IconList title="Not included" items={e.notIncluded} icon="cross" iconClass="text-muted" />
              </div>
            </Section>

            <Section title="Where you'll meet">
              {meetingOverview ? <p className="mb-4 leading-relaxed text-ink-soft">{meetingOverview}</p> : null}
              {meeting ? (
                <div className={`grid items-start gap-5 ${exterior ? "sm:grid-cols-[200px_1fr] sm:gap-7" : ""}`}>
                  {exterior ? (
                    <div className="arch relative aspect-[3/4] w-[190px] sm:w-[200px]">
                      <Photo image={exterior} alt={imageAlt(exterior, `${meeting.name} from outside`)} aspect="" rounded="" className="h-full w-full" sizes="200px" />
                    </div>
                  ) : null}
                  <div>
                    <p className="text-[1.0625rem] font-extrabold">{meeting.name}</p>
                    {meeting.address ? <p className="mt-1.5 text-[0.96875rem] text-ink-soft">{meeting.address}</p> : null}
                    {meeting.accessNote ? (
                      <p className="mt-3 flex items-center gap-2 font-extrabold">
                        <HandIcon name="train" className="size-[30px]" />
                        {meeting.accessNote}
                      </p>
                    ) : null}
                    {meeting.entranceNote ? <p className="mt-1.5 text-[0.96875rem] text-ink-soft">{meeting.entranceNote}</p> : null}
                    {mapUrl ? (
                      <a href={mapUrl} rel="noopener noreferrer" className="link-leaf mt-3.5 inline-block text-[0.9375rem]">
                        Open in Maps
                      </a>
                    ) : null}
                  </div>
                </div>
              ) : (
                <p className="flex items-center gap-2">
                  <HandIcon name="pin" className="size-7 text-moss" />
                  The meeting point is shared after your booking is confirmed.
                </p>
              )}
            </Section>

            {e.knowBeforeYouGo.length || e.notSuitableFor.length ? (
              <Section title="Good to know">
                {e.knowBeforeYouGo.length ? (
                  <>
                    <DotList items={e.knowBeforeYouGo.slice(0, 3)} />
                    {e.knowBeforeYouGo.length > 3 ? (
                      <details className="group mt-3">
                        <summary className="link-leaf w-max cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                          <span className="group-open:hidden">Show all {e.knowBeforeYouGo.length}</span>
                          <span className="hidden group-open:inline">Show fewer</span>
                        </summary>
                        <div className="mt-3">
                          <DotList items={e.knowBeforeYouGo.slice(3)} />
                        </div>
                      </details>
                    ) : null}
                  </>
                ) : null}
                {e.notSuitableFor.length ? (
                  <div className="mt-[26px]">
                    <IconList title="Not suitable for" items={e.notSuitableFor} icon="cross" iconClass="text-muted" />
                  </div>
                ) : null}
              </Section>
            ) : null}

            <Section title="Cancellation">
              {sharedPolicy ? (
                <div className="flex items-start gap-3.5 rounded-[22px] bg-sand p-5">
                  <HandIcon name="umbrella" className="size-[38px] text-moss" />
                  <div>
                    <p className="text-[1.0625rem] font-extrabold">{policyTitle}</p>
                    <p className="mt-1 text-[0.9375rem] text-ink-soft">{acceptanceNote}</p>
                  </div>
                </div>
              ) : (
                <p>Choose an option to see its cancellation policy before checkout.</p>
              )}
              <p className="mt-3.5 text-sm text-muted">
                Sold by <strong className="text-ink">{e.seller.displayName}</strong>
                {sellerLegalUrl ? (
                  <>
                    {" · "}
                    <a href={sellerLegalUrl} className="font-extrabold text-ink underline" rel="noopener noreferrer">
                      Seller information
                    </a>
                  </>
                ) : null}
              </p>
            </Section>
          </div>

          {includeBooking ? <aside id="book" aria-labelledby="book-heading" className="hidden lg:sticky lg:top-[88px] lg:block lg:self-start lg:pt-12">
            <BookingCard summary={booking} />
          </aside> : null}
        </div>
      </div>
    </div>
  );
  // Keep the previous code-native detail composition available for a future
  // code review without making it part of the active rendering choice.
  void renderDetail;
  const portableDetail = (props: BlockProps = {}, includeBooking = true) => {
    const toImage = (photo: PublicImageForSite | null, fallback = "") => photo ? { src: photo.url, alt: imageAlt(photo, fallback) } : null;
    const model: DetailViewModelV1 = {
      title: e.title,
      locationLine: detailFromTokyoLine(e.region.name, meeting?.accessNote, locale),
      backHref: browseHref("/experiences", browseContext),
      gallery: {
        title: e.title,
        backHref: browseHref("/experiences", browseContext),
        photos: photos.map((photo, index) => {
          const alt = imageAlt(photo, index === 0 || locale === "ja" ? e.title : `${e.title}, photo ${index + 1} of ${photos.length}`);
          return { image: { src: photo.url, alt }, alt };
        }),
      },
      schedule: line ?? undefined,
      hosts: hostFaces.map((face) => ({ ...face, image: toImage(face.image) })),
      hostLine: copy.rich(e.hosts.length ? (e.provider.kind === "SPOT" ? "detail.hostedAtRich" : "detail.hostedOfRich") : "detail.hostedByRich", { hosts: hostNames(e), provider: e.provider.name }),
      facts: [
        { icon: "clock", label: copy.text("detail.durationLabel"), main: duration.main, sub: duration.sub },
        { icon: "chat", label: copy.text("detail.languageLabel"), ...languageFact(e.languageNote) },
        ...(group ? [{ icon: "people" as const, label: copy.text("detail.groupSize"), main: group, sub: children.fact ?? copy.text("detail.smallGroup") }] : []),
        ...(meeting?.accessNote ? [{ icon: "train" as const, label: copy.text("detail.gettingThere"), ...accessFact(meeting.accessNote, meeting.name) }] : []),
      ],
      lead: e.lead,
      highlights: e.highlights.map((text) => ({ text, icon: iconForText(text) })),
      paragraphs,
      timeline: e.timeline.map((step) => ({ time: step.time ? formatClock(step.time, locale) : undefined, title: step.title, text: step.text, icon: iconForText(`${step.title} ${step.text}`, "clock"), photo: toImage(step.photoIndex !== null ? (e.photos[step.photoIndex] ?? null) : null, `${e.title}, ${step.title}`) })),
      // Host introductions (v1.1 `hosts[].bio`) as plain text, on the English page only: the Japanese release has no approved translation of them.
      provider: { name: e.provider.name, tagline: e.provider.tagline ?? undefined, photo: toImage(hostPhoto), hosts: hostFaces.map((face) => ({ ...face, image: toImage(face.image) })), bios: locale === "en" ? e.hosts.flatMap((host) => { const text = hostBio(host); return text ? [{ name: host.displayName, text }] : []; }) : undefined, storyLink: hostStoryGuide ? { href: `/guides/${hostStoryGuide.slug}`, label: "Read the host story" } : undefined },
      included: e.included,
      notIncluded: e.notIncluded,
      emptyListLabel: copy.text("detail.noneListed"),
      meeting: meeting ? { kind: "location", overview: meetingOverview ?? undefined, name: meeting.name, address: meeting.address ?? undefined, accessNote: meeting.accessNote ?? undefined, entranceNote: meeting.entranceNote ?? undefined, mapUrl: mapUrl ?? undefined, exterior: toImage(exterior, locale === "ja" ? meeting.name : `${meeting.name} from outside`) } : { kind: "after-booking", overview: meetingOverview ?? undefined },
      know: e.knowBeforeYouGo,
      conditions: journey.conditions ? conditionRows(journey.conditions) : undefined,
      askHost: journey.questionsOpen ? <AskHost slug={e.slug} target={askHostTarget(hostNames(e))} face={faceOf(e)} preview={isPreview} nihoWebOrigin={config.nihoWebOrigin} /> : undefined,
      reviewHeadline: reviewHeadline(reviewDisplay(journey.reviews)) ?? undefined,
      reviews: journey.reviews ? { title: "Reviews", content: <ReviewsSection slug={e.slug} reviews={journey.reviews} preview={isPreview} nihoWebOrigin={config.nihoWebOrigin} /> } : undefined,
      faq: journey.faq.length ? { title: "Questions before you book", items: journey.faq } : undefined,
      // Same no-store public availability as the booking controls. The API has no bookingClosesAt, so the band shows no cutoff or seat count.
      upcoming: upcomingDates.length ? <NextDateBand dates={upcomingDates} locale={locale} bookingHref={bookingHref} /> : undefined,
      video: video && e.cover ? <YouTubeVideo video={video} poster={e.cover.url} title={e.title} /> : undefined,
      relatedGuides: relatedGuides.guides.length ? {
        eyebrow: "Guides",
        title: detailGuideHeading(e.region.name, meeting?.accessNote, e.offers.map((offer) => offer.startTime)),
        content: <GuideTeasers guides={relatedGuides.guides} draftSlugs={relatedGuides.draftSlugs} columns="three" variant="detail" />,
      } : undefined,
      showAllKnowLabel: copy.text("detail.showAllCount", { count: e.knowBeforeYouGo.length }),
      notSuitable: e.notSuitableFor,
      cancellation: { policy: sharedPolicy && policyTitle ? { title: policyTitle, acceptanceNote } : undefined, sellerName: e.seller.displayName, sellerLegalUrl: sellerLegalUrl ?? undefined },
      booking: includeBooking ? bookingCardModel(booking, <BookingDatesController summary={booking} />) : undefined,
      checkoutCancelled: !japaneseBookingReady ? <div className="mt-5"><Notice tone="warn" title={copy.text("booking.unavailableJa")} role="status" action={sale.kind === "niho" ? undefined : <EnglishPageLink slug={e.slug} />} /></div>
        : checkoutCancelled ? <div className="mt-5">{sale.kind === "site" ? <SiteCheckoutCancelled bookingHref={bookingHref} /> : <Notice tone="info" title={copy.text("detail.checkoutCancelled")} role="status" action={<Link href={bookingHref} className="font-bold text-moss underline underline-offset-4">{copy.text("detail.chooseDate")}</Link>} />}</div> : undefined,
    };
    return <DetailViewV1 model={model} primitives={PRESENTATION_PRIMITIVES_V1} copy={copy} headings={{ overview: blockText(props, "overviewHeading", copy.text("detail.whatYouDo")), details: blockText(props, "detailsHeading", copy.text("detail.timeline")) }} />;
  };
  return <>
    {locale === "en" ? <TrackView event="experience_view" props={{ experience: e.slug }} /> : null}
    <JsonLd data={breadcrumbJsonLd(config.siteUrl, locale === "ja"
      ? [{ name: "ホーム", path: "/ja" }, { name: copy.text("chrome.experiences"), path: "/ja/experiences" }, { name: e.title, path: `/ja/experiences/${e.slug}` }]
      : [{ name: "Home", path: "/" }, { name: "Experiences", path: "/experiences" }, { name: e.title, path: `/experiences/${e.slug}` }])} />
    <JsonLd data={experienceJsonLd(e, config.siteUrl, isPreview, canBook, reviewsForJsonLd(journey.reviews), locale)} />
    <JsonLd data={experienceProductJsonLd(e, config.siteUrl, isPreview, canBook, reviewsForJsonLd(journey.reviews), locale)} />
    {portableDetail()}
    {relatedCards.length ? <div className="container-page">
      {relatedCards.length ? <section aria-labelledby="related-experiences-heading" className="pt-14">
        <h2 id="related-experiences-heading" className="mb-6 text-[1.75rem] lg:text-[2rem]">More experiences in Kamakura</h2>
        <ExperienceCardGrid cards={relatedCards} />
      </section> : null}
    </div> : null}
    <MobileBookingBar summary={booking} />
  </>;
}

/**
 * Stripe's cancel URL for an experience sold here (#285): `?checkout=cancelled`, which carries nothing else. The
 * guest's hold stays until it expires, and nothing was charged.
 */
function SiteCheckoutCancelled({ bookingHref }: { bookingHref: string }) {
  return (
    <Notice
      tone="info"
      title="Payment was not completed"
      role="status"
      action={<Link href={bookingHref} className="font-bold text-moss underline underline-offset-4">Choose a date</Link>}
    >
      You haven&apos;t been charged. You can choose a date and try again.
    </Notice>
  );
}

/** Japanese booking of an experience sold here (or that may be) waits for #285 slice 10; the English page takes bookings. */
function EnglishPageLink({ slug }: { slug: string }) {
  return <NextLink href={`/experiences/${slug}`} hrefLang="en" lang="en" className="font-bold text-moss underline underline-offset-4">View the English page</NextLink>;
}

function NextDateBand({ dates, locale, bookingHref }: { dates: readonly Occurrence[]; locale: SiteLocale; bookingHref: string }) {
  const [next, ...later] = dates;
  if (!next) return null;
  const label = locale === "ja"
    ? { next: "次回", more: "ほかの日程", all: "すべての日程" }
    : { next: "Next date", more: "More dates", all: "All dates" };
  return (
    <div data-next-date-band className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[18px] bg-leaf-pale px-4 py-3 text-[0.875rem] sm:px-5">
      <p className="font-extrabold text-moss">
        <span className="mr-2 text-[0.75rem] tracking-[0.08em] uppercase">{label.next}</span>
        <time dateTime={next.startAt}>{dayOption(next.date, locale).label} · {formatTime(next.startAt, locale)} JST</time>
      </p>
      {later.length ? (
        <p className="flex flex-wrap items-center gap-1.5 text-ink-soft">
          <span className="sr-only">{label.more}: </span>
          {later.map((occurrence) => <time key={`${occurrence.offerId}-${occurrence.date}`} dateTime={occurrence.startAt} className="rounded-full bg-white/75 px-2.5 py-1 font-bold">{dayOption(occurrence.date, locale).label}</time>)}
        </p>
      ) : null}
      <a href="#book" className="link-leaf ml-auto hidden shrink-0 lg:inline">{label.all}</a>
      <Link href={bookingHref} className="link-leaf ml-auto shrink-0 lg:hidden">{label.all}</Link>
    </div>
  );
}

function Fact({ icon, label, main, sub = null }: { icon: HandIconName; label: string; main: string; sub?: string | null }) {
  return (
    <li className="flex items-center gap-2.5 text-[0.9375rem] leading-tight font-extrabold">
      <HandIcon name={icon} className="size-8" />
      <div>
        <span className="sr-only">{label}: </span>
        {main}
        {sub ? <small className="block text-[0.78125rem] font-bold text-muted">{sub}</small> : null}
      </div>
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pt-12">
      <h2 className="mb-[18px] text-[1.75rem] lg:text-[2rem]">{title}</h2>
      {children}
    </section>
  );
}

function IconList({ title, items, icon, iconClass }: { title: string; items: string[]; icon: HandIconName; iconClass: string }) {
  return (
    <div>
      <h3 className="mb-3 font-sans text-sm font-extrabold tracking-[0.04em] text-muted uppercase">{title}</h3>
      {items.length ? (
        <ul className="space-y-2.5">
          {items.map((item) => (
            <li key={item} className="flex items-start gap-2.5">
              <HandIcon name={icon} className={`mt-px size-[26px] ${iconClass}`} />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">None listed.</p>
      )}
    </div>
  );
}

function DotList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2.5 text-ink-soft">
      {items.map((item) => (
        <li key={item} className="flex gap-3">
          <span aria-hidden className="mt-[0.6em] size-[7px] shrink-0 rounded-full bg-leaf" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
