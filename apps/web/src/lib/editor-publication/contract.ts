import { GUIDE_LIMITS, isGuideDate } from "../guides";

/**
 * PROVISIONAL contract of editor.niho.life's public API (#252 #253, docs/guide-cms.md).
 *
 * niho-life/niho-docs#40 has no machine-readable definition yet, so the paths, field names and response shapes below are
 * assumptions taken from the editor design (§3, §8, §9). This file is the only place that knows them: the rest of the
 * site reads the internal types it returns. When #40 settles, change this file and its tests only.
 *
 * Pure (no config, no network): it turns untrusted JSON into the types below, or says why it cannot. Reasons name fields
 * only, never their values, so they can be logged.
 */

/** The destination this site reads. Items for other destinations are ignored. */
export const EDITOR_PUBLICATION_DEST = "niho-experience";

/** Response size caps (bytes) for the bounded JSON reader. */
export const EDITOR_RESPONSE_LIMITS = { listBytes: 2 * 1024 * 1024, articleBytes: 1024 * 1024, previewBytes: 1024 * 1024 } as const;

/** Opaque editor IDs (articles and assets). */
export const EDITOR_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A preview token as it arrives in `/guides/preview?token=…`, checked before anything is fetched. */
export const GUIDE_PREVIEW_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** `/guides/preview` is the preview route, so no guide may take that slug. */
const RESERVED_SLUGS: ReadonlySet<string> = new Set(["preview"]);
const ISO_TIME = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const CATEGORY_LABEL_MAX = 120;
const CATEGORY_ORDER_MAX = 1_000_000;
const PHOTO_SIDE_MAX = 20_000;
const URL_MAX = 2048;

/** Paths below the configured base URL (`GUIDE_EDITOR_API_BASE_URL`, version path included). */
export const editorPublicationPaths = {
  list: (handle: string) => `/${encodeURIComponent(handle)}/published.json`,
  article: (handle: string, id: string) => `/${encodeURIComponent(handle)}/published/${encodeURIComponent(id)}.json`,
  preview: (token: string) => `/preview/${encodeURIComponent(token)}.json`,
} as const;

export function isEditorGuideSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= GUIDE_LIMITS.slugMaxLength && SLUG.test(value) && !RESERVED_SLUGS.has(value);
}

export type EditorAsset = Readonly<{
  id: string;
  url: string;
  width: number;
  height: number;
  alt: string;
  credit?: string;
  /** True only when the editor declares rights that cover sharing; absent or anything else is false. */
  licensed: boolean;
}>;

export type EditorCategory = Readonly<{ slug: string; label: string; order?: number }>;
export type EditorAuthor = Readonly<{ name: string; role: string; bio?: string }>;

/** One entry of the published list: what a listing needs. `range` decides where it shows. */
export type EditorArticleSummary = Readonly<{
  id: string;
  slug: string;
  range: "live" | "unlisted";
  title: string;
  lead: string;
  cover?: EditorAsset;
  category: EditorCategory;
  author: EditorAuthor;
  /** ISO 8601 date-times: first publication, and the current published version. */
  publishedAt: string;
  updatedAt: string;
}>;

/** The body of one published version. */
export type EditorArticleBody = Readonly<{
  markdown: string;
  assets: readonly EditorAsset[];
  /** Related experience slugs (slug-shaped entries only). */
  related: readonly string[];
  checkedOn?: string;
}>;

export type EditorArticle = EditorArticleSummary & EditorArticleBody;

/** A draft for `/guides/preview`: only the title and the Markdown are required. */
export type EditorPreview = Readonly<{
  title: string;
  markdown: string;
  slug?: string;
  lead?: string;
  cover?: EditorAsset;
  category?: EditorCategory;
  author?: EditorAuthor;
  assets: readonly EditorAsset[];
  related: readonly string[];
  publishedAt?: string;
  checkedOn?: string;
}>;

/** Why one item was left out. `id` and `slug` are present only when well-formed, so a log line never carries free text. */
export type EditorSkip = Readonly<{ id?: string; slug?: string; reason: string }>;

export type EditorPublishedList = Readonly<{ items: readonly EditorArticleSummary[]; skipped: readonly EditorSkip[] }>;
export type EditorArticleBodyResult = Readonly<{ ok: true; body: EditorArticleBody }> | Readonly<{ ok: false; reason: string }>;
export type EditorPreviewResult =
  | Readonly<{ ok: true; preview: EditorPreview }>
  | Readonly<{ ok: false; reason: string; foreign?: true }>;

/** The response itself is unusable (not the shape of the contract at all). */
export class EditorContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditorContractError";
  }
}

class Invalid extends Error {}

type Fields = Record<string, unknown>;
const isRecord = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const absent = (value: unknown) => value === undefined || value === null;

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Invalid(`${label} is missing`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Invalid(`${label} is longer than ${max} characters`);
  return trimmed;
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  return absent(value) || value === "" ? undefined : text(value, label, max);
}

function isoTime(value: unknown, label: string): string {
  const match = typeof value === "string" ? ISO_TIME.exec(value) : null;
  if (!match || !isGuideDate(match[1]!) || !Number.isFinite(Date.parse(value as string))) throw new Invalid(`${label} is not an ISO 8601 date-time`);
  return value as string;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > PHOTO_SIDE_MAX) throw new Invalid(`${label} is not a positive integer`);
  return value as number;
}

function asset(value: unknown, label: string): EditorAsset {
  if (!isRecord(value)) throw new Invalid(`${label} is not an object`);
  if (typeof value.id !== "string" || !EDITOR_ID.test(value.id)) throw new Invalid(`${label}.id is invalid`);
  if (typeof value.url !== "string" || !value.url || value.url.length > URL_MAX) throw new Invalid(`${label}.url is missing`);
  const credit = optionalText(value.credit, `${label}.credit`, GUIDE_LIMITS.captionMaxLength);
  return {
    id: value.id,
    url: value.url,
    width: positiveInteger(value.width, `${label}.width`),
    height: positiveInteger(value.height, `${label}.height`),
    alt: text(value.alt, `${label}.alt`, GUIDE_LIMITS.altMaxLength),
    ...(credit === undefined ? {} : { credit }),
    licensed: value.licensed === true,
  };
}

function category(value: unknown): EditorCategory {
  if (!isRecord(value)) throw new Invalid("category is missing");
  if (typeof value.slug !== "string" || value.slug.length > GUIDE_LIMITS.slugMaxLength || !SLUG.test(value.slug)) throw new Invalid("category.slug is invalid");
  if (!absent(value.order) && (!Number.isInteger(value.order) || (value.order as number) < 0 || (value.order as number) > CATEGORY_ORDER_MAX)) {
    throw new Invalid("category.order is not an integer");
  }
  return {
    slug: value.slug,
    label: text(value.label, "category.label", CATEGORY_LABEL_MAX),
    ...(absent(value.order) ? {} : { order: value.order as number }),
  };
}

function author(value: unknown): EditorAuthor {
  if (!isRecord(value)) throw new Invalid("author is missing");
  const bio = optionalText(value.bio, "author.bio", GUIDE_LIMITS.authorBioMaxLength);
  return {
    name: text(value.name, "author.name", GUIDE_LIMITS.authorMaxLength),
    role: text(value.role, "author.role", GUIDE_LIMITS.authorMaxLength),
    ...(bio === undefined ? {} : { bio }),
  };
}

function relatedSlugs(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Invalid(`${label} is not a list`);
  return [...new Set(value.filter((slug): slug is string => typeof slug === "string" && slug.length <= GUIDE_LIMITS.slugMaxLength && SLUG.test(slug)))];
}

function assets(value: unknown): EditorAsset[] {
  if (!Array.isArray(value)) throw new Invalid("assets is not a list");
  return value.map((item, index) => asset(item, `assets[${index}]`));
}

function checkedOn(value: unknown): string | undefined {
  if (absent(value)) return undefined;
  if (typeof value !== "string" || !isGuideDate(value)) throw new Invalid("checkedOn is not a YYYY-MM-DD date");
  return value;
}

const reasonOf = (error: unknown) => (error instanceof Invalid ? error.message : "the item could not be read");

function skipOf(item: unknown, reason: string): EditorSkip {
  const fields = isRecord(item) ? item : {};
  return {
    ...(typeof fields.id === "string" && EDITOR_ID.test(fields.id) ? { id: fields.id } : {}),
    ...(isEditorGuideSlug(fields.slug) ? { slug: fields.slug } : {}),
    reason,
  };
}

function summary(item: Fields): EditorArticleSummary {
  if (typeof item.id !== "string" || !EDITOR_ID.test(item.id)) throw new Invalid("id is invalid");
  if (!isEditorGuideSlug(item.slug)) throw new Invalid("slug is invalid or reserved");
  if (item.range !== "live" && item.range !== "unlisted") throw new Invalid("range is missing or unknown");
  if (item.lang !== "en") throw new Invalid("lang is not en");
  return {
    id: item.id,
    slug: item.slug,
    range: item.range,
    title: text(item.title, "title", GUIDE_LIMITS.titleMaxLength),
    lead: text(item.lead, "lead", GUIDE_LIMITS.descriptionMaxLength),
    ...(absent(item.cover) ? {} : { cover: asset(item.cover, "cover") }),
    category: category(item.category),
    author: author(item.author),
    publishedAt: isoTime(item.publishedAt, "publishedAt"),
    updatedAt: isoTime(item.updatedAt, "updatedAt"),
  };
}

/**
 * `GET {base}/{handle}/published.json` → `{ items: ListItem[] }`, newest update first. An unusable response throws
 * {@link EditorContractError}; an unusable item is skipped with its reason; an item for another destination is ignored.
 */
export function parseEditorPublishedList(json: unknown): EditorPublishedList {
  if (!isRecord(json) || !Array.isArray(json.items)) throw new EditorContractError("the published list has no items array");
  const items: EditorArticleSummary[] = [];
  const skipped: EditorSkip[] = [];
  for (const item of json.items) {
    if (isRecord(item) && item.dest !== EDITOR_PUBLICATION_DEST) {
      if (typeof item.dest !== "string") skipped.push(skipOf(item, "dest is missing"));
      continue;
    }
    try {
      if (!isRecord(item)) throw new Invalid("the item is not an object");
      items.push(summary(item));
    } catch (error) {
      skipped.push(skipOf(item, reasonOf(error)));
    }
  }
  return { items, skipped };
}

/**
 * `GET {base}/{handle}/published/{id}.json` → the list item's fields plus `markdown`, `blocks`, `assets`, `related` and
 * `checkedOn`. Only the body is read: the list stays the source of the listing fields (`range` above all), so a cached
 * body never brings back an old range. `blocks` (the AST) is not used in v1: the Markdown is rendered.
 */
export function parseEditorArticleBody(json: unknown, expectedId: string): EditorArticleBodyResult {
  try {
    if (!isRecord(json)) throw new Invalid("the article is not an object");
    if (json.id !== expectedId) throw new Invalid("id does not match the list");
    if (json.dest !== EDITOR_PUBLICATION_DEST) throw new Invalid("dest is not this site");
    if (typeof json.markdown !== "string") throw new Invalid("markdown is missing");
    const checked = checkedOn(json.checkedOn);
    return {
      ok: true,
      body: {
        markdown: json.markdown,
        assets: assets(json.assets),
        related: relatedSlugs(json.related, "related"),
        ...(checked === undefined ? {} : { checkedOn: checked }),
      },
    };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}

/** A lenient read for optional draft fields: a malformed value counts as not written yet. */
function lenient<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * `GET {base}/preview/{token}.json`: a draft. Drafts need not meet the publication conditions, so only `title` and
 * `markdown` are required and a malformed optional field counts as missing. A draft for another destination is foreign.
 */
export function parseEditorPreview(json: unknown): EditorPreviewResult {
  if (!isRecord(json)) return { ok: false, reason: "The preview is not an object." };
  if (!absent(json.dest) && json.dest !== EDITOR_PUBLICATION_DEST) return { ok: false, reason: "The preview is for another destination.", foreign: true };
  if (typeof json.title !== "string" || !json.title.trim()) return { ok: false, reason: "The draft has no title yet." };
  if (typeof json.markdown !== "string") return { ok: false, reason: "The draft has no body." };
  const lead = lenient(() => optionalText(json.lead, "lead", Number.MAX_SAFE_INTEGER));
  const cover = absent(json.cover) ? undefined : lenient(() => asset(json.cover, "cover"));
  const draftCategory = lenient(() => category(json.category));
  const draftAuthor = lenient(() => author(json.author));
  const publishedAt = lenient(() => isoTime(json.publishedAt, "publishedAt"));
  const checked = lenient(() => checkedOn(json.checkedOn));
  return {
    ok: true,
    preview: {
      title: json.title.trim(),
      markdown: json.markdown,
      ...(isEditorGuideSlug(json.slug) ? { slug: json.slug } : {}),
      ...(lead === undefined ? {} : { lead }),
      ...(cover === undefined ? {} : { cover }),
      ...(draftCategory === undefined ? {} : { category: draftCategory }),
      ...(draftAuthor === undefined ? {} : { author: draftAuthor }),
      assets: Array.isArray(json.assets) ? json.assets.flatMap((item, index) => lenient(() => [asset(item, `assets[${index}]`)]) ?? []) : [],
      related: lenient(() => relatedSlugs(json.related, "related")) ?? [],
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(checked === undefined ? {} : { checkedOn: checked }),
    },
  };
}
