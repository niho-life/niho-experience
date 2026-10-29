import type { PublicVideo } from "@/lib/videos";

/**
 * A published guide (docs/content/guides.md, ADR 0002). One module per guide in this folder; only published guides are
 * committed. The body is the Markdown subset in `lib/guide-markdown.ts`; `lib/guides.ts` validates every field, and a unit
 * test runs that validation over every registered guide so a bad article fails CI.
 */

export type GuideFaqItem = Readonly<{ question: string; answer: string }>;

/** The five editorial shelves on `/guides`, in their fixed display order. Optional only for legacy preview drafts. */
export type GuidePillar = "evenings" | "zazen" | "hands-on" | "planning" | "hosts";

/** Admin-managed CMS category. It is intentionally separate from the five code-owned editorial pillars. */
export type GuideCategory = Readonly<{ slug: string; label: string; displayOrder: number }>;

export type GuidePublicFigure = Readonly<{ assetId: string; src: string; credit: string }>;

export type GuideAuthor = Readonly<{
  /** The writer's real name as shown on the page. */
  name: string;
  /** Their role, e.g. "Editor, NIHO Experience" or "Host of the community dinner". */
  role: string;
  /** A short first-person or third-person introduction for the article footer. */
  bio?: string;
}>;

export type GuideHero = Readonly<{
  /** A site path under `public/` (`/guides/…`) or an https URL. */
  src: string;
  alt: string;
  width: number;
  height: number;
  /** True only when the photo's rights cover sharing (Open Graph, `Article.image`). False shows it on the page only. */
  licensed: boolean;
  /** Visible credit or context directly below the hero. */
  caption?: string;
}>;

/** A translated version. The structure only: no `/ja/guides` route exists yet (Japanese site: #59). */
export type GuideTranslation = Readonly<{ title: string; description: string; body: string; faq: readonly GuideFaqItem[] }>;

export type Guide = Readonly<{
  /** URL segment: `/guides/{slug}`. Lower-case letters, digits and hyphens. Never changed once published. */
  slug: string;
  /** A public, direct-link editorial preview. Keep it out of navigation and sitemap, and always emit noindex. */
  unlisted?: true;
  /** The h1, `<title>` and `Article.headline` (110 characters at most). */
  title: string;
  /** The meta description and the lead under the title (160 characters at most). */
  description: string;
  /** Required before publication. Legacy external drafts may omit it and stay in an unclassified preview shelf. */
  pillar?: GuidePillar;
  /** Present only for database publications; static guides continue to use `pillar`. */
  category?: GuideCategory;
  author: GuideAuthor;
  /** ISO dates (`YYYY-MM-DD`), shown on the page and in the structured data. */
  publishedAt: string;
  /** Changed on every content update; the sitemap's `lastModified`. */
  updatedAt: string;
  /** Date on which time-sensitive facts were last checked. */
  checkedAt?: string;
  /** Editorial reading-time override. When omitted, the UI derives it from the article text. */
  readMinutes?: number;
  hero?: GuideHero;
  /** Published YouTube video. The hero serves as its approved poster; no video is requested before play. */
  video?: PublicVideo;
  /** 2–3 experience slugs for the call to action. Slugs missing from the catalogue are skipped on the page. */
  relatedExperienceSlugs: readonly string[];
  /** Other guides in the same registry (0–3). */
  relatedGuideSlugs: readonly string[];
  /** Questions and answers shown as an h2 followed by native details/summary rows. No FAQPage structured data. */
  faq: readonly GuideFaqItem[];
  body: string;
  /** Currently READY snapshot figures that the safe Markdown renderer may resolve. */
  publicFigures?: readonly GuidePublicFigure[];
  translations?: Readonly<{ ja?: GuideTranslation }>;
}>;
