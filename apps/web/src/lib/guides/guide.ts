import { readGuideMeta, splitFrontMatter } from "./frontmatter";
import { parseGuideBody } from "./markdown";
import { PILLARS, type Guide } from "./types";
import { isSampleImage } from "./urls";

export type ParseGuideResult = { ok: true; guide: Guide } | { ok: false; reasons: string[] };

/**
 * Reads one manuscript. `fileName` is `<slug>.md`. A published file must also be ready to publish:
 * no `[CONFIRM`, no `/sample/` stand-in photos and no photos from other sites (docs/content/guides.md).
 */
export function parseGuide(fileName: string, source: string, { draft }: { draft: boolean }): ParseGuideResult {
  const slug = fileName.replace(/\.md$/, "");
  const parts = splitFrontMatter(source);
  if (!parts) return { ok: false, reasons: ["the file must start with front matter between two \"---\" lines"] };
  const { meta, errors } = readGuideMeta(slug, parts.frontMatter);
  const body = parseGuideBody(parts.body, parts.bodyStartLine);
  const reasons = [...errors, ...body.problems];
  if (!draft) reasons.push(...publishedProblems(source, [...(meta ? [meta.hero] : []), ...body.images]));
  if (!meta || reasons.length) return { ok: false, reasons };
  return { ok: true, guide: { ...meta, body: body.blocks, headings: body.headings, draft } };
}

export function publishedProblems(source: string, images: string[]): string[] {
  const problems: string[] = [];
  if (/\[CONFIRM/i.test(source)) problems.push("[CONFIRM: …] is still in the text: check the fact and remove the marker before publishing");
  for (const src of images) {
    if (/^https:/i.test(src)) problems.push(`photo "${src}" is on another site: put the approved photo in apps/web/public/guides/media/`);
    else if (isSampleImage(src)) problems.push(`photo "${src}" is a /sample/ stand-in: use the approved photo`);
  }
  return problems;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-10" → "10 Nov 2026". The value is a calendar date, so no time zone is involved. */
export function formatGuideDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${day} ${MONTHS[(month ?? 1) - 1]} ${year}`;
}

/** Index order: pillar articles first, then the most recently updated. */
export function compareGuides(a: Guide, b: Guide): number {
  if (a.type !== b.type) return a.type === "pillar" ? -1 : 1;
  if (a.updated !== b.updated) return a.updated < b.updated ? 1 : -1;
  return a.title.localeCompare(b.title, "en");
}

/** /guides sections in pillar order; pillars without guides are left out. */
export function guidesByPillar(guides: Guide[]) {
  return PILLARS.map((pillar) => ({ pillar, guides: guides.filter((guide) => guide.pillar === pillar).sort(compareGuides) })).filter((section) => section.guides.length);
}

/** "Read before you go" on an experience page: guides that recommend it, at most three. */
export function guidesForExperience(guides: Guide[], experienceSlug: string, limit = 3): Guide[] {
  return guides.filter((guide) => guide.experiences.includes(experienceSlug)).sort(compareGuides).slice(0, limit);
}

/** "More guides": the `related` slugs that were read, in the author's order. */
export function relatedGuides(guide: Guide, guides: Guide[]): Guide[] {
  return guide.related.map((slug) => guides.find((candidate) => candidate.slug === slug)).filter((candidate): candidate is Guide => Boolean(candidate));
}
