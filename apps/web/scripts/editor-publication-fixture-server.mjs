#!/usr/bin/env node
// A local stand-in for editor.niho.life's publish API (contract v1, #252 #253). Serves the synthetic fixture on
// 127.0.0.1 only, with the same behaviour as src/lib/editor-publication/fixtures/fake-editor-api.ts: Bearer check (401),
// a handle the credential may not read (404), query checks (400), pages with `nextCursor`, `unlisted` only with
// `include=unlisted`, ETag / If-None-Match (304), unpublished (410, with `movedTo` when moved), unknown (404), the
// `{ error: { code, requestId, retryable } }` body, and an optional forced status.
//
//   node apps/web/scripts/editor-publication-fixture-server.mjs
//   EDITOR_FIXTURE_PORT=4319 EDITOR_FIXTURE_STATUS=503 node apps/web/scripts/editor-publication-fixture-server.mjs
//   EDITOR_FIXTURE_PAGE_SIZE=4 node apps/web/scripts/editor-publication-fixture-server.mjs   # the list spans pages
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const fixture = JSON.parse(readFileSync(new URL("../src/lib/editor-publication/fixtures/editor-publications.json", import.meta.url), "utf8"));
const port = Number(process.env.EDITOR_FIXTURE_PORT ?? 4319);
// Any value here (e.g. 503) answers every request with that status: an editor outage, to watch the stale copy and its limit.
const forcedStatus = Number(process.env.EDITOR_FIXTURE_STATUS ?? 0);
// At most this many items per list page, whatever `limit` asks for.
const pageSize = Number(process.env.EDITOR_FIXTURE_PAGE_SIZE ?? 100);
const BASE = "/v1";
const BODY_FIELDS = ["markdown", "blocks", "assets", "contractVersion"];
const CURSOR = /^next\.(\d{1,6})$/;
const PREVIEW_TOKEN = /^pv_[A-Za-z0-9_-]{43}$/;
const CODES = { 400: "invalid_request", 401: "unauthenticated", 404: "not_found", 410: "gone", 429: "rate_limited", 503: "temporarily_unavailable" };
let requests = 0;

// `$case` and `$comment` are notes for the tests, never part of a response.
const served = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("$")));
const listItem = (article) => Object.fromEntries(Object.entries(served(article)).filter(([key]) => !BODY_FIELDS.includes(key)));
const byUpdate = (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const etagOf = (text) => `"${createHash("sha256").update(text).digest("base64url").slice(0, 27)}"`;
const BASE_HEADERS = { "content-type": "application/json; charset=utf-8", "x-robots-tag": "noindex", vary: "Authorization" };

function fail(response, status, extra = {}) {
  response.writeHead(status, { ...BASE_HEADERS, "cache-control": "no-store", ...(status === 401 ? { "www-authenticate": "Bearer" } : {}) });
  response.end(JSON.stringify({ error: { code: CODES[status] ?? "temporarily_unavailable", requestId: `req_fixture_${++requests}`, retryable: status === 429 || status >= 500 }, ...extra }));
  return status;
}

function send(request, response, body, { etag = true } = {}) {
  const text = JSON.stringify(body);
  const headers = { ...BASE_HEADERS, "cache-control": etag ? "private, no-cache" : "no-store" };
  if (etag) {
    headers.etag = etagOf(text);
    if (request.headers["if-none-match"] === headers.etag) {
      response.writeHead(304, headers);
      response.end();
      return 304;
    }
  }
  response.writeHead(200, headers);
  response.end(text);
  return 200;
}

function route(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") return fail(response, 400);
  if (forcedStatus) return fail(response, forcedStatus);
  if (request.headers.authorization !== `Bearer ${fixture.token}`) return fail(response, 401);
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!url.pathname.startsWith(`${BASE}/`)) return fail(response, 404);
  const rest = url.pathname.slice(BASE.length + 1);
  const query = [...url.searchParams.keys()];

  const preview = /^preview\/([^/]+)\.json$/.exec(rest);
  if (preview) {
    const token = decodeURIComponent(preview[1]);
    // Expired, unknown and malformed tokens are the same 404.
    if (!PREVIEW_TOKEN.test(token) || fixture.expiredPreviewTokens.includes(token)) return fail(response, 404);
    if (query.length) return fail(response, 400);
    const draft = fixture.previews[token];
    return draft ? send(request, response, served(draft), { etag: false }) : fail(response, 404);
  }

  const list = /^([^/]+)\/published\.json$/.exec(rest);
  if (list) {
    // A handle the credential may not read is a 404, before any query check.
    if (list[1] !== fixture.handle) return fail(response, 404);
    if (query.some((key) => !["limit", "cursor", "include"].includes(key)) || new Set(query).size !== query.length) return fail(response, 400);
    const limitText = url.searchParams.get("limit");
    const include = url.searchParams.get("include");
    const cursorText = url.searchParams.get("cursor");
    if (limitText !== null && (!/^[1-9]\d{0,2}$/.test(limitText) || Number(limitText) > 100)) return fail(response, 400);
    if (include !== null && include !== "unlisted") return fail(response, 400);
    const cursor = cursorText === null ? null : CURSOR.exec(cursorText);
    if (cursorText !== null && !cursor) return fail(response, 400);
    const listed = fixture.articles.filter((article) => include === "unlisted" || article.range !== "unlisted").sort(byUpdate);
    const start = cursor ? Number(cursor[1]) : 0;
    if (start > listed.length) return fail(response, 400);
    const end = start + Math.min(limitText === null ? 50 : Number(limitText), pageSize);
    return send(request, response, { contractVersion: "1", items: listed.slice(start, end).map(listItem), nextCursor: end < listed.length ? `next.${end}` : null });
  }

  const article = /^([^/]+)\/published\/([^/]+)\.json$/.exec(rest);
  if (article) {
    if (article[1] !== fixture.handle) return fail(response, 404);
    if (query.length) return fail(response, 400);
    const id = decodeURIComponent(article[2]);
    if (fixture.goneIds.includes(id)) return fail(response, 410, fixture.movedTo[id] ? { movedTo: fixture.movedTo[id] } : {});
    const found = fixture.articles.find((candidate) => candidate.id === id);
    return found ? send(request, response, { contractVersion: "1", ...served(found) }) : fail(response, 404);
  }
  return fail(response, 404);
}

createServer((request, response) => {
  const status = route(request, response);
  // The preview token and the query stay out of the log, like in the site.
  const shown = (request.url ?? "").replace(/\/preview\/[^/?]+\.json/, "/preview/<token>.json").replace(/\?.*$/, "");
  console.log(`${request.method} ${shown} ${status}`);
}).listen(port, "127.0.0.1", () => {
  console.log(`editor publication fixture on http://127.0.0.1:${port}${BASE} (handle ${fixture.handle}, ${pageSize} items per page at most)`);
});
