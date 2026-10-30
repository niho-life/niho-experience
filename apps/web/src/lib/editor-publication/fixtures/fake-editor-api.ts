import { createHash } from "node:crypto";
import fixture from "./editor-publications.json";

/**
 * Tests only: the synthetic fixture behind a `fetch`, with the statuses of the provisional contract (the same behaviour as
 * scripts/editor-publication-fixture-server.mjs). `state` can be changed between requests to publish, update or unpublish.
 */

export const EDITOR_FIXTURE = fixture;
export const FIXTURE_BASE_URL = "https://api.editor.example/v1";
export const FIXTURE_ASSET_ORIGIN = fixture.assetOrigin;

type FixtureArticle = Record<string, unknown> & { id: string };
const BODY_FIELDS = new Set(["markdown", "blocks", "assets", "related", "checkedOn"]);

const withoutComments = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$comment"));

export function fakeEditorApi() {
  const state = {
    articles: structuredClone(fixture.articles) as FixtureArticle[],
    goneIds: [...fixture.goneIds],
    previews: structuredClone(fixture.previews) as Record<string, Record<string, unknown>>,
    expiredPreviewTokens: [...fixture.expiredPreviewTokens],
    /** Answer every request with this status (an outage) while set. */
    forcedStatus: null as number | null,
  };
  const calls: { url: string; headers: Headers; init: RequestInit }[] = [];
  const reply = (status: number, body?: unknown, etag?: string) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(etag ? { etag } : {}) } });

  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    calls.push({ url, headers, init });
    if (state.forcedStatus !== null) return reply(state.forcedStatus, {});
    if (headers.get("authorization") !== `Bearer ${fixture.token}`) return reply(401, { error: "unauthorized" });
    if (!url.startsWith(`${FIXTURE_BASE_URL}/`)) return reply(404, {});
    const rest = url.slice(FIXTURE_BASE_URL.length + 1);
    const withEtag = (body: unknown) => {
      const etag = `"${createHash("sha256").update(JSON.stringify(body)).digest("base64url").slice(0, 27)}"`;
      return headers.get("if-none-match") === etag ? reply(304, undefined, etag) : reply(200, body, etag);
    };
    const preview = /^preview\/([A-Za-z0-9_-]+)\.json$/.exec(rest);
    if (preview) {
      if (state.expiredPreviewTokens.includes(preview[1]!)) return reply(410, {});
      const draft = state.previews[preview[1]!];
      return draft ? reply(200, withoutComments(draft)) : reply(404, {});
    }
    if (rest === `${fixture.handle}/published.json`) {
      return withEtag({ items: state.articles.map((article) => Object.fromEntries(Object.entries(article).filter(([key]) => !BODY_FIELDS.has(key)))) });
    }
    const article = new RegExp(`^${fixture.handle}/published/([A-Za-z0-9_-]+)\\.json$`).exec(rest);
    if (article) {
      if (state.goneIds.includes(article[1]!)) return reply(410, {});
      const found = state.articles.find((candidate) => candidate.id === article[1]);
      return found ? withEtag(found) : reply(404, {});
    }
    return reply(404, {});
  };

  return { fetch: fetchImpl, calls, state, urls: () => calls.map((call) => call.url.slice(FIXTURE_BASE_URL.length)) };
}
