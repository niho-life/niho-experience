#!/usr/bin/env node
// A local stand-in for editor.niho.life's public API (provisional contract, docs/guide-cms.md, #252 #253).
// Serves the synthetic fixture on 127.0.0.1 only, with the same statuses the site handles:
// Bearer check (401), ETag / If-None-Match (304), unpublished (410), unknown (404), and an optional forced status.
//
//   node apps/web/scripts/editor-publication-fixture-server.mjs
//   EDITOR_FIXTURE_PORT=4319 EDITOR_FIXTURE_STATUS=503 node apps/web/scripts/editor-publication-fixture-server.mjs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const fixture = JSON.parse(readFileSync(new URL("../src/lib/editor-publication/fixtures/editor-publications.json", import.meta.url), "utf8"));
const port = Number(process.env.EDITOR_FIXTURE_PORT ?? 4319);
// Any value here (e.g. 503) answers every request with that status: an editor outage, to watch the stale copy and its limit.
const forcedStatus = Number(process.env.EDITOR_FIXTURE_STATUS ?? 0);
const BASE = "/v1";
const BODY_FIELDS = ["markdown", "blocks", "assets", "related", "checkedOn"];

const withoutComments = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$comment"));
const listItem = (article) => Object.fromEntries(Object.entries(withoutComments(article)).filter(([key]) => !BODY_FIELDS.includes(key)));
const etagOf = (text) => `"${createHash("sha256").update(text).digest("base64url").slice(0, 27)}"`;

function send(request, response, status, body, { etag = true } = {}) {
  if (body === undefined) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: status === 401 ? "unauthorized" : status === 410 ? "gone" : "not_found" }));
    return status;
  }
  const text = JSON.stringify(body);
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  if (etag) {
    headers.etag = etagOf(text);
    if (request.headers["if-none-match"] === headers.etag) {
      response.writeHead(304, headers);
      response.end();
      return 304;
    }
  }
  response.writeHead(status, headers);
  response.end(text);
  return status;
}

function route(request, response) {
  if (request.method !== "GET") return send(request, response, 404);
  if (forcedStatus) {
    response.writeHead(forcedStatus, { "content-type": "application/json" });
    response.end("{}");
    return forcedStatus;
  }
  if (request.headers.authorization !== `Bearer ${fixture.token}`) return send(request, response, 401);
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (!path.startsWith(`${BASE}/`)) return send(request, response, 404);
  const rest = path.slice(BASE.length + 1);
  const preview = /^preview\/([A-Za-z0-9_-]+)\.json$/.exec(rest);
  if (preview) {
    const token = preview[1];
    if (fixture.expiredPreviewTokens.includes(token)) return send(request, response, 410);
    const draft = fixture.previews[token];
    return draft ? send(request, response, 200, withoutComments(draft), { etag: false }) : send(request, response, 404);
  }
  const list = /^([A-Za-z0-9_-]+)\/published\.json$/.exec(rest);
  if (list) {
    if (list[1] !== fixture.handle) return send(request, response, 404);
    return send(request, response, 200, { items: fixture.articles.map(listItem) });
  }
  const article = /^([A-Za-z0-9_-]+)\/published\/([A-Za-z0-9_-]+)\.json$/.exec(rest);
  if (article && article[1] === fixture.handle) {
    if (fixture.goneIds.includes(article[2])) return send(request, response, 410);
    const found = fixture.articles.find((candidate) => candidate.id === article[2]);
    return found ? send(request, response, 200, withoutComments(found)) : send(request, response, 404);
  }
  return send(request, response, 404);
}

createServer((request, response) => {
  const status = route(request, response);
  // The preview token stays out of the log, like in the site.
  const shown = (request.url ?? "").replace(/\/preview\/[^/]+\.json$/, "/preview/<token>.json").replace(/\?.*$/, "");
  console.log(`${request.method} ${shown} ${status}`);
}).listen(port, "127.0.0.1", () => {
  console.log(`editor publication fixture on http://127.0.0.1:${port}${BASE} (handle ${fixture.handle})`);
});
