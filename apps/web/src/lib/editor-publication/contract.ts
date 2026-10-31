import { GUIDE_LIMITS, isGuideDate } from "../guides";

/**
 * editor.niho.life's publish API, contract v1 (niho-life/niho-editor docs/security/editor-publish-api-v1.md and
 * packages/editor-publish-contract, #40). This site reads it as the face `exp` (NIHO Experience).
 *
 * This file is the only place that knows the wire shapes: the rest of the site reads the internal types it returns.
 * Pure (no config, no network): it turns untrusted JSON into the types below, or says why it cannot. Reasons name fields
 * only, never their values, so they can be logged.
 */

/** This site's destination (and handle) on the editor. Items for any other destination are left out. */
export const EDITOR_PUBLICATION_DEST = "exp";
export const EDITOR_CONTRACT_VERSION = "1";

/** `limit` of every list page: the contract's maximum. A page with more items than this is not the contract. */
export const EDITOR_LIST_PAGE_LIMIT = 100;

/** Response size caps (bytes) for the bounded JSON reader. */
export const EDITOR_RESPONSE_LIMITS = { listBytes: 2 * 1024 * 1024, articleBytes: 1024 * 1024, previewBytes: 1024 * 1024 } as const;

/** A publication's ID: the page's UUID, lower case. */
export const EDITOR_ARTICLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An asset's opaque ID. */
export const EDITOR_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** An opaque list cursor: only characters that need no escaping in a query. */
export const EDITOR_CURSOR = /^[A-Za-z0-9._~-]{1,512}$/;
/** A preview token (`pv_` + 43 base64url characters) as it arrives in `/guides/preview?token=…`, checked before anything is fetched. */
export const GUIDE_PREVIEW_TOKEN = /^pv_[A-Za-z0-9_-]{43}$/;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** `/guides/preview` is the preview route, so no guide may take that slug. */
const RESERVED_SLUGS: ReadonlySet<string> = new Set(["preview"]);
const ISO_TIME = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const IMAGE_CONTENT_TYPES: ReadonlySet<unknown> = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);
const SHA256 = /^[0-9a-f]{64}$/;
const URL_MAX = 2048;

/** Paths below the configured base URL (`GUIDE_EDITOR_API_BASE_URL`, version path included). */
export const editorPublicationPaths = {
  /** One page of the list: the largest page, `unlisted` included (this site shows those by direct link only). */
  list: (handle: string, page: Readonly<{ cursor?: string }> = {}) =>
    `/${encodeURIComponent(handle)}/published.json?limit=${EDITOR_LIST_PAGE_LIMIT}&include=unlisted${page.cursor === undefined ? "" : `&cursor=${encodeURIComponent(page.cursor)}`}`,
  article: (handle: string, id: string) => `/${encodeURIComponent(handle)}/published/${encodeURIComponent(id)}.json`,
  preview: (token: string) => `/preview/${encodeURIComponent(token)}.json`,
} as const;

export function isEditorGuideSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= GUIDE_LIMITS.slugMaxLength && SLUG.test(value) && !RESERVED_SLUGS.has(value);
}

/** The contract carries no category label: `walks` → `Walks`, `day-trips` → `Day trips`. */
export function editorCategoryLabel(slug: string): string {
  const words = slug.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A photo. v1 carries no pixel size and no sharing rights (see convert.ts). `alt` may be empty. */
export type EditorAsset = Readonly<{ id: string; url: string; alt: string; credit?: string }>;

export type EditorCategory = Readonly<{ slug: string; label: string; order?: number }>;
/** The publish-time author. The contract's `handle` and `url` are checked but not kept: the page shows the name only. */
export type EditorAuthor = Readonly<{ name: string }>;

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
  /** Related experience slugs (slug-shaped entries only), from the list: the body never overrides them. */
  related: readonly string[];
  /** ISO 8601 date-times: first publication, and the current published version. */
  publishedAt: string;
  updatedAt: string;
}>;

/** The body of one published version. */
export type EditorArticleBody = Readonly<{ markdown: string; assets: readonly EditorAsset[] }>;

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
}>;

/** Why one item was left out. `id` and `slug` are present only when well-formed, so a log line never carries free text. */
export type EditorSkip = Readonly<{ id?: string; slug?: string; reason: string }>;

/** One page of the list as read; `nextCursor` is null on the last page. */
export type EditorPublishedPage = Readonly<{ items: readonly EditorArticleSummary[]; skipped: readonly EditorSkip[]; nextCursor: string | null }>;
/** Every page of the list, in order. */
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

function asset(value: unknown, label: string): EditorAsset {
  if (!isRecord(value)) throw new Invalid(`${label} is not an object`);
  if (typeof value.id !== "string" || !EDITOR_ID.test(value.id)) throw new Invalid(`${label}.id is invalid`);
  if (typeof value.url !== "string" || !value.url || value.url.length > URL_MAX) throw new Invalid(`${label}.url is missing`);
  if (!IMAGE_CONTENT_TYPES.has(value.contentType)) throw new Invalid(`${label}.contentType is not a supported image type`);
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0) throw new Invalid(`${label}.bytes is not a positive integer`);
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) throw new Invalid(`${label}.sha256 is invalid`);
  // Empty alt is allowed: the editor sends what the writer entered.
  if (typeof value.alt !== "string") throw new Invalid(`${label}.alt is not text`);
  const credit = value.credit === null ? undefined : text(value.credit, `${label}.credit`, GUIDE_LIMITS.captionMaxLength);
  return { id: value.id, url: value.url, alt: value.alt, ...(credit === undefined ? {} : { credit }) };
}

function category(value: unknown): EditorCategory {
  if (absent(value)) throw new Invalid("category is missing");
  if (typeof value !== "string" || value.length > GUIDE_LIMITS.slugMaxLength || !SLUG.test(value)) throw new Invalid("category is not a slug");
  // No order: the category sorts after every ordered one (EDITOR_CATEGORY_DEFAULT_ORDER).
  return { slug: value, label: editorCategoryLabel(value) };
}

function author(value: unknown): EditorAuthor {
  if (!isRecord(value)) throw new Invalid("author is missing");
  const name = text(value.name, "author.name", GUIDE_LIMITS.authorMaxLength);
  if (value.handle !== null && typeof value.handle !== "string") throw new Invalid("author.handle is not text or null");
  if (value.url !== null && typeof value.url !== "string") throw new Invalid("author.url is not text or null");
  return { name };
}

function relatedSlugs(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Invalid(`${label} is not a list`);
  return [...new Set(value.filter((slug): slug is string => typeof slug === "string" && slug.length <= GUIDE_LIMITS.slugMaxLength && SLUG.test(slug)))];
}

function assets(value: unknown): EditorAsset[] {
  if (!Array.isArray(value)) throw new Invalid("assets is not a list");
  return value.map((item, index) => asset(item, `assets[${index}]`));
}

const reasonOf = (error: unknown) => (error instanceof Invalid ? error.message : "the item could not be read");

function skipOf(item: unknown, reason: string): EditorSkip {
  const fields = isRecord(item) ? item : {};
  return {
    ...(typeof fields.id === "string" && EDITOR_ARTICLE_ID.test(fields.id) ? { id: fields.id } : {}),
    ...(isEditorGuideSlug(fields.slug) ? { slug: fields.slug } : {}),
    reason,
  };
}

function summary(item: Fields): EditorArticleSummary {
  if (absent(item.dest)) throw new Invalid("dest is missing");
  if (item.dest !== EDITOR_PUBLICATION_DEST) throw new Invalid("dest is not exp");
  if (typeof item.id !== "string" || !EDITOR_ARTICLE_ID.test(item.id)) throw new Invalid("id is invalid");
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
    related: relatedSlugs(item.related, "related"),
    publishedAt: isoTime(item.publishedAt, "publishedAt"),
    updatedAt: isoTime(item.updatedAt, "updatedAt"),
  };
}

/**
 * One page of `GET {base}/{handle}/published.json?limit=100&include=unlisted[&cursor=…]` → `{ contractVersion: "1",
 * items, nextCursor }`, newest update first. A response that is not that shape (another contract version, more items
 * than a page holds, a malformed cursor) throws {@link EditorContractError}; an unusable item is skipped with its reason.
 * `canonicalUrl` and `extras` are not read: this site builds its URLs from SITE_URL.
 */
export function parseEditorPublishedList(json: unknown): EditorPublishedPage {
  if (!isRecord(json)) throw new EditorContractError("the published list is not an object");
  if (json.contractVersion !== EDITOR_CONTRACT_VERSION) throw new EditorContractError("the published list is not contract version 1");
  if (!Array.isArray(json.items)) throw new EditorContractError("the published list has no items array");
  if (json.items.length > EDITOR_LIST_PAGE_LIMIT) throw new EditorContractError(`the published list has more than ${EDITOR_LIST_PAGE_LIMIT} items on a page`);
  const { nextCursor } = json;
  if (nextCursor !== null && !(typeof nextCursor === "string" && EDITOR_CURSOR.test(nextCursor))) throw new EditorContractError("the published list's nextCursor is invalid");
  const items: EditorArticleSummary[] = [];
  const skipped: EditorSkip[] = [];
  for (const item of json.items) {
    try {
      if (!isRecord(item)) throw new Invalid("the item is not an object");
      items.push(summary(item));
    } catch (error) {
      skipped.push(skipOf(item, reasonOf(error)));
    }
  }
  return { items, skipped, nextCursor };
}

/**
 * `GET {base}/{handle}/published/{id}.json` → the list item's fields plus `blocks`, `markdown`, `assets` and
 * `contractVersion`. Only the body is read: the list stays the source of the listing fields (`range` and `related` above
 * all), so a cached body never brings back an old range. `blocks` (the AST, the editor's source of truth) must be there
 * but is not read: the Markdown projection is rendered by this site's own safe renderer.
 */
export function parseEditorArticleBody(json: unknown, expectedId: string): EditorArticleBodyResult {
  try {
    if (!isRecord(json)) throw new Invalid("the article is not an object");
    if (json.id !== expectedId) throw new Invalid("id does not match the list");
    if (json.dest !== EDITOR_PUBLICATION_DEST) throw new Invalid("dest is not exp");
    if (json.contractVersion !== EDITOR_CONTRACT_VERSION) throw new Invalid("contractVersion is not 1");
    if (typeof json.markdown !== "string") throw new Invalid("markdown is missing");
    const body = { markdown: json.markdown, assets: assets(json.assets) };
    if (!Array.isArray(json.blocks)) throw new Invalid("blocks is not a list");
    return { ok: true, body };
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
 * `GET {base}/preview/{token}.json`: a draft (a published document plus `preview: { expiresAt, dest, noindex }`). Drafts
 * need not meet the publication conditions, so only `title` and `markdown` are required and a malformed optional field
 * counts as missing. A draft for another destination is foreign (a 404, like an unknown token).
 */
export function parseEditorPreview(json: unknown): EditorPreviewResult {
  if (!isRecord(json)) return { ok: false, reason: "The preview is not an object." };
  const info = isRecord(json.preview) ? json.preview : {};
  if (json.dest !== EDITOR_PUBLICATION_DEST || info.dest !== EDITOR_PUBLICATION_DEST) return { ok: false, reason: "The preview is for another destination.", foreign: true };
  if (json.contractVersion !== EDITOR_CONTRACT_VERSION) return { ok: false, reason: "The preview is not contract version 1 (contractVersion)." };
  if (typeof json.title !== "string" || !json.title.trim()) return { ok: false, reason: "The draft has no title yet." };
  if (typeof json.markdown !== "string") return { ok: false, reason: "The draft has no body." };
  const lead = lenient(() => optionalText(json.lead, "lead", Number.MAX_SAFE_INTEGER));
  const cover = absent(json.cover) ? undefined : lenient(() => asset(json.cover, "cover"));
  const draftCategory = lenient(() => category(json.category));
  const draftAuthor = lenient(() => author(json.author));
  const publishedAt = lenient(() => isoTime(json.publishedAt, "publishedAt"));
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
    },
  };
}
