import "server-only";
import { createEditorPublicationClient } from "./client";
import { EDITOR_ARTICLE_ID, type EditorArticleSummary } from "./contract";
import { editorPhotoUrl, type EditorPhotoPolicy } from "./convert";

export const GUIDE_APP_CARD_PAGE_SIZE = 100;
export const GUIDE_APP_CARD_MAX_ITEMS = 5_000;
const CURSOR = /^v1\.([A-Za-z0-9_-]{1,480})$/;
const COVER_PATH = /^\/assets\/[0-9a-f]{64}\.(?:jpg|png|webp|avif)$/;

export type GuideAppCard = Readonly<{
  id: string;
  slug: string;
  title: string;
  lead: string | null;
  cover: Readonly<{ url: string; alt: string }> | null;
  author: Readonly<{ name: string; url: string | null }>;
  canonicalUrl: string;
  updatedAt: string;
}>;

export type GuideAppCardPage = Readonly<{ version: 1; items: readonly GuideAppCard[]; nextCursor: string | null }>;

export type GuideAppCardSource = Readonly<{
  baseUrl: string;
  handle: string;
  token: string;
  assetOrigins: readonly string[];
  siteOrigin: string;
  fetch?: typeof fetch;
}>;

type Position = Readonly<{ updatedAt: string; id: string }>;

export class GuideAppCardsError extends Error {
  constructor() {
    super("guide app cards are unavailable");
    this.name = "GuideAppCardsError";
  }
}

const compare = (a: Pick<EditorArticleSummary, "updatedAt" | "id">, b: Pick<EditorArticleSummary, "updatedAt" | "id">) =>
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id);

function encodeCursor(position: Position): string {
  return `v1.${Buffer.from(JSON.stringify(position), "utf8").toString("base64url")}`;
}

export function parseGuideAppCardCursor(value: string): Position | null {
  const match = CURSOR.exec(value);
  if (!match) return null;
  try {
    const parsed = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const fields = parsed as Record<string, unknown>;
    if (Object.keys(fields).sort().join(",") !== "id,updatedAt") return null;
    if (typeof fields.id !== "string" || !EDITOR_ARTICLE_ID.test(fields.id)) return null;
    if (typeof fields.updatedAt !== "string" || !Number.isFinite(Date.parse(fields.updatedAt))) return null;
    return { id: fields.id, updatedAt: fields.updatedAt };
  } catch {
    return null;
  }
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function project(item: EditorArticleSummary, origin: string, policy: EditorPhotoPolicy): GuideAppCard {
  const canonicalUrl = `${origin}/guides/${item.slug}`;
  if (item.canonicalUrl !== canonicalUrl) throw new GuideAppCardsError();
  const coverUrl = item.cover ? editorPhotoUrl(item.cover.url, policy) : null;
  if (item.cover && !coverUrl) throw new GuideAppCardsError();
  if (coverUrl) {
    const location = new URL(coverUrl);
    if (!COVER_PATH.test(location.pathname) || location.search || location.hash || location.username || location.password) {
      throw new GuideAppCardsError();
    }
  }
  return {
    id: item.id,
    slug: item.slug,
    title: item.title,
    lead: item.lead,
    cover: item.cover ? { url: coverUrl!, alt: item.cover.alt } : null,
    author: { name: item.author.name, url: item.author.url },
    canonicalUrl,
    updatedAt: item.updatedAt,
  };
}

export async function readGuideAppCards(source: GuideAppCardSource, cursor: string | null): Promise<GuideAppCardPage> {
  const origin = originOf(source.siteOrigin);
  const assetOrigins = source.assetOrigins.map(originOf);
  const normalizedAssetOrigins = assetOrigins.filter((value): value is string => value !== null);
  const after = cursor === null ? null : parseGuideAppCardCursor(cursor);
  if (!origin || normalizedAssetOrigins.length !== assetOrigins.length || (cursor !== null && !after)) throw new GuideAppCardsError();
  const client = createEditorPublicationClient({
    baseUrl: source.baseUrl,
    handle: source.handle,
    token: source.token,
    fetch: source.fetch,
    freshMs: 0,
    staleMs: 0,
  });
  const list = await client.list();
  if (list.skipped.length) throw new GuideAppCardsError();
  const eligible = list.items.filter((item) => item.range === "live" && item.extras.app).sort(compare);
  if (eligible.length > GUIDE_APP_CARD_MAX_ITEMS) throw new GuideAppCardsError();
  const ids = new Set<string>();
  const slugs = new Set<string>();
  for (const item of eligible) {
    if (ids.has(item.id) || slugs.has(item.slug)) throw new GuideAppCardsError();
    ids.add(item.id);
    slugs.add(item.slug);
  }
  const start = after === null ? 0 : eligible.findIndex((item) => item.id === after.id && item.updatedAt === after.updatedAt) + 1;
  if (after !== null && start === 0) throw new GuideAppCardsError();
  const selected = eligible.slice(start, start + GUIDE_APP_CARD_PAGE_SIZE);
  const hasMore = start + selected.length < eligible.length;
  const last = selected.at(-1);
  return {
    version: 1,
    items: selected.map((item) => project(item, origin, { assetOrigins: normalizedAssetOrigins })),
    nextCursor: hasMore && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
  };
}
