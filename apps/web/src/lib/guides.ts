import type { PublicGuideArticle } from "@niho-experience/experience-store";
import type { Guide, GuideFaqItem, GuideHero, GuidePillar, GuideTranslation } from "@/content/guides/types";
import { guideFigureSources, guideInlineText, guideLinkHref, parseGuideAnswer, parseGuideMarkdown, type GuideBlock } from "./guide-markdown";
import { publicVideoProblems } from "./videos";

/**
 * Checks and selections for guides (pure: no config, so tests can run them over every registered guide).
 * The server-side registry with the preview switch is `guide-registry.ts`.
 */

export const GUIDE_LIMITS = {
  slugMaxLength: 80,
  /** Google shows about this much of an `Article.headline`. */
  titleMaxLength: 110,
  /** The meta description and the lead. */
  descriptionMaxLength: 160,
  authorMaxLength: 120,
  authorBioMaxLength: 600,
  altMaxLength: 200,
  captionMaxLength: 300,
  readMinutesMax: 60,
  relatedExperiencesMin: 2,
  relatedExperiencesMax: 3,
  relatedGuidesMax: 3,
  faqMaxItems: 20,
  questionMaxLength: 200,
  answerMaxLength: 1200,
} as const;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const GUIDE_PILLARS: readonly Readonly<{ key: GuidePillar; label: string; heading: string }>[] = [
  { key: "evenings", label: "Evenings", heading: "Kamakura after 4 PM" },
  { key: "zazen", label: "Zazen", heading: "A quiet morning in Kita-Kamakura" },
  { key: "hands-on", label: "Hands-on", heading: "Mending, calligraphy and coffee" },
  { key: "planning", label: "Planning", heading: "Kamakura from Tokyo" },
  { key: "hosts", label: "Hosts", heading: "Meet the people of Kamakura" },
] as const;

export function isGuidePillar(value: unknown): value is GuidePillar {
  return GUIDE_PILLARS.some((pillar) => pillar.key === value);
}

export function guidePillarDetails(pillar: GuidePillar | undefined) {
  return GUIDE_PILLARS.find((candidate) => candidate.key === pillar) ?? null;
}

/** Pure adapter from the sealed CMS read model to the one safe display model used by static guides. */
export function publicGuideArticleToGuide(article: PublicGuideArticle): Guide {
  if (article.content.author === undefined) throw new Error("A public guide publication is missing its author snapshot.");
  const mediaUrl = (assetId: string) => `/api/public/guides/media/${encodeURIComponent(assetId)}`;
  return {
    slug: article.slug,
    ...(article.indexable ? {} : { unlisted: true }),
    title: article.title,
    description: article.description,
    category: {
      slug: article.category.slug,
      label: article.category.labelEn,
      displayOrder: article.category.displayOrder,
    },
    author: article.content.author,
    publishedAt: article.firstPublishedAtUtc.slice(0, 10),
    updatedAt: article.publishedAtUtc.slice(0, 10),
    ...(article.content.checkedOn === undefined ? {} : { checkedAt: article.content.checkedOn }),
    ...(article.cover === undefined
      ? {}
      : {
          hero: {
            src: mediaUrl(article.cover.assetId),
            alt: article.cover.alt,
            width: article.cover.width,
            height: article.cover.height,
            // Web display permission does not imply social/OG reuse permission.
            licensed: false,
            caption: article.cover.credit,
          },
        }),
    relatedExperienceSlugs: [...new Set(article.productLinks.map((link) => link.productSlug))],
    relatedGuideSlugs: [],
    faq: [],
    body: article.content.markdown,
    publicFigures: article.figures.map((figure) => ({
      assetId: figure.assetId,
      src: mediaUrl(figure.assetId),
      credit: figure.credit,
    })),
  };
}

export function isGuideDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** "24 Oct 2026" for an ISO date (the date itself, no time zone shift). */
export function formatGuideDate(value: string): string {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, d)));
}

function text(problems: string[], label: string, value: unknown, max: number) {
  if (typeof value !== "string" || !value.trim()) problems.push(`${label} is empty`);
  else if (value !== value.trim()) problems.push(`${label} has leading or trailing spaces`);
  else if (value.length > max) problems.push(`${label} is longer than ${max} characters`);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function body(problems: string[], label: string, source: string) {
  try {
    if (!parseGuideMarkdown(source).length) problems.push(`${label} is empty`);
  } catch (error) {
    problems.push(`${label}: ${message(error)}`);
  }
}

function faq(problems: string[], label: string, items: readonly GuideFaqItem[]) {
  if (items.length > GUIDE_LIMITS.faqMaxItems) problems.push(`${label} has more than ${GUIDE_LIMITS.faqMaxItems} questions`);
  const seen = new Set<string>();
  items.forEach((item, index) => {
    text(problems, `${label}[${index}].question`, item.question, GUIDE_LIMITS.questionMaxLength);
    text(problems, `${label}[${index}].answer`, item.answer, GUIDE_LIMITS.answerMaxLength);
    try {
      parseGuideAnswer(item.answer);
    } catch (error) {
      problems.push(`${label}[${index}].answer: ${message(error)}`);
    }
    const key = item.question.trim().toLowerCase();
    if (seen.has(key)) problems.push(`${label}[${index}] repeats a question`);
    seen.add(key);
  });
}

function hero(problems: string[], value: GuideHero) {
  if (!guideLinkHref(value.src)) problems.push("hero.src must be a site path or an https URL");
  text(problems, "hero.alt", value.alt, GUIDE_LIMITS.altMaxLength);
  if (!Number.isInteger(value.width) || value.width <= 0 || !Number.isInteger(value.height) || value.height <= 0) problems.push("hero.width and hero.height must be positive integers");
  if (typeof value.licensed !== "boolean") problems.push("hero.licensed must be true or false");
  if (value.caption !== undefined) text(problems, "hero.caption", value.caption, GUIDE_LIMITS.captionMaxLength);
}

function translation(problems: string[], label: string, value: GuideTranslation) {
  text(problems, `${label}.title`, value.title, GUIDE_LIMITS.titleMaxLength);
  text(problems, `${label}.description`, value.description, GUIDE_LIMITS.descriptionMaxLength);
  body(problems, `${label}.body`, value.body);
  faq(problems, `${label}.faq`, value.faq);
}

function slugList(problems: string[], label: string, slugs: readonly string[]) {
  if (new Set(slugs).size !== slugs.length) problems.push(`${label} repeats a slug`);
  for (const slug of slugs) if (!SLUG.test(slug)) problems.push(`${label} has an invalid slug "${slug}"`);
}

/** Everything wrong with one guide, as readable lines (empty when it can be published). */
export function guideProblems(guide: Guide): string[] {
  const problems: string[] = [];
  if (!SLUG.test(guide.slug) || guide.slug.length > GUIDE_LIMITS.slugMaxLength) problems.push("slug must be lower-case letters, digits and single hyphens");
  text(problems, "title", guide.title, GUIDE_LIMITS.titleMaxLength);
  text(problems, "description", guide.description, GUIDE_LIMITS.descriptionMaxLength);
  if (guide.pillar !== undefined && !isGuidePillar(guide.pillar)) problems.push(`pillar must be one of ${GUIDE_PILLARS.map((pillar) => pillar.key).join(", ")}`);
  text(problems, "author.name", guide.author?.name, GUIDE_LIMITS.authorMaxLength);
  text(problems, "author.role", guide.author?.role, GUIDE_LIMITS.authorMaxLength);
  if (guide.author?.bio !== undefined) text(problems, "author.bio", guide.author.bio, GUIDE_LIMITS.authorBioMaxLength);
  if (!isGuideDate(guide.publishedAt)) problems.push("publishedAt must be a YYYY-MM-DD date");
  if (!isGuideDate(guide.updatedAt)) problems.push("updatedAt must be a YYYY-MM-DD date");
  else if (isGuideDate(guide.publishedAt) && guide.updatedAt < guide.publishedAt) problems.push("updatedAt is before publishedAt");
  if (guide.checkedAt !== undefined && !isGuideDate(guide.checkedAt)) problems.push("checkedAt must be a YYYY-MM-DD date");
  if (guide.readMinutes !== undefined && (!Number.isInteger(guide.readMinutes) || guide.readMinutes < 1 || guide.readMinutes > GUIDE_LIMITS.readMinutesMax)) {
    problems.push(`readMinutes must be an integer from 1 to ${GUIDE_LIMITS.readMinutesMax}`);
  }
  if (guide.hero) hero(problems, guide.hero);
  if (guide.video) {
    if (!guide.hero) problems.push("video requires a hero photo as its poster");
    problems.push(...publicVideoProblems(guide.video).map((problem) => `video.${problem}`));
  }
  const experiences = guide.relatedExperienceSlugs;
  if (experiences.length < GUIDE_LIMITS.relatedExperiencesMin || experiences.length > GUIDE_LIMITS.relatedExperiencesMax) {
    problems.push(`relatedExperienceSlugs needs ${GUIDE_LIMITS.relatedExperiencesMin}–${GUIDE_LIMITS.relatedExperiencesMax} slugs`);
  }
  slugList(problems, "relatedExperienceSlugs", experiences);
  if (guide.relatedGuideSlugs.length > GUIDE_LIMITS.relatedGuidesMax) problems.push(`relatedGuideSlugs has more than ${GUIDE_LIMITS.relatedGuidesMax} slugs`);
  slugList(problems, "relatedGuideSlugs", guide.relatedGuideSlugs);
  if (guide.relatedGuideSlugs.includes(guide.slug)) problems.push("relatedGuideSlugs points at the guide itself");
  faq(problems, "faq", guide.faq);
  body(problems, "body", guide.body);
  if (guide.translations?.ja) translation(problems, "translations.ja", guide.translations.ja);
  return problems;
}

const CONFIRM_MARK = /\[CONFIRM/i;
/** Provisional photos under `public/sample/` (or any `/sample/` folder): fine in previews, never in a published guide. */
const SAMPLE_PHOTO = /\/sample\//;

function bodyPhotos(source: string): string[] {
  try {
    return guideFigureSources(parseGuideMarkdown(source));
  } catch {
    return []; // guideProblems reports the body itself.
  }
}

/**
 * What keeps a valid guide from being published (docs/content/guides.md): a `[CONFIRM: …]` left in its text, or a
 * provisional `/sample/` photo as its hero or in its body. Drafts and the preview's samples may have both; the unit test
 * runs this over every published guide.
 */
export function guidePublishProblems(guide: Guide): string[] {
  const problems: string[] = [];
  if (!guide.pillar) problems.push("pillar is required before publication");
  if (!guide.author.bio) problems.push("author.bio is required before publication");
  const confirm = (label: string, value: string | undefined) => {
    if (value && CONFIRM_MARK.test(value)) problems.push(`${label} still has a [CONFIRM: …] to check`);
  };
  const content = (prefix: string, value: Pick<GuideTranslation, "title" | "description" | "body" | "faq">) => {
    confirm(`${prefix}title`, value.title);
    confirm(`${prefix}description`, value.description);
    confirm(`${prefix}body`, value.body);
    value.faq.forEach((item, index) => {
      confirm(`${prefix}faq[${index}].question`, item.question);
      confirm(`${prefix}faq[${index}].answer`, item.answer);
    });
    for (const src of bodyPhotos(value.body)) if (SAMPLE_PHOTO.test(src)) problems.push(`${prefix}body uses the provisional photo ${src}`);
  };
  content("", guide);
  confirm("author.bio", guide.author.bio);
  confirm("hero.caption", guide.hero?.caption);
  try {
    if (!parseGuideMarkdown(guide.body).some((block) => block.type === "heading" && block.level === 2)) problems.push("body needs at least one ## heading for the table of contents");
  } catch {
    // guideProblems reports malformed bodies.
  }
  if (guide.hero && SAMPLE_PHOTO.test(guide.hero.src)) problems.push(`hero uses the provisional photo ${guide.hero.src}`);
  if (guide.translations?.ja) content("translations.ja.", guide.translations.ja);
  return problems;
}

/** Problems across a registry: each guide, duplicate slugs, and related guides that the same registry does not have. */
export function guideRegistryProblems(guides: readonly Guide[]): string[] {
  const problems: string[] = [];
  const slugs = new Set<string>();
  for (const guide of guides) {
    for (const problem of guideProblems(guide)) problems.push(`${guide.slug}: ${problem}`);
    if (slugs.has(guide.slug)) problems.push(`${guide.slug}: the slug is used twice`);
    slugs.add(guide.slug);
  }
  for (const guide of guides) {
    for (const related of guide.relatedGuideSlugs) if (!slugs.has(related)) problems.push(`${guide.slug}: related guide "${related}" is not in this registry`);
  }
  return problems;
}

/** Newest update first, then by title. */
export function sortGuides(guides: readonly Guide[]): Guide[] {
  return [...guides].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title));
}

/** A stable reading-time label even when old drafts have no explicit override. */
export function guideReadMinutes(guide: Guide): number {
  if (guide.readMinutes) return guide.readMinutes;
  const words = [guide.title, guide.description, guide.body, ...guide.faq.flatMap((item) => [item.question, item.answer])]
    .join(" ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

export type GuideOutlineItem = Readonly<{ blockIndex: number; id: string; title: string; level: 2 | 3; sectionNumber?: number }>;

/** Stable, unique ids for every heading. The table of contents uses the numbered h2 entries only. */
export function guideOutline(blocks: readonly GuideBlock[]): GuideOutlineItem[] {
  const used = new Set<string>();
  let sectionNumber = 0;
  return blocks.flatMap((block, blockIndex) => {
    if (block.type !== "heading") return [];
    const title = guideInlineText(block.children);
    const base = title.normalize("NFKD").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || `heading-${blockIndex + 1}`;
    let id = base;
    for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`;
    used.add(id);
    if (block.level === 2) sectionNumber++;
    return [{ blockIndex, id, title, level: block.level, ...(block.level === 2 ? { sectionNumber } : {}) }];
  });
}

/** Place the compact experience CTA after the section nearest the middle of the article. */
export function guideCtaInsertAfter(blocks: readonly GuideBlock[], outline = guideOutline(blocks)): number | null {
  if (!blocks.length) return null;
  const sections = outline.filter((item) => item.level === 2);
  if (!sections.length) return Math.floor((blocks.length - 1) / 2);
  const section = sections[Math.max(0, Math.ceil(sections.length / 2) - 1)]!;
  const next = sections.find((item) => item.blockIndex > section.blockIndex);
  return next ? next.blockIndex - 1 : blocks.length - 1;
}

/** The guides that point at this experience (the detail page's "related guides" block), newest first. */
export function guidesForExperience(guides: readonly Guide[], experienceSlug: string, limit = 3): Guide[] {
  return sortGuides(guides.filter((guide) => guide.relatedExperienceSlugs.includes(experienceSlug))).slice(0, limit);
}

/** The guide's related guides that exist, in the guide's order. */
export function relatedGuidesOf(guides: readonly Guide[], guide: Guide): Guide[] {
  return guide.relatedGuideSlugs.flatMap((slug) => guides.filter((candidate) => candidate.slug === slug && candidate.slug !== guide.slug)).slice(0, GUIDE_LIMITS.relatedGuidesMax);
}

/** The guide's related experience slugs that the catalogue lists, in the guide's order. */
export function listedExperienceSlugs(guide: Guide, listed: readonly { slug: string }[]): string[] {
  const slugs = new Set(listed.map((item) => item.slug));
  return guide.relatedExperienceSlugs.filter((slug) => slugs.has(slug));
}

/**
 * hreflang for a guide, following `locale-metadata.ts`: itself (`en`) and `x-default`, plus `ja` only when the guide has a
 * Japanese translation and a Japanese route really serves it. No `/ja/guides` route exists yet (#59), so callers pass null.
 */
export function guideAlternates(guide: Guide, canonical: string, japaneseUrl: string | null) {
  const ja = guide.translations?.ja && japaneseUrl ? { ja: japaneseUrl } : {};
  return { canonical, languages: { en: canonical, ...ja, "x-default": canonical } };
}

/** An absolute URL for the hero (site paths resolve against the site), or null when it may not be shared. */
export function shareableGuideImage(guide: Guide, siteUrl: string): string | null {
  if (!guide.hero?.licensed) return null;
  const href = guideLinkHref(guide.hero.src);
  if (!href) return null;
  return href.external ? href.href : `${siteUrl}${href.href}`;
}
