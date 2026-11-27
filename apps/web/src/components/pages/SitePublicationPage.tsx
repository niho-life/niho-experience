import Link from "next/link";
import type { Metadata } from "next";
import { TrackView } from "@/components/Analytics";
import { DesktopGallery, MobileGallery } from "@/components/DetailGallery";
import { ExperienceCardGrid, GuideTeasers } from "@/components/GuideBlocks";
import { CategoryIcon } from "@/components/CategoryIcon";
import { HandIcon } from "@/components/HandIcon";
import { JsonLd } from "@/components/JsonLd";
import { MapboxLocationMap } from "@/components/MapboxLocationMap";
import { SitePublicationDatePicker } from "@/components/pages/SitePublicationDatePicker";
import { Photo } from "@/components/Photo";
import { ReviewsSection } from "@/components/ReviewsSection";
import { config } from "@/lib/config";
import { areaLabel, categoryHand, categoryLabel } from "@/lib/experience-categories";
import { loadClassificationOf } from "@/lib/experience-categories-server";
import { jaYen } from "@/lib/ja-catalog";
import { inquiryHref } from "@/lib/group-inquiry-entry";
import { detailGuideHeading, detailTokyoRailLine, publicStationAccess } from "@/lib/detail-page";
import { siteNextDates } from "@/lib/guest-booking-source";
import { guidesAboutExperience } from "@/lib/guide-registry";
import { formatDuration, formatYen } from "@/lib/format";
import { iconForText } from "@/lib/themes";
import { publicMetadata } from "@/lib/public-metadata";
import { seoDescription } from "@/lib/seo-description";
import { cancellationLines, scheduleDescription } from "@/lib/experience/site-card-model";
import { providerNameFor } from "@/lib/experience/provider-name";
import type { SitePublicExperience } from "@/lib/experience/site-publications";
import { relatedSiteExperienceCards } from "@/lib/experience/site-related";
import { siteSellerInformationHref } from "@/lib/experience/site-seller-information";
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
    title: !ja && publication.slug === "community-dinner-with-locals"
      ? "Kamakura Cooking & Dinner with Locals"
      : base.title,
    // 日本語のみの商品には英語のページが無いので、hreflang の組を作らず canonical だけにする。
    alternates: publication.japaneseOnly
      ? { canonical }
      : { canonical, languages: publication.japanese && config.japaneseSiteEnabled ? { en: english, ja: japanese, "x-default": english } : { en: english, "x-default": english } },
    openGraph: { ...base.openGraph, locale: ja ? "ja_JP" : "en_US" },
    robots: config.indexingAllowed ? undefined : { index: false, follow: false },
  };
}

const NO_GUIDES: Awaited<ReturnType<typeof guidesAboutExperience>> = { guides: [], draftSlugs: [] };

export async function SitePublicationPage({ item, cancelled = false, locale = "en" }: { item: SitePublicExperience; cancelled?: boolean; locale?: "en" | "ja" }) {
  const { publication, saleTerms, hostBio } = item;
  const ja = locale === "ja";
  const sellerInformationHref = siteSellerInformationHref(item, locale);
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
  const included = content?.included ?? publication.content.included;
  const notIncluded = content?.notIncluded ?? publication.content.notIncluded;
  const faq = content ? content.faq : publication.content.faq;
  // The host's own bio (#146) in the page's language only: English needs the host's confirmed English. No filler.
  const hostBioText = (ja ? hostBio?.ja : hostBio?.en) ?? null;
  const providerName = providerNameFor(publication, locale);
  const isBusiness = publication.providerKind === "BUSINESS";
  const providerIdentityMedia = isBusiness ? publication.businessLogo : publication.providerPhoto;
  const providerIdentityPhoto = providerIdentityMedia
    ? { url: providerIdentityMedia.src, alt: ja ? providerIdentityMedia.altJa : providerIdentityMedia.alt }
    : null;
  // Guides and other experiences are English-only for now, as on the NIHO-sourced page. Both are optional and never break the page.
  // Guides are English-only for now (the Japanese reading pieces come in a later step); the other experiences are in both languages.
  const [relatedGuides, relatedCards, classification] = await Promise.all([
    ja ? NO_GUIDES : guidesAboutExperience(publication.slug).catch(() => NO_GUIDES),
    relatedSiteExperienceCards(publication.slug, locale),
    loadClassificationOf(publication.slug),
  ]);
  const people = item.memberProfiles ?? [];
  const hasHostIdentity = Boolean(providerName || hostBioText || publication.providerKind || people.length);
  const hostSectionHeading = hasHostIdentity
    ? (ja ? "ホストについて" : "About your host")
    : (ja ? "提供者について" : "About the provider");
  const showHostSection = hasHostIdentity;
  const sellerLink = sellerInformationHref
    ? <p id="seller" className="mt-5 text-sm"><a href={sellerInformationHref} rel="noopener noreferrer" className="font-bold text-ink underline underline-offset-4">{ja ? "特定商取引法に基づく表記" : "Seller information"}</a></p>
    : null;
  const category = classification?.category ?? null;
  const area = classification?.area ?? null;
  const peopleLinks = ja && config.peoplePagesEnabled;
  const bookable = Boolean(config.bookingsEnabled && config.guestBookingEnabled && offers.length);
  // The Japanese site writes yen with the half-width ¥, as its cards do.
  const yen = (amount: number) => ja ? jaYen(amount) : formatYen(amount, "en");
  const lowest = offers.length ? Math.min(...offers.map((offer) => offer.pricing.adultPriceYen)) : null;
  const askHref = inquiryHref(locale, { from: "EXPERIENCE", experienceSlug: publication.slug, experienceTitle: title, hostName: providerName });
  const cancellation = cancellationLines(offers, locale);
  const hostStoryGuide = relatedGuides.guides.find((guide) => "pillar" in guide && guide.pillar === "hosts" && !relatedGuides.draftSlugs.includes(guide.slug));
  const stationAccess = publicStationAccess(publication.meetingOverview, locale);
  const placeHeadline = stationAccess
    ? ja ? `${stationAccess.station}から徒歩${stationAccess.walkMinutes}分` : `${stationAccess.walkMinutes}-minute walk from ${stationAccess.station}`
    : area ? areaLabel(area, locale) : ja ? "鎌倉" : "Kamakura";
  const scheduleFacts = [...new Set(offers.map((offer) => scheduleDescription(offer, locale)))];
  const groupSize = offers.length
    ? `${Math.min(...offers.map((offer) => offer.minimumParticipants))}–${Math.max(...offers.map((offer) => offer.maxPartySize))}${ja ? "名" : " guests"}`
    : null;
  const facts = [
    durations ? { label: ja ? "所要時間" : "Duration", value: durations, icon: "clock" as const } : null,
    language ? { label: ja ? "対応言語" : "Language", value: language, icon: "language" as const } : null,
    groupSize ? { label: ja ? "参加人数" : "Group size", value: groupSize, icon: "people" as const } : null,
    scheduleFacts.length ? { label: ja ? "開催日時" : "When", value: scheduleFacts.join(" · "), icon: "calendar" as const } : null,
  ].filter((fact): fact is NonNullable<typeof fact> => Boolean(fact));

  return <>
    <JsonLd data={structured.touristTrip} />
    <JsonLd data={structured.product} />
    <TrackView event="experience_view" props={{ experience: publication.slug }} />
    <div className="overflow-x-clip pb-24 lg:pb-0">
      <MobileGallery photos={photos} title={title} backHref={ja ? "/ja/experiences" : "/experiences"} />
      <div className="container-page">
        <nav aria-label={ja ? "パンくずリスト" : "Breadcrumb"} className="hidden pt-7 text-sm text-muted lg:block">
          <Link href={ja ? "/ja/experiences" : "/experiences"} className="font-extrabold text-ink hover:underline">{ja ? "体験" : "Experiences"}</Link>
          {category ? <><span aria-hidden> / </span><Link href={`${ja ? "/ja" : ""}/experiences?category=${category}`} className="font-extrabold text-ink hover:underline">{categoryLabel(category, locale)}</Link></> : null}
        </nav>
        {cancelled ? <p role="status" className="mt-5 rounded-2xl bg-sand p-4">{ja ? "決済がキャンセルされました。予約は完了していません。" : "Checkout was cancelled. Your booking was not completed."}</p> : null}
        <div className="hidden pt-6 lg:block"><DesktopGallery photos={photos} title={title} /></div>
        <div className="grid gap-x-8 gap-y-8 pt-5 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-x-[72px] lg:pt-7">
          <header className="min-w-0 lg:col-start-1 lg:row-start-1">
            {category ? <span className="hand inline-flex items-center gap-1.5 text-[1.375rem]"><CategoryIcon id={category} className="size-5" />{categoryHand(category)}</span> : null}
            <h1 className="text-[2.125rem] leading-[1.1] lg:max-w-[20ch] lg:text-[3.25rem]">{title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm font-bold text-ink-soft">
              {headline ? <Link href="#reviews" aria-label={headline.accessibleLabel} className="text-moss hover:underline">{headline.label}</Link> : null}
              <Link href="#place" className="hover:text-ink">{placeHeadline}</Link>
              {showHostSection ? <Link href="#host" className="inline-flex items-center gap-2 hover:text-ink">
                {isBusiness && people.length > 0 ? <span aria-hidden className="flex -space-x-2">{people.slice(0, 3).map((person, index) => <Photo key={person.name + "/" + index} image={{ url: person.photo.src, alt: person.photo.alt }} alt="" aspect="" rounded="rounded-full" className="size-7 border-2 border-white" sizes="28px" />)}</span>
                  : providerIdentityPhoto ? <Photo image={providerIdentityPhoto} alt="" aspect="" rounded={isBusiness ? "rounded-lg" : "rounded-full"} className="size-7 shrink-0" sizes="28px" /> : null}
                <span>{providerName ? isBusiness ? ja ? people.length ? `${providerName} のみなさんと` : `${providerName} が開催` : providerName : ja ? `${providerName}さんと` : `with ${providerName}` : ja ? "ホスト" : "Your host"}</span>
              </Link> : null}
            </div>
            <ul className="mt-[18px] grid grid-cols-2 gap-x-3 gap-y-4 border-y border-line py-[18px] lg:gap-x-6">
              {facts.map((fact) => <li key={fact.label} className="flex min-w-0 items-center gap-2.5">
                <FactIcon kind={fact.icon} />
                <span className="min-w-0"><span className="sr-only">{fact.label}: </span><span className="block font-extrabold">{fact.value}</span></span>
              </li>)}
            </ul>
          </header>
          <aside className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            {bookable && lowest !== null
              ? <SitePublicationDatePicker item={item} locale={locale} siteOrigin={new URL(config.siteUrl).origin} bookingHref={bookingHref} nextDates={nextDates} inquiryHref={config.groupInquiryEnabled ? askHref : null} enabled={bookable} priceFrom={lowest} ratingLabel={headline?.label ?? null} />
              : <section id="book" className="rounded-[var(--radius-card)] border border-line bg-white p-5"><p className="eyebrow">{ja ? "料金" : "From"}</p><p className="mt-1 text-3xl font-extrabold">{lowest === null ? (ja ? "料金未設定" : "Price unavailable") : yen(lowest)}</p><p className="mt-4 rounded-xl bg-sand p-3 text-sm text-ink-soft">{ja ? "現在、オンライン予約はご利用いただけません。" : "Online booking is temporarily unavailable."}</p>{config.groupInquiryEnabled ? <a href={askHref} className="mt-3 inline-flex min-h-11 items-center font-bold text-moss underline underline-offset-4">{ja ? "ほかの日・グループの相談" : "Ask about other dates or a group"}</a> : null}</section>}
          </aside>
          <main className="min-w-0 lg:col-start-1 lg:row-start-2">
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
            {included.length || notIncluded.length ? <section className="border-b border-line py-8 lg:py-10">
              <h2 className="text-2xl">{ja ? "料金に含まれるもの" : "What’s included"}</h2>
              <div className="mt-5 grid gap-7 sm:grid-cols-2">
                {included.length ? <div><h3 className="font-extrabold">{ja ? "含まれるもの" : "Included"}</h3><ul className="mt-3 space-y-2 text-ink-soft">{included.map((value) => <li key={value} className="flex gap-2"><HandIcon name="check" className="mt-0.5 size-5 shrink-0" />{value}</li>)}</ul></div> : null}
                {notIncluded.length ? <div><h3 className="font-extrabold">{ja ? "含まれないもの" : "Not included"}</h3><ul className="mt-3 space-y-2 text-ink-soft">{notIncluded.map((value) => <li key={value} className="flex gap-2"><HandIcon name="cross" className="mt-0.5 size-5 shrink-0" />{value}</li>)}</ul></div> : null}
              </div>
            </section> : null}
            {showHostSection ? <section id="host" aria-labelledby="host-heading" className="scroll-mt-24 border-b border-line py-8 lg:py-10">
              <h2 id="host-heading" className="text-2xl">{hostSectionHeading}</h2>
              {isBusiness ? <>
                <div className="mt-4 flex items-start gap-4">
                  {providerIdentityPhoto ? <Photo image={providerIdentityPhoto} alt={providerIdentityPhoto.alt} aspect="" rounded="rounded-2xl" className="size-20 shrink-0" sizes="80px" /> : null}
                  <div className="min-w-0"><p className="font-extrabold">{providerName ?? (ja ? "開催する事業者" : "Experience provider")}</p>{area ? <p className="mt-1 text-sm text-ink-soft">{areaLabel(area, locale)}</p> : null}</div>
                </div>
                {hostBioText ? <HostBioText text={hostBioText} locale={locale} /> : null}
              </> : <div className="mt-4 flex items-start gap-4">
                {providerIdentityPhoto
                  ? <Photo image={providerIdentityPhoto} alt={providerIdentityPhoto.alt} aspect="" rounded="rounded-full" className="size-20 shrink-0" sizes="80px" />
                  : null}
                <div className="min-w-0">
                  <p className="font-extrabold">{providerName ?? (ja ? "ホスト" : "Your host")}</p>
                  {hostBioText ? <HostBioText text={hostBioText} locale={locale} /> : null}
                </div>
              </div>}
              {people.length ? <div className="mt-6 border-t border-line pt-5">
                <h3 className="text-lg font-extrabold">{ja ? people.length === 1 ? "会いにいく人" : "案内する人" : "Meet your guides"}</h3>
                <ul className="mt-6 grid gap-5">
                  {people.slice(0, 3).map((entry, index) => {
                    const href = peopleLinks && entry.slug ? "/ja/people/" + encodeURIComponent(entry.slug) : null;
                    const subtitle = [entry.text.role, entry.text.area].filter(Boolean).join(ja ? "・" : " · ");
                    const photo = <Photo image={{ url: entry.photo.src, alt: entry.photo.alt }} alt={entry.photo.alt} aspect="" rounded="rounded-full" className="size-16 shrink-0" sizes="64px" />;
                    return <li key={entry.name + "/" + index} className="flex min-w-0 items-start gap-4">
                      {href ? <Link href={href} aria-label={entry.name + "さんのページ"} className="shrink-0">{photo}</Link> : photo}
                      <div className="min-w-0">
                        <p className="font-extrabold">{entry.name}{subtitle ? <span className="ml-2 text-[0.8125rem] font-bold text-ink-soft">{subtitle}</span> : null}</p>
                        {entry.text.quote ? <p className="mt-1.5 text-[1.0625rem] leading-snug">{ja ? "「" + entry.text.quote + "」" : "“" + entry.text.quote + "”"}</p> : null}
                        {entry.text.intro ? <p className="mt-2 whitespace-pre-line break-words text-ink-soft">{entry.text.intro}</p> : null}
                        {entry.photo.credit ? <p className="mt-1 text-xs text-ink-soft">{entry.photo.credit}</p> : null}
                        {href ? <Link href={href} className="mt-1 inline-flex min-h-11 items-center text-sm font-extrabold text-moss underline underline-offset-4">{entry.name}さんのページ</Link> : null}
                      </div>
                    </li>;
                  })}
                </ul>
                {isBusiness ? <p className="mt-4 text-sm text-ink-soft">{ja ? "当日の担当は、日によって変わることがあります。" : "The person leading your experience may vary by date."}</p> : null}
              </div> : null}
              {sellerLink}
            </section> : null}
            {publication.meetingOverview || publication.meetingPointDisclosure === "PUBLIC" || publication.meetingPointDisclosure === "AFTER_BOOKING" ? <section id="place" className="scroll-mt-24 border-b border-line py-8 lg:py-10">
              <h2 className="text-2xl">{ja ? "場所" : "Getting there"}</h2>
              {publication.meetingOverview && !ja ? <p className="mt-4 whitespace-pre-line text-ink-soft">{publication.meetingOverview}</p> : null}
              {publication.meetingPointDisclosure === "PUBLIC" && publication.meetingPoint && !ja ? <div className="mt-4">
                <p className="font-extrabold">{publication.meetingPoint.name}</p>
                {publication.meetingPoint.exteriorPhotoIndex !== null && photos[publication.meetingPoint.exteriorPhotoIndex] ? <Photo image={photos[publication.meetingPoint.exteriorPhotoIndex]!} alt={photos[publication.meetingPoint.exteriorPhotoIndex]!.alt || `${publication.meetingPoint.name} exterior`} aspect="" rounded="rounded-xl" className="mt-4 h-52 w-64" sizes="256px" /> : null}
              </div> : null}
              {publication.meetingPointDisclosure === "PUBLIC" && publication.publicMapPoint ? <div className="relative mt-4">
                {process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ? <>
                  <MapboxLocationMap point={publication.publicMapPoint} area={null} label={ja ? "集合場所の地図" : "Meeting place map"} locale={locale} />
                  <a href={`https://maps.google.com/?q=${publication.publicMapPoint.lat},${publication.publicMapPoint.lng}`} target="_blank" rel="noopener noreferrer" className="absolute left-3 top-3 z-10 rounded-lg bg-white px-3 py-2 text-sm font-bold text-ink shadow">{ja ? "Google マップで開く" : "Open in Google Maps"}</a>
                </> : <a href={`https://maps.google.com/?q=${publication.publicMapPoint.lat},${publication.publicMapPoint.lng}`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-bold text-moss underline underline-offset-4">{ja ? "Google マップで開く" : "Open in Google Maps"}</a>}
              </div> : null}
              {publication.publicMapArea ? <div className="mt-4"><MapboxLocationMap point={null} area={publication.publicMapArea} label={ja ? "おおよその集合エリア" : "Approximate meeting area"} locale={locale} /><p className="mt-2 text-sm text-ink-soft">{ja ? "地図は公開しているおおよそのエリアです。" : "The map shows an approximate public area."}</p></div> : null}
              <div className="mt-4 space-y-2 text-ink-soft">
                {stationAccess ? <p>{ja ? `${stationAccess.station}から徒歩${stationAccess.walkMinutes}分` : `${stationAccess.walkMinutes}-minute walk from ${stationAccess.station}`}</p> : null}
                <p>{detailTokyoRailLine(locale)}</p>
                {publication.meetingPointDisclosure === "PUBLIC"
                  ? <p>{ja ? "建物の入り方は、予約の確定メールでお伝えします。" : "Details for entering the building will be in your booking confirmation email."}</p>
                  : <p>{ja ? "正確な集合場所は、予約が確定したあとにお伝えします。" : "The exact meeting point is shared after your booking is confirmed."}</p>}
              </div>
            </section> : null}
            {reviews ? <section id="reviews" className="scroll-mt-24 border-b border-line py-8 lg:py-10">
              <h2 className="text-2xl">{ja ? "レビュー" : "Reviews"}</h2>
              <div className="mt-4"><ReviewsSection slug={publication.slug} reviews={reviews} locale={locale} preview={false} nihoWebOrigin={config.nihoWebOrigin} /></div>
            </section> : null}
            {(cancellation.length || (content?.notSuitableFor ?? publication.content.notSuitableFor).length || (content?.knowBeforeYouGo ?? publication.content.knowBeforeYouGo).length) ? <section id="know-before-you-go" className="scroll-mt-24 border-b border-line py-8 lg:py-10">
              <h2 className="text-2xl">{ja ? "参加前にご確認ください" : "Know before you go"}</h2>
              {cancellation.length ? <div className="mt-4"><h3 className="font-extrabold">{ja ? "キャンセル" : "Cancellation"}</h3><ul className="mt-2 space-y-2 text-ink-soft">{cancellation.map((line) => <li key={`${line.label}-${line.text}`}>{line.label ? <b className="text-ink">{line.label}{ja ? "：" : ": "}</b> : null}{line.text}</li>)}</ul></div> : null}
              {(content?.notSuitableFor ?? publication.content.notSuitableFor).length ? <div className="mt-5"><h3 className="font-extrabold">{ja ? "参加に向かない条件" : "Not suitable for"}</h3><ul className="mt-2 list-disc space-y-2 pl-5 text-ink-soft">{(content?.notSuitableFor ?? publication.content.notSuitableFor).map((value) => <li key={value}>{value}</li>)}</ul></div> : null}
              {(content?.knowBeforeYouGo ?? publication.content.knowBeforeYouGo).length ? <div className="mt-5"><h3 className="font-extrabold">{ja ? "参加前の注意" : "Notes"}</h3><ul className="mt-2 list-disc space-y-2 pl-5 text-ink-soft">{(content?.knowBeforeYouGo ?? publication.content.knowBeforeYouGo).slice(0, 4).map((value) => <li key={value}>{value}</li>)}</ul>{(content?.knowBeforeYouGo ?? publication.content.knowBeforeYouGo).length > 4 ? <details className="mt-3"><summary className="min-h-11 cursor-pointer py-2 font-bold text-moss underline underline-offset-4">{ja ? "すべての注意を見る" : "Read all notes"}</summary><ul className="list-disc space-y-2 pl-5 text-ink-soft">{(content?.knowBeforeYouGo ?? publication.content.knowBeforeYouGo).slice(4).map((value) => <li key={value}>{value}</li>)}</ul></details> : null}</div> : null}
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
            {relatedGuides.guides.length ? <section aria-labelledby="detail-guides-heading" className="pt-12">
              <p className="eyebrow">Guides</p>
              <h2 id="detail-guides-heading" className="mt-1 mb-[18px] text-[1.75rem] lg:text-[2rem]">{detailGuideHeading("Kamakura", publication.meetingOverview, offers.map((offer) => offer.startTime))}</h2>
              {hostStoryGuide ? <p className="mb-5"><Link href={`/guides/${hostStoryGuide.slug}`} className="link-leaf">Read the host story</Link></p> : null}
              <GuideTeasers guides={relatedGuides.guides} draftSlugs={relatedGuides.draftSlugs} columns="three" variant="detail" locale={locale} />
            </section> : null}
            {!showHostSection && sellerLink ? <section className="border-b border-line py-6">{sellerLink}</section> : null}
          </main>
        </div>
        {relatedCards.length ? <section aria-labelledby="related-experiences-heading" className="pt-14">
          <h2 id="related-experiences-heading" className="mb-6 text-[1.75rem] lg:text-[2rem]">{ja ? "ほかの体験" : "More experiences in Kamakura"}</h2>
          <ExperienceCardGrid cards={relatedCards} />
        </section> : null}
      </div>
    </div>
  </>;
}

function FactIcon({ kind }: { kind: "clock" | "language" | "people" | "calendar" }) {
  return <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-sand text-moss">
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {kind === "clock" ? <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>
        : kind === "language" ? <><path d="M4 6h10M9 4v2m3 0c-.5 4-3 7-7 9m1-6c1 2 3 4 5 5M14 19l3.5-8 3.5 8m-5.7-2.6h4.4" /></>
          : kind === "people" ? <><circle cx="9" cy="8" r="3" /><path d="M3.5 19v-1a5.5 5.5 0 0 1 11 0v1zM15 5.5a3 3 0 0 1 0 5.8M17 14a4.5 4.5 0 0 1 3.5 4.4v.6H18" /></>
            : <><rect x="4" y="5.5" width="16" height="15" rx="2" /><path d="M8 3.5v4M16 3.5v4M4 10h16M8 13.5h.01M12 13.5h.01M16 13.5h.01M8 17h.01M12 17h.01" /></>}
    </svg>
  </span>;
}

function HostBioText({ text, locale }: { text: string; locale: "en" | "ja" }) {
  const characters = [...text];
  if (characters.length <= 300) return <p className="mt-3 whitespace-pre-line break-words text-ink-soft">{text}</p>;
  return <div className="mt-3 text-ink-soft">
    <p className="whitespace-pre-line break-words">{characters.slice(0, 300).join("")}</p>
    <details className="mt-2">
      <summary className="inline-flex min-h-11 cursor-pointer items-center font-bold text-moss underline underline-offset-4">{locale === "ja" ? "続きを読む" : "Read more"}</summary>
      <p className="mt-2 whitespace-pre-line break-words">{characters.slice(300).join("")}</p>
    </details>
  </div>;
}
