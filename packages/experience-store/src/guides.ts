import { parseGuideAssetFigureLine } from "@niho-experience/experience-domain";
import type { Pool, PoolClient } from "pg";
import {
  StoreAccessDeniedError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
} from "./errors.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import { assertNonEmptyText, assertStoreIdentifier } from "./validation.ts";

export type GuideArticleStatus = "DRAFT" | "PUBLISHED" | "STOPPED" | "OPS_STOPPED";
export type GuidePublicationVisibility = "PUBLIC" | "UNLISTED";
export type GuideMediaAssetState = "UPLOADING" | "READY" | "REVOKED";

export type GuideActorId = string;

export type GuideSubject =
  | { readonly kind: "WRITER" }
  | { readonly kind: "PROVIDER"; readonly providerId: string };

export interface GuideAuthor {
  readonly name: string;
  readonly role: string;
  readonly bio: string;
}

/** Markdown is stored and returned as Markdown. This store never accepts or returns rendered HTML. */
export interface GuideContent {
  readonly markdown: string;
  /** New Experience-owned drafts declare their publication language explicitly. */
  readonly language?: "en";
  readonly author?: GuideAuthor;
  readonly checkedOn?: string;
}

export interface GuideCategory {
  readonly slug: string;
  readonly labelEn: string;
  readonly labelJa: string;
  readonly displayOrder: number;
}

export interface CreateGuideArticleInput {
  readonly id: string;
  readonly slug: string;
  readonly subject: { readonly kind: "PROVIDER"; readonly providerId: string };
  readonly title: string;
  readonly description?: string;
  readonly categorySlug?: string;
  readonly content?: GuideContent;
}

export interface SaveGuideDraftInput {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly categorySlug?: string;
  readonly content: GuideContent;
  /** undefined preserves the current cover, null removes it. */
  readonly cover?: GuideDraftCover | null;
  /** undefined preserves the current ordered selection. */
  readonly draftProductLinks?: readonly GuideProductLinkInput[];
}

export interface GuideDraftCover {
  readonly assetId: string;
  readonly alt: string;
  readonly credit: string;
  readonly webConfirmed: boolean;
}

export interface GuideMediaAssetRecord {
  readonly id: string;
  readonly articleId: string;
  readonly creatorNihoUserId: string;
  readonly uploadedByActorId: string;
  /** Private storage detail. Never serialize this record into a browser response. */
  readonly objectKey: string;
  readonly state: GuideMediaAssetState;
  readonly width?: number;
  readonly height?: number;
  readonly byteSize?: number;
  readonly publicCredit?: string;
  readonly webConfirmedAtUtc?: string;
  readonly webConfirmedByNihoUserId?: string;
}

export interface GuideMediaAssetSummary {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly publicCredit?: string;
  readonly webConfirmed: boolean;
}

export interface GuideProductLinkInput {
  readonly providerId: string;
  readonly productId: string;
}

export interface GuideArticleRecord {
  readonly id: string;
  readonly slug: string;
  readonly subject: { readonly kind: "PROVIDER"; readonly providerId: string };
  readonly title: string;
  readonly description: string;
  readonly categorySlug?: string;
  readonly content: GuideContent;
  readonly cover?: GuideDraftCover;
  readonly draftProductLinks: readonly GuideProductLinkInput[];
  readonly status: GuideArticleStatus;
  readonly opsStopReason?: string;
  readonly opsStopContact?: string;
  readonly revision: number;
  readonly currentPublication?: {
    readonly id: number;
    readonly number: number;
    readonly sourceRevision: number;
    readonly visibility: GuidePublicationVisibility;
    readonly publishedAtUtc: string;
  };
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
}

export interface CommitGuidePublicationInput {
  readonly expectedRevision: number;
  readonly visibility: GuidePublicationVisibility;
}

export interface PublicGuideProductLink {
  readonly providerId: string;
  readonly productId: string;
  /** Current public slug, re-read with the product status for public catalogue intersection. */
  readonly productSlug: string;
}

export interface PublicGuideArticle {
  readonly articleId: string;
  readonly publicationId: number;
  readonly publicationNumber: number;
  readonly sourceRevision: number;
  readonly slug: string;
  readonly subject: GuideSubject;
  readonly category: GuideCategory;
  readonly title: string;
  readonly description: string;
  readonly content: GuideContent;
  readonly visibility: GuidePublicationVisibility;
  readonly indexable: boolean;
  readonly productLinks: readonly PublicGuideProductLink[];
  readonly cover?: PublicGuideCover;
  readonly figures: readonly PublicGuideFigure[];
  /** The first sealed publication time, including an earlier UNLISTED publication. */
  readonly firstPublishedAtUtc: string;
  /** The current publication time; a new publication is an article update. */
  readonly publishedAtUtc: string;
}

export interface PublicGuideCover {
  readonly assetId: string;
  readonly alt: string;
  readonly credit: string;
  readonly width: number;
  readonly height: number;
}

export interface PublicGuideFigure {
  readonly slot: number;
  readonly assetId: string;
  readonly alt: string;
  readonly credit: string;
}

const GUIDE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MARKDOWN_LENGTH = 500_000;
const MAX_GUIDE_FIGURES = 10;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARTICLE_COLUMNS = `
  a.id, a.slug, a.creator_niho_user_id, a.subject_kind, a.subject_provider_id,
  a.category_slug, a.title, a.description, a.content,
  a.cover_asset_id::text AS cover_asset_id, a.cover_alt, a.cover_credit, a.cover_web_confirmed,
  a.status, a.ops_stop_reason, a.ops_stop_contact, a.revision,
  a.created_at, a.updated_at, p.id AS current_publication_id,
  p.publication_number AS current_publication_number,
  p.source_revision AS current_publication_source_revision,
  p.visibility AS current_publication_visibility,
  p.published_at AS current_publication_published_at,
  (SELECT coalesce(
     jsonb_agg(
       jsonb_build_object('providerId', draft_link.provider_id, 'productId', draft_link.product_id)
       ORDER BY draft_link.display_order
     ),
     '[]'::jsonb
   ) FROM guide_draft_product_links draft_link WHERE draft_link.article_id=a.id) AS draft_product_links`;
const PUBLICATION_COLUMNS = `
  p.article_id, p.id AS publication_id, p.publication_number, p.source_revision,
  p.slug, p.subject_kind, p.subject_provider_id, p.category_slug,
  p.category_label_en, p.category_label_ja, p.category_display_order,
  p.title, p.description, p.content,
  p.visibility, p.published_at`;
const FIRST_PUBLICATION_COLUMN = `
  (SELECT min(first_publication.published_at)
     FROM guide_publications first_publication
    WHERE first_publication.article_id=p.article_id AND first_publication.sealed=true) AS first_published_at`;
const MEDIA_ASSET_COLUMNS = `
  id::text AS id, article_id, creator_niho_user_id, uploaded_by_actor_id, object_key, state,
  width, height, byte_size, public_credit, web_confirmed_at,
  web_confirmed_by_niho_user_id`;

function stringValue(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new StoreValidationError(`Database returned an invalid ${key}.`);
  return value;
}

function optionalString(row: DbRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new StoreValidationError(`Database returned an invalid ${key}.`);
  return value;
}

function integerValue(row: DbRow, key: string): number {
  const value = row[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new StoreValidationError(`Database returned an invalid ${key}.`);
  return parsed;
}

function optionalIsoValue(row: DbRow, key: string): string | undefined {
  return row[key] === null || row[key] === undefined ? undefined : isoValue(row, key);
}

function booleanValue(row: DbRow, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") throw new StoreValidationError(`Database returned an invalid ${key}.`);
  return value;
}

function validateActorId(actorId: GuideActorId): void {
  assertStoreIdentifier(actorId, "actorId");
}

function validateSlug(slug: string): void {
  if (!GUIDE_SLUG.test(slug) || slug.length > 160) {
    throw new StoreValidationError("guide.slug must use 1-160 lower-case letters, digits, and single hyphens.");
  }
}

function validateAssetId(assetId: string): void {
  if (!UUID_V4.test(assetId)) throw new StoreValidationError("guide media assetId must be a UUID v4.");
}

function validateRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new StoreValidationError("expectedRevision must be a positive integer.");
  }
}

function validateCategorySlug(slug: string): void {
  if (!GUIDE_SLUG.test(slug) || slug.length > 80) {
    throw new StoreValidationError("guide.categorySlug must be a stable 1-80 character slug.");
  }
}

function validateCover(cover: GuideDraftCover): GuideDraftCover {
  validateAssetId(cover.assetId);
  assertDraftText(cover.alt, "guide.cover.alt", 300);
  assertDraftText(cover.credit, "guide.cover.credit", 300);
  if (typeof cover.webConfirmed !== "boolean") {
    throw new StoreValidationError("guide.cover.webConfirmed must be a boolean.");
  }
  return cover;
}

function assertDraftText(value: unknown, field: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new StoreValidationError(`${field} must be a string of at most ${maxLength} characters.`);
  }
}

function assertPublicationUsesLatinScript(title: string, markdown: string): void {
  const nonLatinLetter = /(?!\p{Script=Latin})\p{Letter}/u;
  if (nonLatinLetter.test(title) || nonLatinLetter.test(markdown)) {
    throw new StoreValidationError("Guide publication title and body must use Latin script.");
  }
}

function isCanonicalIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validateAuthor(value: unknown): GuideAuthor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreValidationError("guide.content.author must be an object.");
  }
  const author = value as Record<string, unknown>;
  if (Object.keys(author).some((key) => !["name", "role", "bio"].includes(key))) {
    throw new StoreValidationError("guide.content.author contains an unsupported field.");
  }
  const name = author.name;
  const role = author.role;
  const bio = author.bio;
  if (typeof name !== "string" || typeof role !== "string" || typeof bio !== "string") {
    throw new StoreValidationError("guide.content.author name, role, and bio must be strings.");
  }
  assertNonEmptyText(name, "guide.content.author.name", 120);
  assertNonEmptyText(role, "guide.content.author.role", 160);
  assertNonEmptyText(bio, "guide.content.author.bio", 500);
  return { name, role, bio };
}

export function parseGuideContent(value: unknown): GuideContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreValidationError("guide.content must be a JSON object.");
  }
  const content = value as Record<string, unknown>;
  if (Object.keys(content).some((key) => !["markdown", "language", "author", "checkedOn"].includes(key))) {
    throw new StoreValidationError("guide.content contains an unsupported field.");
  }
  if (typeof content.markdown !== "string" || content.markdown.length > MAX_MARKDOWN_LENGTH) {
    throw new StoreValidationError(`guide.content.markdown must be a string of at most ${MAX_MARKDOWN_LENGTH} characters.`);
  }
  const author = content.author === undefined ? undefined : validateAuthor(content.author);
  const language = content.language;
  if (language !== undefined && language !== "en") {
    throw new StoreValidationError("guide.content.language must be en.");
  }
  const checkedOn = content.checkedOn;
  if (checkedOn !== undefined && (typeof checkedOn !== "string" || !isCanonicalIsoDate(checkedOn))) {
    throw new StoreValidationError("guide.content.checkedOn must be an ISO date (YYYY-MM-DD).");
  }
  return {
    markdown: content.markdown,
    ...(language === undefined ? {} : { language }),
    ...(author === undefined ? {} : { author }),
    ...(checkedOn === undefined ? {} : { checkedOn: checkedOn as string }),
  };
}

function validateProductLinks(links: readonly GuideProductLinkInput[]): void {
  if (links.length > 3) throw new StoreValidationError("A guide may link at most three products.");
  const keys = new Set<string>();
  for (const link of links) {
    assertStoreIdentifier(link.providerId, "guide.productLink.providerId");
    assertStoreIdentifier(link.productId, "guide.productLink.productId");
    const key = `${link.providerId}\u0000${link.productId}`;
    if (keys.has(key)) throw new StoreValidationError("Guide product links must be unique.");
    keys.add(key);
  }
}

function draftProductLinksFromRow(row: DbRow): readonly GuideProductLinkInput[] {
  const value = row.draft_product_links;
  if (!Array.isArray(value)) throw new StoreValidationError("Database returned invalid draft product links.");
  const links = value.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new StoreValidationError("Database returned an invalid draft product link.");
    }
    const providerId = (candidate as Record<string, unknown>).providerId;
    const productId = (candidate as Record<string, unknown>).productId;
    if (typeof providerId !== "string" || typeof productId !== "string") {
      throw new StoreValidationError("Database returned an invalid draft product link.");
    }
    return { providerId, productId };
  });
  validateProductLinks(links);
  return links;
}

function articleFromRow(row: DbRow): GuideArticleRecord {
  if (stringValue(row, "subject_kind") !== "PROVIDER") {
    throw new StoreAccessDeniedError();
  }
  const categorySlug = optionalString(row, "category_slug");
  const currentPublicationId = row.current_publication_id === null || row.current_publication_id === undefined
    ? undefined
    : integerValue(row, "current_publication_id");
  const coverAssetId = optionalString(row, "cover_asset_id");
  const status = stringValue(row, "status") as GuideArticleStatus;
  return {
    id: stringValue(row, "id"),
    slug: stringValue(row, "slug"),
    subject: { kind: "PROVIDER", providerId: stringValue(row, "subject_provider_id") },
    title: stringValue(row, "title"),
    description: stringValue(row, "description"),
    ...(categorySlug === undefined ? {} : { categorySlug }),
    content: parseGuideContent(row.content),
    ...(coverAssetId === undefined
      ? {}
      : {
          cover: {
            assetId: coverAssetId,
            alt: stringValue(row, "cover_alt"),
            credit: stringValue(row, "cover_credit"),
            webConfirmed: booleanValue(row, "cover_web_confirmed"),
          },
        }),
    draftProductLinks: draftProductLinksFromRow(row),
    status,
    ...(status === "OPS_STOPPED"
      ? {
          opsStopReason: stringValue(row, "ops_stop_reason"),
          opsStopContact: stringValue(row, "ops_stop_contact"),
        }
      : {}),
    revision: integerValue(row, "revision"),
    ...(currentPublicationId === undefined
      ? {}
      : {
          currentPublication: {
            id: currentPublicationId,
            number: integerValue(row, "current_publication_number"),
            sourceRevision: integerValue(row, "current_publication_source_revision"),
            visibility: stringValue(row, "current_publication_visibility") as GuidePublicationVisibility,
            publishedAtUtc: isoValue(row, "current_publication_published_at"),
          },
        }),
    createdAtUtc: isoValue(row, "created_at"),
    updatedAtUtc: isoValue(row, "updated_at"),
  };
}

type GuideFigureReference = { readonly assetId: string; readonly alt: string };
type GuideMarkdownReview = {
  readonly figures: readonly GuideFigureReference[];
  readonly paragraphs: readonly string[];
  readonly hasLevelTwoHeading: boolean;
};

function validateGuideHref(value: string): boolean {
  if (!value || /[\s\\<>"'`]/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith("/")) return !value.startsWith("//");
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function plainGuideInline(source: string): string {
  return source
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\[CONFIRM:\s*([^\]]+)\]/gi, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function validateGuideInline(source: string, lineNumber: number): void {
  const emphasis: number[] = [];
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    const next = source[index + 1] ?? "";
    if (character === "\\") {
      if (!next || !/[!-/:-@[-`{-~]/.test(next)) {
        throw new StoreValidationError(`guide.content.markdown line ${lineNumber} has an invalid escape.`);
      }
      index++;
      continue;
    }
    if (character === "`" || character === "_"
      || (character === "~" && next === "~")
      || (character === "<" && /[A-Za-z/!?]/.test(next))
      || (character === "&" && /^&#?[A-Za-z0-9]+;/.test(source.slice(index)))) {
      throw new StoreValidationError(`guide.content.markdown line ${lineNumber} contains unsupported inline markup.`);
    }
    if (character === "!" && next === "[") {
      throw new StoreValidationError("Guide photos must use the canonical niho-guide-asset UUID format on their own line.");
    }
    if (character === "]") {
      throw new StoreValidationError(`guide.content.markdown line ${lineNumber} has an unmatched ].`);
    }
    if (character === "[") {
      const close = source.indexOf("]", index + 1);
      if (close === -1 || source.slice(index + 1, close).includes("[")) {
        throw new StoreValidationError(`guide.content.markdown line ${lineNumber} has an unclosed or nested link.`);
      }
      if (source.slice(index, index + 9).toUpperCase() === "[CONFIRM:") {
        if (!source.slice(index + 9, close).trim()) {
          throw new StoreValidationError(`guide.content.markdown line ${lineNumber} has an empty CONFIRM marker.`);
        }
        index = close;
        continue;
      }
      if (source[close + 1] !== "(") {
        throw new StoreValidationError(`guide.content.markdown line ${lineNumber} uses an unsupported link form.`);
      }
      const end = source.indexOf(")", close + 2);
      if (end === -1 || source.slice(close + 2, end).includes("(")) {
        throw new StoreValidationError(`guide.content.markdown line ${lineNumber} has a malformed link.`);
      }
      const label = source.slice(index + 1, close);
      const href = source.slice(close + 2, end);
      if (!label.trim() || !validateGuideHref(href)) {
        throw new StoreValidationError(`guide.content.markdown line ${lineNumber} contains an unsafe or empty link.`);
      }
      validateGuideInline(label, lineNumber);
      index = end;
      continue;
    }
    if (character === "*") {
      let run = 1;
      while (source[index + run] === "*") run++;
      if (run > 3) throw new StoreValidationError(`guide.content.markdown line ${lineNumber} has invalid emphasis.`);
      if (run === 3 && emphasis.length >= 2 && emphasis.at(-1)! + emphasis.at(-2)! === 3) {
        emphasis.pop();
        emphasis.pop();
      } else if (emphasis.at(-1) === run) {
        emphasis.pop();
      } else if (emphasis.includes(run)) {
        throw new StoreValidationError(`guide.content.markdown line ${lineNumber} crosses emphasis markers.`);
      } else {
        emphasis.push(run);
      }
      index += run - 1;
    }
  }
  if (emphasis.length > 0) {
    throw new StoreValidationError(`guide.content.markdown line ${lineNumber} has unclosed emphasis.`);
  }
}

function guideTableCells(row: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let index = 1; index < row.length; index++) {
    const character = row[index]!;
    if (character === "\\" && index + 1 < row.length) {
      cell += character + row[index + 1]!;
      index++;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  if (cell.trim()) cells.push(cell.trim());
  return cells;
}

function validateGuideTables(lines: readonly string[]): void {
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]!.trim().startsWith("|")) continue;
    const start = index;
    const rows: string[][] = [];
    while (index < lines.length && lines[index]!.trim().startsWith("|")) {
      rows.push(guideTableCells(lines[index]!.trim()));
      index++;
    }
    index--;
    const width = rows[0]?.length ?? 0;
    const separator = rows[1];
    if (rows.length < 3 || width === 0 || separator === undefined
      || separator.length !== width || !separator.every((cell) => /^:?-+:?$/.test(cell))
      || rows.some((row) => row.length !== width)
      || rows.slice(2).some((row) => !row[0])) {
      throw new StoreValidationError(`guide.content.markdown line ${start + 1} has a malformed table.`);
    }
  }
}

/**
 * Fail-closed validation for the same storage boundary consumed by the Web guide renderer.
 * It deliberately accepts only headings, paragraphs, flat lists, canonical article assets,
 * pipe tables and :::note blocks; HTML, code, quotes and unsafe links never enter a snapshot.
 */
function reviewGuideMarkdown(markdown: string): GuideMarkdownReview {
  const figures: GuideFigureReference[] = [];
  const paragraphs: string[] = [];
  let paragraph: string[] = [];
  let hasLevelTwoHeading = false;
  let inNote = false;

  const closeParagraph = () => {
    const value = plainGuideInline(paragraph.join(" "));
    if (value && !inNote) paragraphs.push(value);
    paragraph = [];
  };

  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  validateGuideTables(lines);
  for (let index = 0; index < lines.length; index++) {
    const original = lines[index]!;
    const line = original.trim();
    if (!line) {
      closeParagraph();
      continue;
    }
    if (line === ":::note") {
      closeParagraph();
      if (inNote) throw new StoreValidationError(`guide.content.markdown line ${index + 1} nests a note.`);
      inNote = true;
      continue;
    }
    if (line === ":::") {
      closeParagraph();
      if (!inNote) throw new StoreValidationError(`guide.content.markdown line ${index + 1} closes no note.`);
      inNote = false;
      continue;
    }
    if (/^(?:```|~~~|>|<|####|[*+]\s|\d{1,3}\)\s)/.test(line)
      || /^(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,}|=+\s*)$/.test(line)) {
      throw new StoreValidationError(`guide.content.markdown line ${index + 1} uses unsupported Markdown.`);
    }
    if (line.includes("![")) {
      closeParagraph();
      if (inNote) throw new StoreValidationError(`guide.content.markdown line ${index + 1} puts a photo in a note.`);
      const figure = parseGuideAssetFigureLine(line);
      if (figure === null) {
        throw new StoreValidationError("Guide photos must use the canonical niho-guide-asset UUID format on their own line.");
      }
      figures.push(figure);
      continue;
    }
    validateGuideInline(line, index + 1);

    const heading = /^(#{2,3})\s+(.+)$/.exec(line);
    if (heading) {
      closeParagraph();
      if (inNote) throw new StoreValidationError(`guide.content.markdown line ${index + 1} puts a heading in a note.`);
      if (!plainGuideInline(heading[2]!)) {
        throw new StoreValidationError(`guide.content.markdown line ${index + 1} has an empty heading.`);
      }
      if (heading[1] === "##") hasLevelTwoHeading = true;
      continue;
    }
    if (/^#{1,6}(?:\s|$)/.test(line)) {
      throw new StoreValidationError(`guide.content.markdown line ${index + 1} uses an unsupported heading level.`);
    }
    if (/^(?:-\s+|\d{1,3}\.\s+)/.test(line) || line.startsWith("|")) {
      closeParagraph();
      if (inNote && line.startsWith("|")) {
        throw new StoreValidationError(`guide.content.markdown line ${index + 1} puts a table in a note.`);
      }
      continue;
    }
    paragraph.push(line);
  }
  closeParagraph();
  if (inNote) throw new StoreValidationError("guide.content.markdown has an unclosed note.");
  if (figures.length > MAX_GUIDE_FIGURES) {
    throw new StoreValidationError(`A guide may contain at most ${MAX_GUIDE_FIGURES} figure placements.`);
  }
  return { figures, paragraphs, hasLevelTwoHeading };
}

function seoDescription(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= 160) return text;
  const prefix = text.slice(0, 159);
  const sentenceEnds = [...prefix.matchAll(/[.!?](?=\s|$)/g)];
  const sentenceEnd = sentenceEnds.at(-1)?.index;
  if (sentenceEnd !== undefined && sentenceEnd >= 80) return prefix.slice(0, sentenceEnd + 1);
  const wordEnd = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, wordEnd > 0 ? wordEnd : 159).trimEnd()}…`;
}

function publicationDescription(description: string, paragraphs: readonly string[]): string {
  if (description.trim()) return description.trim();
  let combined = "";
  for (const paragraph of paragraphs) {
    combined = combined ? `${combined} ${paragraph}` : paragraph;
    if (combined.length > 160) break;
  }
  const derived = seoDescription(combined);
  if (!derived) throw new StoreValidationError("A guide without a lead needs an opening body paragraph.");
  return derived;
}

function validateDraft(input: SaveGuideDraftInput): SaveGuideDraftInput {
  validateSlug(input.slug);
  assertDraftText(input.title, "guide.title", 110);
  if (typeof input.description !== "string" || input.description.length > 160) {
    throw new StoreValidationError("guide.description must be at most 160 characters.");
  }
  if (input.categorySlug !== undefined) validateCategorySlug(input.categorySlug);
  if (input.draftProductLinks !== undefined) validateProductLinks(input.draftProductLinks);
  const content = parseGuideContent(input.content);
  reviewGuideMarkdown(content.markdown);
  return {
    ...input,
    content,
    ...(input.cover === undefined || input.cover === null ? {} : { cover: validateCover(input.cover) }),
  };
}

function subjectFromRow(row: DbRow): GuideSubject {
  const kind = stringValue(row, "subject_kind");
  if (kind === "WRITER") return { kind };
  if (kind === "PROVIDER") return { kind, providerId: stringValue(row, "subject_provider_id") };
  throw new StoreValidationError("Database returned an invalid guide subject.");
}

function publicArticleFromRow(
  row: DbRow,
  productLinks: readonly PublicGuideProductLink[],
  cover?: PublicGuideCover,
  figures: readonly PublicGuideFigure[] = [],
): PublicGuideArticle {
  const visibility = stringValue(row, "visibility") as GuidePublicationVisibility;
  const publishedAtUtc = isoValue(row, "published_at");
  return {
    articleId: stringValue(row, "article_id"),
    publicationId: integerValue(row, "publication_id"),
    publicationNumber: integerValue(row, "publication_number"),
    sourceRevision: integerValue(row, "source_revision"),
    slug: stringValue(row, "slug"),
    subject: subjectFromRow(row),
    category: {
      slug: stringValue(row, "category_slug"),
      labelEn: stringValue(row, "category_label_en"),
      labelJa: stringValue(row, "category_label_ja"),
      displayOrder: integerValue(row, "category_display_order"),
    },
    title: stringValue(row, "title"),
    description: stringValue(row, "description"),
    content: parseGuideContent(row.content),
    visibility,
    indexable: visibility === "PUBLIC",
    productLinks,
    ...(cover === undefined ? {} : { cover }),
    figures,
    firstPublishedAtUtc: optionalIsoValue(row, "first_published_at") ?? publishedAtUtc,
    publishedAtUtc,
  };
}

function mediaAssetFromRow(row: DbRow): GuideMediaAssetRecord {
  const width = row.width === null || row.width === undefined ? undefined : integerValue(row, "width");
  const height = row.height === null || row.height === undefined ? undefined : integerValue(row, "height");
  const byteSize = row.byte_size === null || row.byte_size === undefined ? undefined : integerValue(row, "byte_size");
  const publicCredit = optionalString(row, "public_credit");
  const webConfirmedAtUtc = optionalIsoValue(row, "web_confirmed_at");
  const webConfirmedByNihoUserId = optionalString(row, "web_confirmed_by_niho_user_id");
  return {
    id: stringValue(row, "id"),
    articleId: stringValue(row, "article_id"),
    creatorNihoUserId: stringValue(row, "creator_niho_user_id"),
    uploadedByActorId: stringValue(row, "uploaded_by_actor_id"),
    objectKey: stringValue(row, "object_key"),
    state: stringValue(row, "state") as GuideMediaAssetState,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(byteSize === undefined ? {} : { byteSize }),
    ...(publicCredit === undefined ? {} : { publicCredit }),
    ...(webConfirmedAtUtc === undefined ? {} : { webConfirmedAtUtc }),
    ...(webConfirmedByNihoUserId === undefined ? {} : { webConfirmedByNihoUserId }),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function isGuideCategoryForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "code" in error && error.code === "23503"
    && "constraint" in error && error.constraint === "guide_articles_category_slug_fkey";
}

async function requireCurrentOwner(
  client: PoolClient,
  providerId: string,
  actorId: GuideActorId,
): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM provider_memberships
      WHERE provider_id=$1 AND niho_user_id=$2 AND active=true AND role='OWNER'
      FOR SHARE`,
    [providerId, actorId],
  );
  if (result.rows[0] === undefined) throw new StoreAccessDeniedError();
}

async function selectOwnedArticle(
  client: PoolClient,
  actorId: GuideActorId,
  articleId: string,
): Promise<GuideArticleRecord> {
  const result = await client.query<DbRow>(
    `SELECT ${ARTICLE_COLUMNS}
      FROM guide_articles a
       LEFT JOIN guide_publications p ON p.id=a.current_publication_id
      WHERE a.id=$1 AND a.subject_kind='PROVIDER'`,
    [articleId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new StoreAccessDeniedError();
  const article = articleFromRow(row);
  await requireCurrentOwner(client, article.subject.providerId, actorId);
  return article;
}

async function getOwnedArticleForUpdate(
  client: PoolClient,
  actorId: GuideActorId,
  articleId: string,
): Promise<GuideArticleRecord> {
  const result = await client.query<DbRow>(
    `SELECT ${ARTICLE_COLUMNS}
      FROM guide_articles a
       LEFT JOIN guide_publications p ON p.id=a.current_publication_id
      WHERE a.id=$1 AND a.subject_kind='PROVIDER'
      FOR UPDATE OF a`,
    [articleId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new StoreAccessDeniedError();
  const article = articleFromRow(row);
  await requireCurrentOwner(client, article.subject.providerId, actorId);
  return article;
}

async function authorizeCurrentProductLink(
  client: PoolClient,
  article: GuideArticleRecord,
  link: GuideProductLinkInput,
): Promise<{ readonly productSlug: string }> {
  if (link.providerId !== article.subject.providerId) {
    throw new StoreAccessDeniedError();
  }
  const result = await client.query<DbRow>(
    `SELECT slug FROM experience_products
      WHERE provider_id=$1 AND id=$2 AND status='PUBLISHED'
      FOR SHARE`,
    [link.providerId, link.productId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new StoreNotFoundError("published product for guide link");
  return { productSlug: stringValue(row, "slug") };
}

async function lockReadyAssets(
  client: PoolClient,
  article: GuideArticleRecord,
  figures: readonly GuideFigureReference[],
  lock: "SHARE" | "UPDATE",
  requirePublicationRights: boolean,
  additionalAssetIds: readonly string[] = [],
): Promise<ReadonlyMap<string, GuideMediaAssetRecord>> {
  const assets = new Map<string, GuideMediaAssetRecord>();
  const figureAssetIds = new Set(figures.map((figure) => figure.assetId.toLowerCase()));
  const assetIds = [...new Set([...figureAssetIds, ...additionalAssetIds.map((id) => id.toLowerCase())])].sort();
  for (const assetId of assetIds) {
    const result = await client.query<DbRow>(
      `SELECT ${MEDIA_ASSET_COLUMNS}
         FROM guide_media_assets
        WHERE id=$1::uuid AND article_id=$2
          AND creator_niho_user_id=(SELECT creator_niho_user_id FROM guide_articles WHERE id=$2)
          AND state='READY'
        FOR ${lock}`,
      [assetId, article.id],
    );
    const row = result.rows[0];
    if (row === undefined) throw new StoreAccessDeniedError();
    const asset = mediaAssetFromRow(row);
    if (
      requirePublicationRights
      && figureAssetIds.has(assetId)
      && (asset.publicCredit === undefined || asset.webConfirmedAtUtc === undefined)
    ) {
      throw new StoreValidationError("Every guide figure must have confirmed Web publication rights and a public credit.");
    }
    assets.set(assetId, asset);
  }
  return assets;
}

function markdownReferencesAsset(markdown: string, assetId: string): boolean {
  return markdown.toLowerCase().includes(`](niho-guide-asset:${assetId.toLowerCase()})`);
}

async function activePublicLinksByPublication(
  client: PoolClient,
  publicationIds: readonly number[],
): Promise<ReadonlyMap<number, readonly PublicGuideProductLink[]>> {
  const links = new Map<number, PublicGuideProductLink[]>();
  for (const publicationId of publicationIds) links.set(publicationId, []);
  if (publicationIds.length === 0) return links;
  const result = await client.query<DbRow>(
    `SELECT l.publication_id, l.provider_id, l.product_id, product.slug AS product_slug
       FROM guide_publication_product_links l
       JOIN experience_products product
         ON product.provider_id=l.provider_id AND product.id=l.product_id AND product.status='PUBLISHED'
      WHERE l.publication_id=ANY($1::bigint[])
        -- The public experience API exposes only a slug. If another product can
        -- resolve to that slug, the caller cannot prove which product its card
        -- represents. Hide the link until the slug identifies this exact product.
        AND NOT EXISTS (
          SELECT 1 FROM experience_products other_product
           WHERE other_product.slug=product.slug
             AND (other_product.provider_id, other_product.id)<>(l.provider_id, l.product_id)
        )
        AND l.permission_basis='PROVIDER_MEMBERSHIP'
        AND EXISTS (
          SELECT 1 FROM guide_publications publication
           WHERE publication.id=l.publication_id
             AND publication.subject_kind='PROVIDER'
             AND publication.subject_provider_id=l.provider_id
        )
        AND EXISTS (
          SELECT 1 FROM provider_memberships membership
           WHERE membership.provider_id=l.provider_id
             AND membership.niho_user_id=l.link_created_by_niho_user_id
             AND membership.active=true
             AND membership.role='OWNER'
        )
      ORDER BY l.publication_id, l.display_order NULLS LAST, l.provider_id, l.product_id`,
    [publicationIds],
  );
  for (const row of result.rows) {
    links.get(integerValue(row, "publication_id"))!.push({
      providerId: stringValue(row, "provider_id"),
      productId: stringValue(row, "product_id"),
      productSlug: stringValue(row, "product_slug"),
    });
  }
  return links;
}

type PublicGuideMedia = Readonly<{ cover?: PublicGuideCover; figures: readonly PublicGuideFigure[] }>;

async function activePublicMediaByPublication(
  client: PoolClient,
  publicationIds: readonly number[],
): Promise<ReadonlyMap<number, PublicGuideMedia>> {
  const mutable = new Map<number, { cover?: PublicGuideCover; figures: PublicGuideFigure[] }>();
  for (const publicationId of publicationIds) mutable.set(publicationId, { figures: [] });
  if (publicationIds.length === 0) return mutable;
  const result = await client.query<DbRow>(
    `SELECT media.publication_id, media.slot, media.placement,
            media.asset_id::text AS asset_id, media.alt_text, media.public_credit,
            asset.width, asset.height
       FROM guide_publication_media media
       JOIN guide_media_assets asset
         ON asset.id=media.asset_id
        AND asset.article_id=media.article_id
        AND asset.creator_niho_user_id=(
          SELECT creator_niho_user_id FROM guide_articles WHERE id=media.article_id
        )
        AND asset.state='READY'
      WHERE media.publication_id=ANY($1::bigint[])
      ORDER BY media.publication_id, media.slot`,
    [publicationIds],
  );
  for (const row of result.rows) {
    const media = mutable.get(integerValue(row, "publication_id"))!;
    const placement = stringValue(row, "placement");
    if (placement === "COVER") {
      media.cover = {
        assetId: stringValue(row, "asset_id"),
        alt: stringValue(row, "alt_text"),
        credit: stringValue(row, "public_credit"),
        width: integerValue(row, "width"),
        height: integerValue(row, "height"),
      };
    } else if (placement === "FIGURE") {
      media.figures.push({
        slot: integerValue(row, "slot"),
        assetId: stringValue(row, "asset_id"),
        alt: stringValue(row, "alt_text"),
        credit: stringValue(row, "public_credit"),
      });
    } else {
      throw new StoreValidationError("Database returned an invalid guide media placement.");
    }
  }
  return mutable;
}

export class GuideRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async listActiveCategories(): Promise<readonly GuideCategory[]> {
    const result = await this.#pool.query<DbRow>(
      `SELECT slug, label_en, label_ja, display_order
         FROM guide_categories WHERE active=true ORDER BY display_order, slug`,
    );
    return result.rows.map((row) => ({
      slug: stringValue(row, "slug"),
      labelEn: stringValue(row, "label_en"),
      labelJa: stringValue(row, "label_ja"),
      displayOrder: integerValue(row, "display_order"),
    }));
  }

  async createArticle(actorId: GuideActorId, input: CreateGuideArticleInput): Promise<GuideArticleRecord> {
    validateActorId(actorId);
    assertStoreIdentifier(input.id, "guide.id");
    validateSlug(input.slug);
    if (input.subject.kind !== "PROVIDER") throw new StoreValidationError("Guide articles must have a PROVIDER subject.");
    assertStoreIdentifier(input.subject.providerId, "guide.subject.providerId");
    assertDraftText(input.title, "guide.title", 110);
    const description = input.description ?? "";
    if (description.length > 160) throw new StoreValidationError("guide.description must be at most 160 characters.");
    if (input.categorySlug !== undefined) validateCategorySlug(input.categorySlug);
    const content = parseGuideContent(input.content ?? { markdown: "" });
    if (reviewGuideMarkdown(content.markdown).figures.length > 0) {
      throw new StoreValidationError("Create the guide before attaching article-scoped figure assets.");
    }
    try {
      return await withTransaction(this.#pool, async (client) => {
        await requireCurrentOwner(client, input.subject.providerId, actorId);
        const inserted = await client.query(
          `INSERT INTO guide_articles (
             id, slug, creator_niho_user_id, subject_kind, subject_provider_id,
             category_slug, title, description, content
           ) VALUES ($1,$2,$3,'PROVIDER',$4,$5,$6,$7,$8::jsonb)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            input.id,
            input.slug,
            actorId,
            input.subject.providerId,
            input.categorySlug ?? null,
            input.title,
            description,
            JSON.stringify(content),
          ],
        );
        if (inserted.rows[0] === undefined) throw new StoreConflictError("The guide ID or global slug is already in use.");
        return selectOwnedArticle(client, actorId, input.id);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new StoreConflictError("The guide ID or global slug is already in use.");
      if (isGuideCategoryForeignKeyViolation(error)) throw new StoreValidationError("The guide category does not exist.");
      throw error;
    }
  }

  async listArticles(actorId: GuideActorId): Promise<readonly GuideArticleRecord[]> {
    validateActorId(actorId);
    return withTransaction(this.#pool, async (client) => {
      const owners = await client.query<DbRow>(
        `SELECT provider_id FROM provider_memberships
          WHERE niho_user_id=$1 AND active=true AND role='OWNER'
          ORDER BY provider_id
          FOR SHARE`,
        [actorId],
      );
      const providerIds = owners.rows.map((row) => stringValue(row, "provider_id"));
      if (providerIds.length === 0) return [];
      const result = await client.query<DbRow>(
        `SELECT ${ARTICLE_COLUMNS}
           FROM guide_articles a
           LEFT JOIN guide_publications p ON p.id=a.current_publication_id
          WHERE a.subject_kind='PROVIDER'
            AND a.subject_provider_id=ANY($1::text[])
          ORDER BY a.updated_at DESC, a.id`,
        [providerIds],
      );
      return result.rows.map(articleFromRow);
    });
  }

  async getArticle(actorId: GuideActorId, articleId: string): Promise<GuideArticleRecord> {
    validateActorId(actorId);
    assertStoreIdentifier(articleId, "articleId");
    return withTransaction(this.#pool, (client) => selectOwnedArticle(client, actorId, articleId));
  }

  async saveDraft(
    actorId: GuideActorId,
    articleId: string,
    rawInput: SaveGuideDraftInput,
    expectedRevision: number,
  ): Promise<GuideArticleRecord> {
    validateActorId(actorId);
    assertStoreIdentifier(articleId, "articleId");
    validateRevision(expectedRevision);
    const input = validateDraft(rawInput);
    const review = reviewGuideMarkdown(input.content.markdown);
    try {
      return await withTransaction(this.#pool, async (client) => {
        const article = await getOwnedArticleForUpdate(client, actorId, articleId);
        if (article.revision !== expectedRevision) throw new StoreConflictError("Guide draft revision mismatch.");
        const cover = input.cover === undefined ? article.cover : input.cover ?? undefined;
        if (input.draftProductLinks !== undefined) {
          for (const link of input.draftProductLinks) await authorizeCurrentProductLink(client, article, link);
        }
        await lockReadyAssets(client, article, review.figures, "SHARE", false, cover === undefined ? [] : [cover.assetId]);
        if (article.slug !== input.slug) {
          const published = await client.query("SELECT 1 FROM guide_publications WHERE article_id=$1 LIMIT 1", [articleId]);
          if (published.rows[0] !== undefined) {
            throw new StoreConflictError("A guide slug cannot change after its first publication.");
          }
        }
        await client.query(
          `UPDATE guide_articles
              SET slug=$2, title=$3, description=$4, category_slug=$5, content=$6::jsonb,
                  cover_asset_id=$7::uuid, cover_alt=$8, cover_credit=$9, cover_web_confirmed=$10,
                  revision=revision+1, updated_at=clock_timestamp()
            WHERE id=$1`,
          [
            articleId,
            input.slug,
            input.title,
            input.description,
            input.categorySlug ?? null,
            JSON.stringify(input.content),
            cover?.assetId ?? null,
            cover?.alt ?? null,
            cover?.credit ?? null,
            cover?.webConfirmed ?? false,
          ],
        );
        if (input.draftProductLinks !== undefined) {
          await client.query("DELETE FROM guide_draft_product_links WHERE article_id=$1", [articleId]);
          for (const [index, link] of input.draftProductLinks.entries()) {
            await client.query(
              `INSERT INTO guide_draft_product_links (article_id, provider_id, product_id, display_order)
               VALUES ($1,$2,$3,$4)`,
              [articleId, link.providerId, link.productId, index + 1],
            );
          }
        }
        return selectOwnedArticle(client, actorId, articleId);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new StoreConflictError("The global guide slug is already in use.");
      if (isGuideCategoryForeignKeyViolation(error)) throw new StoreValidationError("The guide category does not exist.");
      throw error;
    }
  }

  async commitPublication(
    actorId: GuideActorId,
    articleId: string,
    input: CommitGuidePublicationInput,
  ): Promise<PublicGuideArticle> {
    validateActorId(actorId);
    assertStoreIdentifier(articleId, "articleId");
    validateRevision(input.expectedRevision);
    if (input.visibility !== "PUBLIC" && input.visibility !== "UNLISTED") {
      throw new StoreValidationError("guide publication visibility is invalid.");
    }
    return withTransaction(this.#pool, async (client) => {
      const article = await getOwnedArticleForUpdate(client, actorId, articleId);
      if (article.status === "OPS_STOPPED") {
        throw new StoreConflictError("An operations-stopped guide must be released before publication.");
      }
      if (article.revision !== input.expectedRevision) {
        if (
          article.status === "PUBLISHED"
          && article.currentPublication !== undefined
          && article.revision === input.expectedRevision + 1
          && article.currentPublication.visibility === input.visibility
        ) {
          const retryResult = await client.query<DbRow>(
            `SELECT ${PUBLICATION_COLUMNS}, ${FIRST_PUBLICATION_COLUMN}
               FROM guide_publications p
              WHERE p.id=$1 AND p.article_id=$2 AND p.sealed=true
                AND p.source_revision=$3 AND p.visibility=$4
                AND p.published_by_niho_user_id=$5`,
            [article.currentPublication.id, articleId, input.expectedRevision, input.visibility, actorId],
          );
          const publication = retryResult.rows[0];
          if (publication !== undefined) {
            const publicationId = integerValue(publication, "publication_id");
            const [links, media] = await Promise.all([
              activePublicLinksByPublication(client, [publicationId]),
              activePublicMediaByPublication(client, [publicationId]),
            ]);
            const publicationMedia = media.get(publicationId)!;
            return publicArticleFromRow(
              publication,
              links.get(publicationId)!,
              publicationMedia.cover,
              publicationMedia.figures,
            );
          }
        }
        throw new StoreConflictError("Guide draft revision mismatch.");
      }
      if (article.content.language !== "en") throw new StoreValidationError("Guide publication content must declare English (en).");
      if (article.content.author === undefined) throw new StoreValidationError("A public author is required before guide publication.");
      assertNonEmptyText(article.title, "guide.title", 110);
      assertPublicationUsesLatinScript(article.title, article.content.markdown);
      const review = reviewGuideMarkdown(article.content.markdown);
      if (!review.hasLevelTwoHeading) throw new StoreValidationError("Guide publication Markdown needs at least one ## heading.");
      if (/\[CONFIRM/i.test([article.title, article.description, JSON.stringify(article.content)].join("\n"))) {
        throw new StoreValidationError("Guide publication still contains a CONFIRM marker.");
      }
      if (article.categorySlug === undefined) throw new StoreValidationError("A category is required before publication.");
      const description = publicationDescription(article.description, review.paragraphs);
      validateProductLinks(article.draftProductLinks);

      if (article.cover !== undefined) {
        assertNonEmptyText(article.cover.alt, "guide.cover.alt", 300);
        assertNonEmptyText(article.cover.credit, "guide.cover.credit", 300);
        if (!article.cover.webConfirmed) {
          throw new StoreValidationError("Guide cover Web publication permission must be confirmed.");
        }
      }
      let assets: ReadonlyMap<string, GuideMediaAssetRecord>;
      try {
        assets = await lockReadyAssets(
          client,
          article,
          review.figures,
          "UPDATE",
          true,
          article.cover === undefined ? [] : [article.cover.assetId],
        );
      } catch (error) {
        if (error instanceof StoreAccessDeniedError && article.cover !== undefined) {
          throw new StoreConflictError("A selected guide photo is no longer available.");
        }
        throw error;
      }

      const categoryResult = await client.query<DbRow>(
        `SELECT slug, label_en, label_ja, display_order
           FROM guide_categories WHERE slug=$1 AND active=true FOR SHARE`,
        [article.categorySlug],
      );
      const category = categoryResult.rows[0];
      if (category === undefined) throw new StoreConflictError("The selected guide category is no longer active.");

      const links: Array<GuideProductLinkInput & { readonly productSlug: string }> = [];
      for (const link of article.draftProductLinks) {
        links.push({ ...link, ...await authorizeCurrentProductLink(client, article, link) });
      }

      const numberResult = await client.query<DbRow>(
        "SELECT coalesce(max(publication_number),0)+1 AS next_number FROM guide_publications WHERE article_id=$1",
        [articleId],
      );
      const publicationNumber = integerValue(numberResult.rows[0]!, "next_number");
      const publicationResult = await client.query<DbRow>(
        `INSERT INTO guide_publications (
           article_id, publication_number, source_revision, slug, subject_kind, subject_provider_id,
           category_slug, category_label_en, category_label_ja, category_display_order,
           title, description, content, visibility, published_by_niho_user_id
         ) VALUES ($1,$2,$3,$4,'PROVIDER',$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)
         RETURNING ${PUBLICATION_COLUMNS.replaceAll("p.", "")}`,
        [
          articleId,
          publicationNumber,
          article.revision,
          article.slug,
          article.subject.providerId,
          article.categorySlug,
          stringValue(category, "label_en"),
          stringValue(category, "label_ja"),
          integerValue(category, "display_order"),
          article.title,
          description,
          JSON.stringify(article.content),
          input.visibility,
          actorId,
        ],
      );
      const publication = publicationResult.rows[0]!;
      const publicationId = integerValue(publication, "publication_id");

      for (const [index, link] of links.entries()) {
        await client.query(
          `INSERT INTO guide_publication_product_links (
             article_id, publication_id, provider_id, product_id, display_order,
             link_created_by_niho_user_id, permission_basis
           ) VALUES ($1,$2,$3,$4,$5,$6,'PROVIDER_MEMBERSHIP')`,
          [articleId, publicationId, link.providerId, link.productId, index + 1, actorId],
        );
      }
      if (article.cover !== undefined) {
        await client.query(
          `INSERT INTO guide_publication_media (
             article_id, publication_id, slot, placement, asset_id, alt_text, public_credit
           ) VALUES ($1,$2,0,'COVER',$3::uuid,$4,$5)`,
          [articleId, publicationId, article.cover.assetId, article.cover.alt, article.cover.credit],
        );
      }
      for (const [index, figure] of review.figures.entries()) {
        const asset = assets.get(figure.assetId.toLowerCase());
        if (asset?.publicCredit === undefined) {
          throw new StoreConflictError("A guide figure is no longer available for publication.");
        }
        await client.query(
          `INSERT INTO guide_publication_media (
             article_id, publication_id, slot, placement, asset_id, alt_text, public_credit
           ) VALUES ($1,$2,$3,'FIGURE',$4::uuid,$5,$6)`,
          [articleId, publicationId, index + 1, figure.assetId, figure.alt, asset.publicCredit],
        );
      }
      await client.query("UPDATE guide_publications SET sealed=true WHERE id=$1", [publicationId]);
      const firstPublication = await client.query<DbRow>(
        "SELECT min(published_at) AS first_published_at FROM guide_publications WHERE article_id=$1 AND sealed=true",
        [articleId],
      );
      publication.first_published_at = firstPublication.rows[0]?.first_published_at;
      await client.query(
        `UPDATE guide_articles
            SET status='PUBLISHED', current_publication_id=$2,
                revision=revision+1, updated_at=clock_timestamp()
          WHERE id=$1`,
        [articleId, publicationId],
      );
      return publicArticleFromRow(
        publication,
        links.map(({ providerId, productId, productSlug }) => ({ providerId, productId, productSlug })),
        article.cover === undefined
          ? undefined
          : {
              assetId: article.cover.assetId,
              alt: article.cover.alt,
              credit: article.cover.credit,
              width: assets.get(article.cover.assetId.toLowerCase())!.width!,
              height: assets.get(article.cover.assetId.toLowerCase())!.height!,
            },
        review.figures.map((figure, index) => ({
          slot: index + 1,
          assetId: figure.assetId,
          alt: figure.alt,
          credit: assets.get(figure.assetId.toLowerCase())!.publicCredit!,
        })),
      );
    });
  }

  async stopPublication(actorId: GuideActorId, articleId: string, expectedRevision: number): Promise<GuideArticleRecord> {
    validateActorId(actorId);
    assertStoreIdentifier(articleId, "articleId");
    validateRevision(expectedRevision);
    return withTransaction(this.#pool, async (client) => {
      const article = await getOwnedArticleForUpdate(client, actorId, articleId);
      if (article.revision !== expectedRevision) throw new StoreConflictError("Guide draft revision mismatch.");
      if (article.status !== "PUBLISHED") throw new StoreConflictError("The guide has no current publication to stop.");
      await client.query(
        `UPDATE guide_articles
            SET status='STOPPED', current_publication_id=NULL,
                revision=revision+1, updated_at=clock_timestamp()
          WHERE id=$1`,
        [articleId],
      );
      return selectOwnedArticle(client, actorId, articleId);
    });
  }

  async createMediaAsset(
    actorId: GuideActorId,
    articleId: string,
    input: { readonly id: string; readonly objectKey: string },
  ): Promise<GuideMediaAssetRecord> {
    validateActorId(actorId);
    assertStoreIdentifier(articleId, "articleId");
    validateAssetId(input.id);
    assertNonEmptyText(input.objectKey, "guide media objectKey", 512);
    if (/[\u0000-\u001f\u007f]/.test(input.objectKey)) throw new StoreValidationError("guide media objectKey contains control characters.");
    return withTransaction(this.#pool, async (client) => {
      await getOwnedArticleForUpdate(client, actorId, articleId);
      const result = await client.query<DbRow>(
        `INSERT INTO guide_media_assets (
           id, article_id, creator_niho_user_id, uploaded_by_actor_id, object_key
         )
         SELECT $1::uuid, article.id, article.creator_niho_user_id, $3, $4
           FROM guide_articles article
          WHERE article.id=$2
         RETURNING ${MEDIA_ASSET_COLUMNS}`,
        [input.id, articleId, actorId, input.objectKey],
      );
      return mediaAssetFromRow(result.rows[0]!);
    });
  }

  async markMediaAssetReady(
    actorId: GuideActorId,
    articleId: string,
    assetId: string,
    input: { readonly width: number; readonly height: number; readonly byteSize: number },
  ): Promise<GuideMediaAssetRecord> {
    validateActorId(actorId);
    assertStoreIdentifier(articleId, "articleId");
    validateAssetId(assetId);
    if (
      !Number.isSafeInteger(input.width) || input.width < 1 || input.width > 2400
      || !Number.isSafeInteger(input.height) || input.height < 1 || input.height > 2400
      || !Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > 10 * 1024 * 1024
    ) throw new StoreValidationError("guide media output dimensions or size are invalid.");
    return withTransaction(this.#pool, async (client) => {
      await getOwnedArticleForUpdate(client, actorId, articleId);
      const result = await client.query<DbRow>(
        `UPDATE guide_media_assets
            SET state='READY', width=$3, height=$4, byte_size=$5, ready_at=clock_timestamp()
          WHERE id=$1::uuid AND article_id=$2
            AND creator_niho_user_id=(SELECT creator_niho_user_id FROM guide_articles WHERE id=$2)
            AND state='UPLOADING'
          RETURNING ${MEDIA_ASSET_COLUMNS}`,
        [assetId, articleId, input.width, input.height, input.byteSize],
      );
      if (result.rows[0] === undefined) throw new StoreConflictError("Guide media asset is no longer uploading.");
      return mediaAssetFromRow(result.rows[0]);
    });
  }

  async getReadyMediaAsset(actorId: GuideActorId, articleId: string, assetId: string): Promise<GuideMediaAssetRecord> {
    validateActorId(actorId);
    assertStoreIdentifier(articleId, "articleId");
    validateAssetId(assetId);
    return withTransaction(this.#pool, async (client) => {
      await selectOwnedArticle(client, actorId, articleId);
      const result = await client.query<DbRow>(
        `SELECT ${MEDIA_ASSET_COLUMNS}
           FROM guide_media_assets
          WHERE id=$1::uuid AND article_id=$2
            AND creator_niho_user_id=(SELECT creator_niho_user_id FROM guide_articles WHERE id=$2)
            AND state='READY'
          FOR SHARE`,
        [assetId, articleId],
      );
      if (result.rows[0] === undefined) throw new StoreAccessDeniedError();
      return mediaAssetFromRow(result.rows[0]);
    });
  }

  async listReadyMediaAssets(actorId: GuideActorId, articleId: string): Promise<readonly GuideMediaAssetSummary[]> {
    validateActorId(actorId);
    assertStoreIdentifier(articleId, "articleId");
    return withTransaction(this.#pool, async (client) => {
      await selectOwnedArticle(client, actorId, articleId);
      const result = await client.query<DbRow>(
        `SELECT ${MEDIA_ASSET_COLUMNS}
           FROM guide_media_assets
          WHERE article_id=$1
            AND creator_niho_user_id=(SELECT creator_niho_user_id FROM guide_articles WHERE id=$1)
            AND state='READY'
          ORDER BY created_at DESC, id
          FOR SHARE`,
        [articleId],
      );
      return result.rows.map((row) => {
        const asset = mediaAssetFromRow(row);
        if (asset.width === undefined || asset.height === undefined) {
          throw new StoreValidationError("Database returned incomplete guide media dimensions.");
        }
        return {
          id: asset.id,
          width: asset.width,
          height: asset.height,
          ...(asset.publicCredit === undefined ? {} : { publicCredit: asset.publicCredit }),
          webConfirmed: asset.webConfirmedAtUtc !== undefined,
        };
      });
    });
  }

  async confirmMediaAssetWebRights(
    actorId: GuideActorId,
    articleId: string,
    assetId: string,
    publicCredit: string,
  ): Promise<GuideMediaAssetSummary> {
    validateActorId(actorId);
    assertStoreIdentifier(articleId, "articleId");
    validateAssetId(assetId);
    assertNonEmptyText(publicCredit, "guide media publicCredit", 300);
    const normalizedCredit = publicCredit.trim();
    return withTransaction(this.#pool, async (client) => {
      await getOwnedArticleForUpdate(client, actorId, articleId);
      const currentResult = await client.query<DbRow>(
        `SELECT ${MEDIA_ASSET_COLUMNS}
           FROM guide_media_assets
          WHERE id=$1::uuid AND article_id=$2
            AND creator_niho_user_id=(SELECT creator_niho_user_id FROM guide_articles WHERE id=$2)
            AND state='READY'
          FOR UPDATE`,
        [assetId, articleId],
      );
      const row = currentResult.rows[0];
      if (row === undefined) throw new StoreAccessDeniedError();
      let asset = mediaAssetFromRow(row);
      if (asset.publicCredit !== undefined && asset.publicCredit !== normalizedCredit) {
        throw new StoreConflictError("Guide media rights were already confirmed with a different public credit.");
      }
      if (asset.publicCredit === undefined) {
        const updated = await client.query<DbRow>(
          `UPDATE guide_media_assets
              SET public_credit=$4, web_confirmed_at=clock_timestamp(), web_confirmed_by_niho_user_id=$3
            WHERE id=$1::uuid AND article_id=$2
              AND creator_niho_user_id=(SELECT creator_niho_user_id FROM guide_articles WHERE id=$2)
              AND state='READY'
            RETURNING ${MEDIA_ASSET_COLUMNS}`,
          [assetId, articleId, actorId, normalizedCredit],
        );
        asset = mediaAssetFromRow(updated.rows[0]!);
      }
      return {
        id: asset.id,
        width: asset.width!,
        height: asset.height!,
        publicCredit: asset.publicCredit!,
        webConfirmed: true,
      };
    });
  }

  async revokeMediaAsset(
    actorId: GuideActorId,
    articleId: string,
    assetId: string,
    expectedRevision?: number,
  ): Promise<GuideArticleRecord> {
    validateActorId(actorId);
    assertStoreIdentifier(articleId, "articleId");
    validateAssetId(assetId);
    if (expectedRevision !== undefined) validateRevision(expectedRevision);
    return withTransaction(this.#pool, async (client) => {
      const article = await getOwnedArticleForUpdate(client, actorId, articleId);
      if (expectedRevision !== undefined && article.revision !== expectedRevision) {
        throw new StoreConflictError("Guide draft revision mismatch.");
      }
      const currentResult = await client.query<DbRow>(
        `SELECT ${MEDIA_ASSET_COLUMNS}
           FROM guide_media_assets
          WHERE id=$1::uuid AND article_id=$2
            AND creator_niho_user_id=(SELECT creator_niho_user_id FROM guide_articles WHERE id=$2)
          FOR UPDATE`,
        [assetId, articleId],
      );
      const row = currentResult.rows[0];
      if (row === undefined) throw new StoreAccessDeniedError();
      const current = mediaAssetFromRow(row);
      if (expectedRevision === undefined && current.state !== "UPLOADING") throw new StoreAccessDeniedError();
      const newlyRevoked = current.state !== "REVOKED";
      if (newlyRevoked) {
        await client.query(
          `UPDATE guide_media_assets SET state='REVOKED', revoked_at=clock_timestamp() WHERE id=$1::uuid`,
          [assetId],
        );
      }
      const coverReferencesAsset = article.cover?.assetId.toLowerCase() === assetId.toLowerCase();
      const bodyReferencesAsset = markdownReferencesAsset(article.content.markdown, assetId);
      if (newlyRevoked && (coverReferencesAsset || bodyReferencesAsset)) {
        await client.query(
          `UPDATE guide_articles
              SET cover_asset_id=CASE WHEN cover_asset_id=$2::uuid THEN NULL ELSE cover_asset_id END,
                  cover_alt=CASE WHEN cover_asset_id=$2::uuid THEN NULL ELSE cover_alt END,
                  cover_credit=CASE WHEN cover_asset_id=$2::uuid THEN NULL ELSE cover_credit END,
                  cover_web_confirmed=CASE WHEN cover_asset_id=$2::uuid THEN false ELSE cover_web_confirmed END,
                  revision=revision+1, updated_at=clock_timestamp()
            WHERE id=$1`,
          [articleId, assetId],
        );
      }
      return selectOwnedArticle(client, actorId, articleId);
    });
  }

  async getPublicArticleBySlug(slug: string): Promise<PublicGuideArticle | null> {
    validateSlug(slug);
    return withTransaction(this.#pool, async (client) => {
      const result = await client.query<DbRow>(
        `SELECT ${PUBLICATION_COLUMNS}, ${FIRST_PUBLICATION_COLUMN}
           FROM guide_articles a
           JOIN guide_publications p ON p.id=a.current_publication_id AND p.article_id=a.id AND p.sealed=true
          WHERE a.status='PUBLISHED' AND p.slug=$1`,
        [slug],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const publicationId = integerValue(row, "publication_id");
      const [links, media] = await Promise.all([
        activePublicLinksByPublication(client, [publicationId]),
        activePublicMediaByPublication(client, [publicationId]),
      ]);
      const articleMedia = media.get(publicationId)!;
      return publicArticleFromRow(
        row,
        links.get(publicationId)!,
        articleMedia.cover,
        articleMedia.figures,
      );
    });
  }

  async listPublicArticles(): Promise<readonly PublicGuideArticle[]> {
    return withTransaction(this.#pool, async (client) => {
      const result = await client.query<DbRow>(
        `SELECT ${PUBLICATION_COLUMNS}, ${FIRST_PUBLICATION_COLUMN}
           FROM guide_articles a
           JOIN guide_publications p ON p.id=a.current_publication_id AND p.article_id=a.id AND p.sealed=true
          WHERE a.status='PUBLISHED' AND p.visibility='PUBLIC'
          ORDER BY p.published_at DESC, p.id DESC`,
      );
      const publicationIds = result.rows.map((row) => integerValue(row, "publication_id"));
      const [links, media] = await Promise.all([
        activePublicLinksByPublication(client, publicationIds),
        activePublicMediaByPublication(client, publicationIds),
      ]);
      return result.rows.map((row) => {
        const publicationId = integerValue(row, "publication_id");
        const articleMedia = media.get(publicationId)!;
        return publicArticleFromRow(
          row,
          links.get(publicationId)!,
          articleMedia.cover,
          articleMedia.figures,
        );
      });
    });
  }

  /** Server-only lookup for the JPEG relay. Old publications and revoked assets deliberately return null. */
  async getPublicMediaAsset(assetId: string): Promise<GuideMediaAssetRecord | null> {
    validateAssetId(assetId);
    const result = await this.#pool.query<DbRow>(
      `SELECT ${MEDIA_ASSET_COLUMNS}
         FROM guide_media_assets
        WHERE id=$1::uuid AND state='READY'
          AND EXISTS (
            SELECT 1
              FROM guide_articles article
              JOIN guide_publications publication
                ON publication.id=article.current_publication_id
               AND publication.article_id=article.id
               AND publication.sealed=true
              JOIN guide_publication_media media
                ON media.publication_id=publication.id
               AND media.article_id=article.id
               AND media.asset_id=guide_media_assets.id
             WHERE article.id=guide_media_assets.article_id
               AND guide_media_assets.creator_niho_user_id=article.creator_niho_user_id
               AND article.status='PUBLISHED'
          )
        LIMIT 1`,
      [assetId],
    );
    return result.rows[0] === undefined ? null : mediaAssetFromRow(result.rows[0]);
  }
}
