import type { Metadata } from "next";
import { EN_STATIC_COPY_V1, type AssetBindingsV1, type DisplayImageV1, type DisplayVideoV1, type HomeViewModelV1, type StaticCopyAccessorV1 } from "@niho/experience-presentation/v1";
import { ErrorState } from "@/components/States";
import { HomePageView, type HomeRest } from "@/components/pages/HomePageView";
import { guestBookingSources } from "@/lib/guest-booking-source";
import { getApi, listExperiencesForSite } from "@/lib/api";
import { buildCardModels, cardFaceOf, type CardModel, type Face } from "@/lib/card-model";
import { loadDetails } from "@/lib/catalog";
import { getReviewSummaries } from "@/lib/journey";
import { withReviewLines } from "@/lib/reviews-ui";
import { config, isExperienceStaging, isPilotPreview, isPreview } from "@/lib/config";
import type { SearchParams } from "@/lib/filters";
import { scheduleLine } from "@/lib/schedule";
import { BANNER_VIDEO, HERO_PHOTO, HOST_BAND_VIDEO, POSTCARDS, STRIP_VIDEOS, type SitePhoto, type SiteVideo } from "@/lib/site-media";
import { editorialOf, FEATURED_HOST, FEATURED_STORY, shortName, themeOf, topicsLine, type Theme } from "@/lib/themes";
import type { ExperienceDetailForSite, PublicImageForSite } from "@/lib/experience-types";
import { imageAlt } from "@/lib/experience-copy";
import { JsonLd } from "@/components/JsonLd";
import { HomeJournal } from "@/components/HomeJournal";
import { buttonClass } from "@/components/ui";
import { guideCatalogForSite, hasGuidesPage } from "@/lib/guide-registry";
import { homeJournal } from "@/lib/home-journal";
import { LISTING_NAME, publicMetadata, SITE_DESCRIPTION, SITE_NAME } from "@/lib/public-metadata";
import { siteJsonLd } from "@/lib/structured-data";
import { englishAlternates } from "@/lib/locale-metadata";
import { getPublicSiteAnalyticsSettings } from "@/lib/public-site-analytics";
import { listSitePublicExperiences } from "@/lib/experience/site-publications";
import { sitePublicationCard } from "@/lib/experience/site-card-model";
import { searchWindow } from "@/lib/date-filter";
import { loadSiteCategories } from "@/lib/site-categories";
import { withoutNativeSlugs } from "@/lib/experience/dedupe-slugs";

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const numberWord = (n: number) => NUMBER_WORDS[n] ?? String(n);

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getPublicSiteAnalyticsSettings();
  const verification = settings?.searchConsoleVerification;
  return {
    ...publicMetadata("Meet the people of Kamakura", SITE_DESCRIPTION, `${config.siteUrl}/`),
    alternates: await englishAlternates("/"),
    ...(verification ? { other: { "google-site-verification": verification } } : {}),
  };
}

const displayPhoto = (photo: SitePhoto): DisplayImageV1 => ({ src: photo.src, alt: photo.alt, position: photo.position });
const displayImage = (image: PublicImageForSite | null, fallback = ""): DisplayImageV1 | null => image ? ({ src: image.url, alt: imageAlt(image, fallback) }) : null;
const displayVideo = (video: SiteVideo) => ({ src: video.src, poster: video.poster });
const publishedImage = (assets: AssetBindingsV1 | null, id: keyof AssetBindingsV1, fallback: SitePhoto): DisplayImageV1 => {
  const asset = assets?.[id];
  return asset?.kind === "image" ? { src: asset.src, srcset: asset.srcset, alt: asset.alt, position: asset.position } : displayPhoto(fallback);
};
const publishedVideo = (assets: AssetBindingsV1 | null, id: keyof AssetBindingsV1, fallback: SiteVideo): DisplayVideoV1 => {
  const asset = assets?.[id];
  return asset?.kind === "video" ? { src: asset.src, poster: asset.poster } : displayVideo(fallback);
};
const displayFace = (face: Face) => ({ ...face, image: displayImage(face.image) });

function hostRow(listed: ExperienceDetailForSite[], current: ExperienceDetailForSite, pilotPreview: boolean) {
  const rows: { face: Face; slug: string; name: string; current: boolean }[] = [];
  for (const item of [...listed.filter((experience) => experience.hosts.length), ...listed.filter((experience) => !experience.hosts.length)]) {
    const face = cardFaceOf(item, pilotPreview);
    if (rows.some((row) => row.face.name === face.name)) continue;
    rows.push({ face, slug: item.slug, name: shortName(item, pilotPreview), current: item.slug === current.slug });
  }
  return rows;
}

function homeRest(summaries: { slug: string; title: string }[], cards: CardModel[], listed: ExperienceDetailForSite[], copy: StaticCopyAccessorV1, assets: AssetBindingsV1 | null): HomeRest {
  const story = isPilotPreview ? (listed.find((experience) => experience.slug === FEATURED_STORY.slug) ?? null) : null;
  const featured = story ? null : (listed.find((experience) => experience.photos.length >= 5) ?? null);
  const strips: { theme: Theme; slug: string; name: string; video: SiteVideo }[] = [];
  for (const summary of summaries) {
    const theme = themeOf(summary);
    if (theme && !strips.some((strip) => strip.theme.key === theme.key)) strips.push({ theme, slug: summary.slug, name: shortName(summary, isPilotPreview), video: editorialOf(summary, isPilotPreview)?.video ?? STRIP_VIDEOS[theme.key] });
  }
  const hostFeature = (isPilotPreview ? listed.find((experience) => experience.slug === FEATURED_HOST.slug && experience.hosts.length) : null) ?? listed.find((experience) => experience.provider.kind === "INDIVIDUAL") ?? null;
  const capacities = listed.flatMap((experience) => experience.offers.map((offer) => offer.capacity));
  const figures: HomeViewModelV1["figures"] = [
    { value: "2", unit: copy.text("home.minutesUnit"), note: copy.text("home.stationNote") },
    ...(capacities.length ? [{ value: String(Math.max(...capacities)), unit: copy.text("home.guestsAtMostUnit"), note: copy.text("home.smallGroupNote") }] : []),
    { value: String(cards.length), unit: copy.text(cards.length === 1 ? "home.wayToStartUnit" : "home.waysToStartUnit"), note: topicsLine(summaries) ?? copy.text("home.hostedNote") },
    { value: "2", unit: copy.text("home.languagesUnit"), note: copy.text("home.languageNote") },
  ];
  const feature = story ? {
    schedule: scheduleLine(story.offers, { compact: true }) ?? undefined, heading: FEATURED_STORY.heading, body: FEATURED_STORY.body, cta: FEATURED_STORY.cta, href: `/experiences/${story.slug}`, photos: FEATURED_STORY.photos.map(displayPhoto),
  } : featured ? {
    schedule: scheduleLine(featured.offers) ?? undefined, heading: featured.title, body: featured.lead, cta: copy.text("home.featureSeeDetails"), href: `/experiences/${featured.slug}`,
    photos: [featured.photos[1], featured.photos[2], featured.photos[0], featured.photos[3], featured.photos[4]].map((photo) => displayImage(photo ?? null)!).filter(Boolean),
  } : undefined;
  const host = hostFeature ? (() => {
    const name = hostFeature.hosts[0]?.displayName ?? hostFeature.provider.name;
    const editorial = isPilotPreview && hostFeature.slug === FEATURED_HOST.slug && hostFeature.hosts.length ? FEATURED_HOST : null;
    return { headingEyebrow: copy.text("home.hostFeatureEyebrow"), headingTitle: copy.text("home.hostFeatureTitle"), moreHostsLabel: copy.text("home.moreHosts"), name, role: editorial?.role ?? hostFeature.provider.tagline ?? undefined, story: editorial?.story ?? hostFeature.lead, cta: copy.text("home.hostFeatureCta", { name }), href: `/experiences/${hostFeature.slug}`, image: editorial ? undefined : (displayImage(hostFeature.cover) ?? undefined), video: editorial ? publishedVideo(assets, "home.strip.calligraphy", editorial.video) : undefined, faces: hostRow(listed, hostFeature, isPilotPreview).map((entry) => ({ face: displayFace(entry.face), href: `/experiences/${entry.slug}`, label: entry.name, current: entry.current })) };
  })() : undefined;
  return {
    hero: publishedImage(assets, "home.hero", HERO_PHOTO), feature,
    strips: strips.map((strip) => ({ key: strip.theme.key, href: `/experiences/${strip.slug}`, verb: strip.theme.verb, name: strip.name, video: publishedVideo(assets, `home.strip.${strip.theme.key}` as keyof AssetBindingsV1, strip.video) })),
    stripsEyebrow: copy.text(strips.length === 1 ? "home.stripsEyebrowOne" : "home.stripsEyebrowMany", { countWord: numberWord(strips.length) }), banner: publishedVideo(assets, "home.banner", BANNER_VIDEO), hostFeature: host, figures,
    postcards: POSTCARDS.map((card, index) => ({ id: card.src, image: publishedImage(assets, (["home.postcard.crossing", "home.postcard.enoden", "home.postcard.buddha", "home.postcard.fuji", "home.postcard.bamboo"] as const)[index]!, card), place: card.place, rotate: card.rotate })), hostBand: publishedVideo(assets, "home.hostBand", HOST_BAND_VIDEO),
  };
}

export default async function Home({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const siteCatalogPromise = listSitePublicExperiences("en").catch((error: unknown) => {
    if (!isExperienceStaging) throw error;
    console.error("[home] staging public catalog unavailable");
    return null;
  });
  const [api, result, guideCatalogResult, siteCatalog] = await Promise.all([getApi(query), listExperiencesForSite("kamakura", query), guideCatalogForSite(), siteCatalogPromise]);
  if (siteCatalog === null) return <ErrorState title="We couldn't load experiences" />;
  if (!result.ok && result.kind !== "not_found") return <ErrorState title="We couldn't load experiences" />;
  const nativePublications = siteCatalog.experiences.filter(({ saleTerms }) => saleTerms !== null && saleTerms.offers.length > 0);
  const soldHere = nativePublications.map(({ publication }) => publication.slug);
  const summaries = result.ok ? withoutNativeSlugs(result.data.experiences, [...siteCatalog.claimedSlugs, ...soldHere]) : [];
  const details = await loadDetails(api, summaries, config.publicApiVersion !== "1.0");
  const legacyCards = buildCardModels(summaries, details, isPilotPreview);
  const nativeCards = nativePublications.map((item) => sitePublicationCard(item));
  const mergedCards = [...withoutNativeSlugs(legacyCards, nativeCards.map((card) => card.slug)), ...nativeCards];
  const cards = withReviewLines(mergedCards, await getReviewSummaries(mergedCards.map((card) => card.slug)));
  const listed = summaries.map((summary) => details.get(summary.slug)).filter((detail): detail is ExperienceDetailForSite => Boolean(detail));
  const searchDays = searchWindow(new Date());
  const search = { windowStart: searchDays.start, windowEnd: searchDays.end, preview: isPreview, bookingSources: await guestBookingSources(cards.map((card) => card.slug)) };
  const journal = homeJournal(guideCatalogResult.guides, { draftSlugs: guideCatalogResult.draftSlugs });
  const guideEntry = journal.items.length ? <HomeJournal journal={journal} allHref={hasGuidesPage(guideCatalogResult) ? "/guides" : null} moreClassName={buttonClass("secondary")} /> : undefined;
  return <>
    <JsonLd data={siteJsonLd(config.siteUrl, SITE_NAME, LISTING_NAME)} />
    <HomePageView locale="en" copy={EN_STATIC_COPY_V1} cards={cards} search={search} rest={homeRest(summaries, cards, listed, EN_STATIC_COPY_V1, null)} journal={guideEntry} categories={await loadSiteCategories("en")} />
  </>;
}
