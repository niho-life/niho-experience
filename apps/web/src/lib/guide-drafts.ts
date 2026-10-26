import "server-only";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Guide, GuideFaqItem, GuideHero } from "@/content/guides/types";
import { guideProblems } from "./guides";

/**
 * Guide drafts for the mock preview (docs/content/guides.md「下書きをプレビューで見る」). Drafts live outside git, as
 * `{slug}.md` files in the folder `GUIDE_DRAFTS_DIR` names: a `---` block of fields, then the body, with an optional
 * `:::faq` block. A draft becomes the same `Guide` a published module is, and passes the same `guideProblems` (body parse
 * included) before it is shown. A draft that does not is skipped and reported with its reasons; nothing here throws.
 */

export type GuideDraftProblem = Readonly<{ file: string; reasons: readonly string[] }>;
export type GuideDrafts = Readonly<{ guides: readonly Guide[]; problems: readonly GuideDraftProblem[] }>;
export type GuideDraftResult = { ok: true; guide: Guide } | { ok: false; reasons: string[] };

/** How the page names the folder in a problem: its path stays on the server. */
export const GUIDE_DRAFTS_FOLDER = "GUIDE_DRAFTS_DIR";

const FIELDS = [
  "title", "description", "author", "authorRole", "publishedAt", "updatedAt",
  "hero", "heroAlt", "heroWidth", "heroHeight", "heroLicensed", "relatedExperiences", "relatedGuides",
] as const;
type Field = (typeof FIELDS)[number];
type Fields = Map<Field, string>;
type Line = { text: string; no: number };

/** Required fields and the label `guideProblems` reports them under (its line is dropped when the field is missing). */
const REQUIRED: ReadonlyArray<readonly [Field, string]> = [
  ["title", "title"], ["description", "description"], ["author", "author.name"], ["authorRole", "author.role"],
  ["publishedAt", "publishedAt"], ["updatedAt", "updatedAt"], ["relatedExperiences", "relatedExperienceSlugs"],
];
const HERO_FIELDS: readonly Field[] = ["hero", "heroAlt", "heroWidth", "heroHeight"];
const FAQ_OPEN = /^:::\s*faq$/;
const isField = (key: string): key is Field => (FIELDS as readonly string[]).includes(key);
const quoted = (fields: readonly string[]) => fields.map((field) => `"${field}"`).join(", ");

/** `key: value` lines, split at the first ": ". Unknown and repeated keys are reasons, never silently dropped. */
function readFields(lines: readonly Line[], reasons: string[]): Fields {
  const fields: Fields = new Map();
  for (const { text, no } of lines) {
    const line = text.trim();
    if (!line) continue;
    const at = line.indexOf(": ");
    const key = at === -1 ? (line.endsWith(":") ? line.slice(0, -1).trim() : "") : line.slice(0, at).trim();
    if (!key) reasons.push(`line ${no}: write each field as "key: value"`);
    else if (!isField(key)) reasons.push(`line ${no}: unknown field "${key}"`);
    else if (fields.has(key)) reasons.push(`line ${no}: "${key}" is written twice`);
    else fields.set(key, at === -1 ? "" : line.slice(at + 2).trim());
  }
  return fields;
}

function readHero(fields: Fields, reasons: string[]): GuideHero | undefined {
  const present = HERO_FIELDS.filter((field) => fields.has(field));
  if (!present.length) {
    if (fields.has("heroLicensed")) reasons.push(`"heroLicensed" goes with a hero: ${quoted(HERO_FIELDS)}`);
    return undefined;
  }
  const missing = HERO_FIELDS.filter((field) => !fields.has(field));
  if (missing.length) {
    reasons.push(`a hero needs ${quoted(missing)} too`);
    return undefined;
  }
  const licensed = fields.get("heroLicensed") ?? "false";
  if (licensed !== "true" && licensed !== "false") reasons.push(`"heroLicensed" must be true or false`);
  // Anything but digits becomes NaN, which guideProblems reports with the other size rules.
  const size = (field: Field) => (/^\d+$/.test(fields.get(field)!) ? Number(fields.get(field)) : Number.NaN);
  return { src: fields.get("hero")!, alt: fields.get("heroAlt")!, width: size("heroWidth"), height: size("heroHeight"), licensed: licensed === "true" };
}

/** `### question` then one paragraph of answer, repeated. */
function readFaqItems(lines: readonly Line[], opener: number, reasons: string[]): GuideFaqItem[] {
  const items: { question: string; no: number; paragraphs: string[][] }[] = [];
  let gap = true;
  for (const { text, no } of lines) {
    const line = text.trim();
    if (!line) {
      gap = true;
      continue;
    }
    const question = /^###\s+(.+)$/.exec(line);
    if (question) {
      items.push({ question: question[1]!.trim(), no, paragraphs: [] });
      gap = true;
    } else if (line.startsWith(":::")) {
      reasons.push(`line ${no}: no box can go inside ":::faq"`);
    } else if (line.startsWith("#") || !items.length) {
      reasons.push(`line ${no}: in ":::faq", start each question with "### "`);
    } else {
      const item = items.at(-1)!;
      if (gap) item.paragraphs.push([line]);
      else item.paragraphs.at(-1)!.push(line);
      gap = false;
    }
  }
  if (!items.length) reasons.push(`line ${opener}: ":::faq" has no "### " questions`);
  return items.flatMap((item) => {
    if (!item.paragraphs.length) reasons.push(`line ${item.no}: the question "${item.question}" has no answer`);
    else if (item.paragraphs.length > 1) reasons.push(`line ${item.no}: the answer to "${item.question}" must be one paragraph`);
    else return [{ question: item.question, answer: item.paragraphs[0]!.join(" ") }];
    return [];
  });
}

/** Takes the one `:::faq` block out of the body (its lines become blank, so body line numbers still match the file). */
function takeFaq(body: Line[], reasons: string[]): GuideFaqItem[] {
  const faq: GuideFaqItem[] = [];
  let seen = false;
  for (let index = 0; index < body.length; index++) {
    const opener = body[index]!;
    if (!FAQ_OPEN.test(opener.text.trim())) continue;
    const close = body.findIndex((line, at) => at > index && line.text.trim() === ":::");
    if (seen) reasons.push(`line ${opener.no}: write only one ":::faq" block`);
    else if (close === -1) reasons.push(`line ${opener.no}: ":::faq" is never closed: end it with a line ":::"`);
    else faq.push(...readFaqItems(body.slice(index + 1, close), opener.no, reasons));
    seen = true;
    const end = close === -1 ? body.length : close + 1;
    for (let at = index; at < end; at++) body[at] = { ...body[at]!, text: "" };
    index = end - 1;
  }
  return faq;
}

/** One draft file (`{slug}.md`) as a `Guide`, or every reason it cannot be shown. Pure: the reader below does the I/O. */
export function parseGuideDraft(file: string, source: string): GuideDraftResult {
  const lines = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n").map((text, index) => ({ text, no: index + 1 }));
  const end = lines[0]?.text.trim() === "---" ? lines.findIndex((line, index) => index > 0 && line.text.trim() === "---") : -1;
  if (end === -1) return { ok: false, reasons: ["start the file with the fields between two \"---\" lines"] };

  const reasons: string[] = [];
  const fields = readFields(lines.slice(1, end), reasons);
  const missing = REQUIRED.filter(([field]) => !fields.has(field));
  for (const [field] of missing) reasons.push(`missing field "${field}"`);
  const hero = readHero(fields, reasons);
  const bodyLines = lines.slice(end + 1);
  const faq = takeFaq(bodyLines, reasons);

  const get = (field: Field) => fields.get(field) ?? "";
  const list = (field: Field) => get(field).split(",").map((item) => item.trim()).filter(Boolean);
  const body = bodyLines.map((line) => line.text).join("\n");
  const guide: Guide = {
    slug: file.replace(/\.md$/, ""),
    title: get("title"),
    description: get("description"),
    author: { name: get("author"), role: get("authorRole") },
    publishedAt: get("publishedAt"),
    updatedAt: get("updatedAt"),
    ...(hero ? { hero } : {}),
    relatedExperienceSlugs: list("relatedExperiences"),
    relatedGuideSlugs: list("relatedGuides"),
    faq,
    body: body.replace(/^(?:[ \t]*\n)+/, "").trimEnd(),
  };
  // The same checks as a published guide. The body keeps the file's line numbers (blank lines stand in for the fields),
  // and a missing field is already reported once above.
  const skip = missing.map(([, label]) => `${label} `);
  const problems = guideProblems({ ...guide, body: `${"\n".repeat(end + 1)}${body}` }).filter((problem) => !skip.some((label) => problem.startsWith(label)));
  reasons.push(...problems);
  return reasons.length ? { ok: false, reasons } : { ok: true, guide };
}

const errorCode = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? ` (${code})` : "";
};

/**
 * Reads every `{slug}.md` in the folder (dotfiles and other files are ignored) on each call: no cache, so a saved draft
 * shows on the next reload. An unreadable folder or file becomes a problem; this never throws.
 */
export async function readGuideDrafts(dir: string): Promise<GuideDrafts> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => !name.startsWith(".") && name.endsWith(".md")).sort();
  } catch (error) {
    return { guides: [], problems: [{ file: GUIDE_DRAFTS_FOLDER, reasons: [`the folder could not be read${errorCode(error)}`] }] };
  }
  const results = await Promise.all(
    names.map(async (file): Promise<[string, GuideDraftResult]> => {
      try {
        return [file, parseGuideDraft(file, await readFile(path.join(dir, file), "utf8"))];
      } catch (error) {
        return [file, { ok: false, reasons: [`the file could not be read${errorCode(error)}`] }];
      }
    }),
  );
  const guides: Guide[] = [];
  const problems: GuideDraftProblem[] = [];
  for (const [file, result] of results) {
    if (result.ok) guides.push(result.guide);
    else problems.push({ file, reasons: result.reasons });
  }
  return { guides, problems };
}
