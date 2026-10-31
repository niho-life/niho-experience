import { createHash } from "node:crypto";
import fixture from "./editor-publications.json";

/**
 * Tests only: the synthetic fixture behind a `fetch`, with the behaviour of contract v1 (the same as
 * scripts/editor-publication-fixture-server.mjs): Bearer check (401), a handle the credential may not read (404), query
 * checks (400), pages of `limit` items with `nextCursor`, `unlisted` only with `include=unlisted`, ETag / If-None-Match
 * (304), unpublished bodies (410, with `movedTo` when moved to another face) and the `{ error: { code, requestId,
 * retryable } }` body. `state` can be changed between requests to publish, update or unpublish.
 */

export const EDITOR_FIXTURE = fixture;
export const FIXTURE_BASE_URL = "https://api.editor.example/v1";
export const FIXTURE_ASSET_ORIGIN = fixture.assetOrigin;

type FixtureArticle = Record<string, unknown> & { id: string };

/** The fixture article (a full PublishedDoc) named by its `$case`. */
export function fixtureArticle(name: string): FixtureArticle {
  const found = fixture.articles.find((article) => article.$case === name);
  if (!found) throw new Error(`no fixture article ${name}`);
  return found as unknown as FixtureArticle;
}

export const fixtureId = (name: string) => fixtureArticle(name).id;

const BODY_FIELDS = new Set(["markdown", "blocks", "assets", "contractVersion"]);
const CURSOR = /^next\.(\d{1,6})$/;
const PREVIEW_TOKEN = /^pv_[A-Za-z0-9_-]{43}$/;
const CODES: Record<number, string> = { 400: "invalid_request", 401: "unauthenticated", 404: "not_found", 410: "gone", 429: "rate_limited", 503: "temporarily_unavailable" };

/** `$case` and `$comment` are notes for the tests, never part of a response. */
const served = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("$")));

/** Newest update first, then ID: the order the editor lists in. */
const byUpdate = (a: FixtureArticle, b: FixtureArticle) => Date.parse(String(b.updatedAt)) - Date.parse(String(a.updatedAt)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function fakeEditorApi(options: Readonly<{ pageSize?: number }> = {}) {
  const state = {
    articles: structuredClone(fixture.articles) as unknown as FixtureArticle[],
    goneIds: [...fixture.goneIds],
    movedTo: structuredClone(fixture.movedTo) as Record<string, unknown>,
    previews: structuredClone(fixture.previews) as Record<string, Record<string, unknown>>,
    expiredPreviewTokens: [...fixture.expiredPreviewTokens],
    /** At most this many items per list page, whatever `limit` asks for: a small value makes the list span pages. */
    pageSize: options.pageSize ?? 100,
    /** Answer every request with this status (an outage) while set. */
    forcedStatus: null as number | null,
  };
  const calls: { url: string; headers: Headers; init: RequestInit }[] = [];
  let requests = 0;
  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "x-robots-tag": "noindex", ...headers } });
  const failure = (status: number, extra: Record<string, unknown> = {}) =>
    reply(status, { error: { code: CODES[status] ?? "temporarily_unavailable", requestId: `req_fixture_${++requests}`, retryable: status === 429 || status >= 500 }, ...extra }, {
      "cache-control": "no-store",
      ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
    });

  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    calls.push({ url, headers, init });
    if (state.forcedStatus !== null) return failure(state.forcedStatus);
    if (headers.get("authorization") !== `Bearer ${fixture.token}`) return failure(401);
    if (!url.startsWith(`${FIXTURE_BASE_URL}/`)) return failure(404);
    const { pathname, searchParams } = new URL(url);
    const rest = pathname.slice(new URL(FIXTURE_BASE_URL).pathname.length + 1);
    const query = [...searchParams.keys()];
    const withEtag = (body: unknown) => {
      const etag = `"${createHash("sha256").update(JSON.stringify(body)).digest("base64url").slice(0, 27)}"`;
      return headers.get("if-none-match") === etag ? reply(304, undefined, { etag }) : reply(200, body, { etag, "cache-control": "private, no-cache" });
    };

    const preview = /^preview\/([^/]+)\.json$/.exec(rest);
    if (preview) {
      const token = decodeURIComponent(preview[1]!);
      // Expired, unknown and malformed tokens are the same 404.
      if (!PREVIEW_TOKEN.test(token) || state.expiredPreviewTokens.includes(token)) return failure(404);
      if (query.length) return failure(400);
      const draft = state.previews[token];
      return draft ? reply(200, served(draft), { "cache-control": "no-store" }) : failure(404);
    }

    const list = /^([^/]+)\/published\.json$/.exec(rest);
    if (list) {
      // A handle the credential may not read is a 404, before any query check.
      if (list[1] !== fixture.handle) return failure(404);
      if (query.some((key) => !["limit", "cursor", "include"].includes(key)) || new Set(query).size !== query.length) return failure(400);
      const limitText = searchParams.get("limit");
      const include = searchParams.get("include");
      const cursorText = searchParams.get("cursor");
      if (limitText !== null && (!/^[1-9]\d{0,2}$/.test(limitText) || Number(limitText) > 100)) return failure(400);
      if (include !== null && include !== "unlisted") return failure(400);
      const cursor = cursorText === null ? null : CURSOR.exec(cursorText);
      if (cursorText !== null && !cursor) return failure(400);
      const listed = state.articles.filter((article) => include === "unlisted" || article.range !== "unlisted").sort(byUpdate);
      const start = cursor ? Number(cursor[1]) : 0;
      if (start > listed.length) return failure(400);
      const size = Math.min(limitText === null ? 50 : Number(limitText), state.pageSize);
      const end = start + size;
      return withEtag({
        contractVersion: "1",
        items: listed.slice(start, end).map((article) => Object.fromEntries(Object.entries(served(article)).filter(([key]) => !BODY_FIELDS.has(key)))),
        nextCursor: end < listed.length ? `next.${end}` : null,
      });
    }

    const article = /^([^/]+)\/published\/([^/]+)\.json$/.exec(rest);
    if (article) {
      if (article[1] !== fixture.handle) return failure(404);
      if (query.length) return failure(400);
      const id = decodeURIComponent(article[2]!);
      if (state.goneIds.includes(id)) return failure(410, state.movedTo[id] ? { movedTo: state.movedTo[id] } : {});
      const found = state.articles.find((candidate) => candidate.id === id);
      return found ? withEtag({ contractVersion: "1", ...served(found) }) : failure(404);
    }
    return failure(404);
  };

  return { fetch: fetchImpl, calls, state, urls: () => calls.map((call) => call.url.slice(FIXTURE_BASE_URL.length)) };
}
