import type { ThemeKey } from "./themes";

/**
 * Decorative photos and videos the site itself owns (not listing photos from the API).
 *
 * SAMPLE_MEDIA: these are provisional files until NIHO's own photos and videos are shot:
 * NIHO's own snapshots (niho-*.jpg), stand-in host faces (host-*.jpg) and free stock files.
 * Owner decision 2026-10-20: no "Sample photo" tag on the pictures; previews say so in one
 * line at the bottom of the footer instead. Replace the files (and set this to false) before
 * the production launch; sources are listed in public/sample/CREDITS.md
 * (docs/release-acceptance.md). People in the stock files are not NIHO hosts or guests.
 */
export const SAMPLE_MEDIA = true;

export type SiteVideo = { src: string; poster: string };
export type SitePhoto = { src: string; alt: string; position?: string };
export type Postcard = SitePhoto & { place: string; rotate: number };

const photo = (file: string) => `/sample/photos/${file}`;
const video = (name: string): SiteVideo => ({ src: `/sample/video/${name}.mp4`, poster: `/sample/video/${name}.jpg` });

export const HERO_PHOTO: SitePhoto = {
  src: photo("niho-cd-table-02.jpg"),
  alt: "Neighbors around the long table at NIHO",
  position: "62% 45%",
};

/** The community dinner feature on the home page: kitchen, salad, the long table (tall), trays, dessert. */
export const FEATURE_MOSAIC: SitePhoto[] = [
  { src: photo("niho-cd-kitchen-together.jpg"), alt: "", position: "60% 40%" },
  { src: photo("niho-cd-hands-salad.jpg"), alt: "" },
  { src: photo("niho-cd-table-01.jpg"), alt: "", position: "40% 50%" },
  { src: photo("niho-cd-food-trays.jpg"), alt: "" },
  { src: photo("niho-cd-strawberry-daifuku.jpg"), alt: "" },
];

export const BANNER_VIDEO: SiteVideo = video("banner-roast");

/** Short vertical clips per theme. Only themes with a listed experience are shown. */
export const STRIP_VIDEOS: Record<ThemeKey, SiteVideo> = {
  cook: video("strip-cook"),
  roast: video("strip-roast"),
  sit: video("strip-sit"),
  mend: video("strip-mend"),
  write: video("strip-write"),
};

/** A brush at work (not the host). Used for the calligraphy strip and the host feature. */
export const CALLIGRAPHY_VIDEO: SiteVideo = video("strip-calligraphy");

/** Stand-in face for an experience run by a company with no named hosts (see lib/themes.ts). */
export const GUIDE_FACE = photo("host-guide.jpg");

export const POSTCARDS: Postcard[] = [
  { src: photo("kamakura-crossing.jpg"), alt: "", place: "Kamakura-Kōkōmae", rotate: -3, position: "30% 50%" },
  { src: photo("enoden-crossing.jpg"), alt: "", place: "The Enoden line", rotate: 2 },
  { src: photo("daibutsu.jpg"), alt: "", place: "The Great Buddha", rotate: -1.5, position: "40% 50%" },
  { src: photo("shichirigahama-fuji.jpg"), alt: "", place: "Shichirigahama", rotate: 3, position: "55% 50%" },
  { src: photo("bamboo.jpg"), alt: "", place: "Hōkokuji bamboo", rotate: -2.5 },
];

export const HOST_BAND_VIDEO: SiteVideo = video("coast-tram");

/** Every file referenced above, for the test that keeps them in public/sample and CREDITS.md. */
export function siteMediaFiles(): string[] {
  const videos = [BANNER_VIDEO, HOST_BAND_VIDEO, CALLIGRAPHY_VIDEO, ...Object.values(STRIP_VIDEOS)].flatMap((item) => [item.src, item.poster]);
  return [HERO_PHOTO.src, ...FEATURE_MOSAIC.map((item) => item.src), GUIDE_FACE, ...POSTCARDS.map((card) => card.src), ...videos];
}

/** The About page (#645): NIHO's own photos only, never listing photos from the API. */
export const ABOUT_HERO: SitePhoto = { src: photo("niho-dinner-1.jpg"), alt: "Neighbors and guests talking over drinks in the NIHO living room", position: "50% 55%" };
export const ABOUT_PILLARS: readonly { word: string; line: string; photo: SitePhoto }[] = [
  { word: "local", line: "Each one hosted by people who live here.", photo: { src: photo("niho-cd-kitchen-together.jpg"), alt: "Two people cooking together in the NIHO kitchen", position: "60% 40%" } },
  { word: "deep", line: "Everyday life and culture, not sightseeing.", photo: { src: photo("niho-cd-hands-salad.jpg"), alt: "Hands preparing a salad together" } },
  { word: "small", line: "Small enough for one table and real conversation.", photo: { src: photo("niho-cd-table-01.jpg"), alt: "Neighbors and guests around the dinner table at NIHO", position: "40% 50%" } },
];
export const ABOUT_EXTERIOR: SitePhoto = { src: photo("niho-exterior.jpg"), alt: "The entrance of NIHO kamakura" };
