import type { PublicVideo } from "@/lib/videos";

/**
 * A published guide (docs/content/guides.md, ADR 0002). One module per guide in this folder; only published guides are
 * committed. The body is the Markdown subset in `lib/guide-markdown.ts`; `lib/guides.ts` validates every field, and a unit
 * test runs that validation over every registered guide so a bad article fails CI.
 */

export type GuideFaqItem = Readonly<{ question: string; answer: string }>;

export type GuideAuthor = Readonly<{
  /** The writer's real name as shown on the page. */
  name: string;
  /** Their role, e.g. "Editor, NIHO Experience" or "Host of the community dinner". */
  role: string;
}>;

export type GuideHero = Readonly<{
  /** A site path under `public/` (`/guides/…`) or an https URL. */
  src: string;
  alt: string;
  width: number;
  height: number;
  /** True only when the photo's rights cover sharing (Open Graph, `Article.image`). False shows it on the page only. */
  licensed: boolean;
}>;

/** A translated version. The structure only: no `/ja/guides` route exists yet (Japanese site: #59). */
export type GuideTranslation = Readonly<{ title: string; description: string; body: string; faq: readonly GuideFaqItem[] }>;

export type Guide = Readonly<{
  /** URL segment: `/guides/{slug}`. Lower-case letters, digits and hyphens. Never changed once published. */
  slug: string;
  /** The h1, `<title>` and `Article.headline` (110 characters at most). */
  title: string;
  /** The meta description and the lead under the title (160 characters at most). */
  description: string;
  author: GuideAuthor;
  /** ISO dates (`YYYY-MM-DD`), shown on the page and in the structured data. */
  publishedAt: string;
  /** Changed on every content update; the sitemap's `lastModified`. */
  updatedAt: string;
  hero?: GuideHero;
  /** Published YouTube video. The hero serves as its approved poster; no video is requested before play. */
  video?: PublicVideo;
  /** 2–3 experience slugs for the call to action. Slugs missing from the catalogue are skipped on the page. */
  relatedExperienceSlugs: readonly string[];
  /** Other guides in the same registry (0–3). */
  relatedGuideSlugs: readonly string[];
  /** Questions and answers shown as a block (h2 + one h3 per question). No FAQPage structured data. */
  faq: readonly GuideFaqItem[];
  body: string;
  translations?: Readonly<{ ja?: GuideTranslation }>;
}>;
