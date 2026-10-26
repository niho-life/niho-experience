import type { Guide, GuideFaqItem, GuideHero, GuideTranslation } from "@/content/guides/types";
import { guideLinkHref, parseGuideMarkdown } from "./guide-markdown";

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
  altMaxLength: 200,
  relatedExperiencesMin: 2,
  relatedExperiencesMax: 3,
  relatedGuidesMax: 3,
  faqMaxItems: 20,
  questionMaxLength: 200,
  answerMaxLength: 1200,
} as const;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

function body(problems: string[], label: string, source: string) {
  try {
    if (!parseGuideMarkdown(source).length) problems.push(`${label} is empty`);
  } catch (error) {
    problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function faq(problems: string[], label: string, items: readonly GuideFaqItem[]) {
  if (items.length > GUIDE_LIMITS.faqMaxItems) problems.push(`${label} has more than ${GUIDE_LIMITS.faqMaxItems} questions`);
  const seen = new Set<string>();
  items.forEach((item, index) => {
    text(problems, `${label}[${index}].question`, item.question, GUIDE_LIMITS.questionMaxLength);
    text(problems, `${label}[${index}].answer`, item.answer, GUIDE_LIMITS.answerMaxLength);
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
  text(problems, "author.name", guide.author?.name, GUIDE_LIMITS.authorMaxLength);
  text(problems, "author.role", guide.author?.role, GUIDE_LIMITS.authorMaxLength);
  if (!isGuideDate(guide.publishedAt)) problems.push("publishedAt must be a YYYY-MM-DD date");
  if (!isGuideDate(guide.updatedAt)) problems.push("updatedAt must be a YYYY-MM-DD date");
  else if (isGuideDate(guide.publishedAt) && guide.updatedAt < guide.publishedAt) problems.push("updatedAt is before publishedAt");
  if (guide.hero) hero(problems, guide.hero);
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
