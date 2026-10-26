import { PILLARS, type GuideMeta, type Pillar } from "./types";
import { guideImageSrc } from "./urls";

export const GUIDE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const TITLE_MAX = 70;
export const DESCRIPTION_MAX = 160;
export const EXPERIENCES_MAX = 3;

const KEYS = [
  "title", "description", "pillar", "type", "author", "authorRole", "published", "updated",
  "factsChecked", "hero", "heroAlt", "heroCredit", "experiences", "related",
] as const;
type Key = (typeof KEYS)[number];
const REQUIRED: readonly Key[] = ["title", "description", "pillar", "author", "authorRole", "published", "updated", "hero", "heroAlt"];

/** Splits `---` front matter from the body. `bodyStartLine` is the 1-based line number of the body's first line. */
export function splitFrontMatter(source: string): { frontMatter: string; body: string; bodyStartLine: number } | null {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return null;
  return { frontMatter: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n"), bodyStartLine: end + 2 };
}

/**
 * One `key: value` per line, split at the first `": "`. Unknown, repeated and malformed lines are errors
 * (a typo such as `heroalt:` must not silently drop a required value).
 */
export function parseFrontMatterLines(frontMatter: string): { values: Map<string, string>; errors: string[] } {
  const values = new Map<string, string>();
  const errors: string[] = [];
  frontMatter.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const at = line.indexOf(": ");
    const key = at >= 0 ? line.slice(0, at).trim() : line.endsWith(":") ? line.slice(0, -1).trim() : "";
    const value = at >= 0 ? line.slice(at + 2).trim() : "";
    if (!key) {
      errors.push(`front matter line ${index + 2} is not "key: value"`);
      return;
    }
    if (!(KEYS as readonly string[]).includes(key)) {
      errors.push(`unknown front matter key "${key}"`);
      return;
    }
    if (values.has(key)) {
      errors.push(`front matter key "${key}" is repeated`);
      return;
    }
    values.set(key, value);
  });
  return { values, errors };
}

const length = (value: string) => Array.from(value).length;

/** A real calendar date written as `YYYY-MM-DD`. */
export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const list = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

/** Validates the front matter against docs/content/guides.md. `slug` comes from the file name. */
export function readGuideMeta(slug: string, frontMatter: string): { meta: GuideMeta | null; errors: string[] } {
  const { values, errors } = parseFrontMatterLines(frontMatter);
  const get = (key: Key) => values.get(key) || "";
  if (!GUIDE_SLUG.test(slug)) errors.push(`file name "${slug}.md" must be lowercase letters, digits and single hyphens`);
  for (const key of REQUIRED) if (!get(key)) errors.push(`"${key}" is required`);

  const title = get("title");
  if (length(title) > TITLE_MAX) errors.push(`"title" is ${length(title)} characters (at most ${TITLE_MAX})`);
  const description = get("description");
  if (length(description) > DESCRIPTION_MAX) errors.push(`"description" is ${length(description)} characters (at most ${DESCRIPTION_MAX})`);

  const pillar = get("pillar");
  if (pillar && !(PILLARS as readonly string[]).includes(pillar)) errors.push(`"pillar" must be one of ${PILLARS.join(", ")}`);
  const type = get("type") || "guide";
  if (type !== "pillar" && type !== "guide") errors.push(`"type" must be pillar or guide`);

  const published = get("published");
  const updated = get("updated");
  const factsChecked = get("factsChecked");
  for (const [key, value] of [["published", published], ["updated", updated], ["factsChecked", factsChecked]] as const) {
    if (value && !isIsoDate(value)) errors.push(`"${key}" must be a real date written YYYY-MM-DD`);
  }
  if (isIsoDate(published) && isIsoDate(updated) && updated < published) errors.push(`"updated" must not be before "published"`);

  const hero = get("hero");
  if (hero && !guideImageSrc(hero)) errors.push(`"hero" must be a site path starting with "/" or an https:// URL`);

  const experiences = list(values.get("experiences"));
  if (experiences.length > EXPERIENCES_MAX) errors.push(`"experiences" lists ${experiences.length} experiences (at most ${EXPERIENCES_MAX})`);
  const related = list(values.get("related"));
  for (const [key, slugs] of [["experiences", experiences], ["related", related]] as const) {
    for (const item of slugs) if (!GUIDE_SLUG.test(item)) errors.push(`"${key}" has "${item}", which is not a slug`);
  }

  if (errors.length) return { meta: null, errors };
  return {
    meta: {
      slug,
      title,
      description,
      pillar: pillar as Pillar,
      type: type as GuideMeta["type"],
      author: get("author"),
      authorRole: get("authorRole"),
      published,
      updated,
      factsChecked: factsChecked || null,
      hero: guideImageSrc(hero) ?? hero,
      heroAlt: get("heroAlt"),
      heroCredit: get("heroCredit") || null,
      experiences: [...new Set(experiences)],
      related: [...new Set(related)].filter((item) => item !== slug),
    },
    errors,
  };
}
