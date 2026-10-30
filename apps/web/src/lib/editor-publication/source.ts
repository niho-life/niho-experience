import "server-only";
import type { Guide } from "@/content/guides";
import { config } from "../config";
import { sortGuides } from "../guides";
import { createEditorPublicationClient, type EditorPublicationClient } from "./client";
import { GUIDE_PREVIEW_TOKEN, type EditorArticleSummary, type EditorSkip } from "./contract";
import { editorArticleToGuide, editorPreviewToGuide, type EditorPhotoPolicy } from "./convert";

/**
 * The guides of `EXPERIENCE_GUIDE_PUBLIC_SOURCE=editor` (#252) and the drafts of `/guides/preview` (#253), read from
 * editor.niho.life's public API. Server only: the client sends `GUIDE_EDITOR_API_TOKEN`.
 */

export type EditorPublications = Readonly<{
  /** `range=live` publications as guides, newest update first: /guides, home, experience pages and the sitemap. */
  live: readonly Guide[];
  /** `range=unlisted` list entries by slug: read only for their direct URL, never listed. */
  unlisted: ReadonlyMap<string, EditorArticleSummary>;
}>;

export type GuidePreviewResult =
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ kind: "ok"; guide: Guide }>
  /** The draft cannot be shown safely; `reason` is for its writer (the token holder). */
  | Readonly<{ kind: "invalid"; reason: string }>;

/** Bodies are fetched with at most this many requests at a time. */
export const EDITOR_ARTICLE_CONCURRENCY = 6;

let client: EditorPublicationClient | null = null;
function editorClient(): EditorPublicationClient {
  client ??= createEditorPublicationClient({ baseUrl: config.guideEditorApiBaseUrl, handle: config.guideEditorApiHandle, token: config.guideEditorApiToken });
  return client;
}

const photoPolicy = (): EditorPhotoPolicy => ({ assetOrigins: config.guideEditorAssetOrigins });

/** IDs, slugs and field-name reasons only: no body, token, URL or query reaches the log. */
function logSkip(skip: EditorSkip) {
  console.error(`[guides] editor publication left out: ${JSON.stringify(skip)}`);
}

/** Conversions per list entry object: the list's entries are reused while it is unchanged, so each is converted (and logged) once. */
const converted = new WeakMap<EditorArticleSummary, Guide | null>();
const loggedSkips = new WeakSet<object>();

async function guideOf(summary: EditorArticleSummary): Promise<Guide | null> {
  if (converted.has(summary)) return converted.get(summary)!;
  const outcome = await editorClient().article(summary.id, summary.updatedAt);
  if (outcome.status === "gone") {
    // Listed but no longer served: left out until the list changes (an unpublished article leaves the list).
    converted.set(summary, null);
    logSkip({ id: summary.id, slug: summary.slug, reason: "the article is no longer published" });
    return null;
  }
  const result = outcome.result.ok ? editorArticleToGuide({ ...summary, ...outcome.result.body }, photoPolicy()) : outcome.result;
  const guide = result.ok ? result.guide : null;
  if (!result.ok) logSkip({ id: summary.id, slug: summary.slug, reason: result.reason });
  converted.set(summary, guide);
  return guide;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The current publications. The list decides what is listed (its `range` and fields); bodies only add the text. Bad
 * entries, duplicate slugs (the newest keeps it) and bodies that fail the safety checks are left out and logged. An outage
 * past the stale limit or a refused credential throws: nothing falls back to static guides.
 */
export async function readEditorPublications(): Promise<EditorPublications> {
  const list = await editorClient().list();
  if (!loggedSkips.has(list)) {
    loggedSkips.add(list);
    list.skipped.forEach(logSkip);
  }
  const bySlug = new Map<string, EditorArticleSummary>();
  for (const item of list.items) {
    if (!bySlug.has(item.slug)) bySlug.set(item.slug, item);
    else if (!converted.has(item)) {
      converted.set(item, null);
      logSkip({ id: item.id, slug: item.slug, reason: "slug is already used by a newer publication" });
    }
  }
  const entries = [...bySlug.values()];
  const live = await mapLimit(entries.filter((item) => item.range === "live"), EDITOR_ARTICLE_CONCURRENCY, guideOf);
  return {
    live: sortGuides(live.filter((guide): guide is Guide => guide !== null)),
    unlisted: new Map(entries.filter((item) => item.range === "unlisted").map((item) => [item.slug, item])),
  };
}

/** A listed or unlisted publication by slug (the body of an unlisted one is read only here), or null. */
export async function findEditorGuide(publications: EditorPublications, slug: string): Promise<Guide | null> {
  const live = publications.live.find((guide) => guide.slug === slug);
  if (live) return live;
  const unlisted = publications.unlisted.get(slug);
  return unlisted ? guideOf(unlisted) : null;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * A draft for `/guides/preview?token=…`: never cached, the same credential as the publications. Unknown or expired tokens
 * (404/410), a malformed token, another destination's draft, or any source other than the editor are "not-found"; an
 * outage or a refused credential throws (a 500, never a stale draft).
 */
export async function readGuidePreview(token: string): Promise<GuidePreviewResult> {
  if (config.guidePublicSource !== "editor" || !GUIDE_PREVIEW_TOKEN.test(token)) return { kind: "not-found" };
  const parsed = await editorClient().preview(token);
  if (parsed === null) return { kind: "not-found" };
  if (!parsed.ok) return parsed.foreign ? { kind: "not-found" } : { kind: "invalid", reason: parsed.reason };
  const result = editorPreviewToGuide(parsed.preview, photoPolicy(), today());
  return result.ok ? { kind: "ok", guide: result.guide } : { kind: "invalid", reason: result.detail };
}
