import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EDITOR_FIXTURE, FIXTURE_BASE_URL, fakeEditorApi, fixtureArticle, fixtureId } from "./fixtures/fake-editor-api";

vi.mock("server-only", () => ({}));

const { createEditorPublicationClient, EditorPublicationError, EDITOR_LIST_MAX_PAGES } = await import("./client");

const TOKEN = EDITOR_FIXTURE.token;
const PREVIEW_TOKEN = "pv_synthetic-preview-not-a-secret-draft-000001";
const FIRST_PAGE = `/${EDITOR_FIXTURE.handle}/published.json?limit=100&include=unlisted`;
const LIVE_1 = fixtureId("live-1");
const LIVE_1_UPDATED = String(fixtureArticle("live-1").updatedAt);

function setup(fetchImpl?: typeof fetch, options: { pageSize?: number; handle?: string } = {}) {
  const api = fakeEditorApi({ pageSize: options.pageSize });
  let clock = Date.parse("2026-10-31T00:00:00Z");
  const client = createEditorPublicationClient({ baseUrl: FIXTURE_BASE_URL, handle: options.handle ?? EDITOR_FIXTURE.handle, token: TOKEN, fetch: fetchImpl ?? api.fetch, now: () => clock });
  return { api, client, advance: (ms: number) => { clock += ms; } };
}

/** A list page in the contract's shape, for hand-made responses. */
const item = (n: number) => ({
  id: `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`, slug: `sample-${n}`, dest: "exp", lang: "en", title: `Sample ${n}`, lead: "A synthetic lead.",
  cover: null, category: "planning", author: { name: "Sample Writer", handle: null, url: null }, range: "live", version: 1,
  publishedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", canonicalUrl: "https://experience.example/", extras: { app: false, news: false, xp: false }, related: [],
});
const listPage = (items: unknown[], nextCursor: string | null) => Response.json({ contractVersion: "1", items, nextCursor });
const cursorOf = (input: RequestInfo | URL) => new URL(String(input)).searchParams.get("cursor");

const errors = vi.spyOn(console, "error").mockImplementation(() => {});
beforeEach(() => {
  errors.mockClear();
});
afterAll(() => {
  errors.mockRestore();
});

const logged = () => errors.mock.calls.map((call) => call.join(" ")).join("\n");

describe("the editor publication client", () => {
  it("sends the bearer token with no Next cache, asks for unlisted entries too, then keeps the list fresh for 30 s", async () => {
    const { api, client, advance } = setup();
    const list = await client.list();
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.map((entry) => entry.range)).toContain("unlisted");
    expect(api.urls()).toEqual([FIRST_PAGE]);
    const [call] = api.calls;
    expect(call!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(call!.headers.get("if-none-match")).toBeNull();
    expect(call!.init).toMatchObject({ cache: "no-store", redirect: "manual" });
    expect(call!.init.signal).toBeInstanceOf(AbortSignal);
    advance(29_000);
    expect(await client.list()).toBe(list);
    expect(api.calls).toHaveLength(1);
  });

  it("revalidates with If-None-Match after 30 s and reuses the copy on 304", async () => {
    const { api, client, advance } = setup();
    const list = await client.list();
    advance(30_000);
    expect(await client.list()).toBe(list);
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]!.headers.get("if-none-match")).toMatch(/^".+"$/);
    // A change in the editor shows on the next revalidation, without a rebuild.
    api.state.articles = api.state.articles.filter((article) => article.id !== fixtureId("live-2"));
    advance(30_000);
    const next = await client.list();
    expect(next).not.toBe(list);
    expect(next.items.map((entry) => entry.id)).not.toContain(fixtureId("live-2"));
  });

  it("follows nextCursor to the last page, each page cached by its own URL", async () => {
    const { api, client, advance } = setup(undefined, { pageSize: 4 });
    const whole = await setup().client.list();
    const list = await client.list();
    expect(list.items.map((entry) => entry.id)).toEqual(whole.items.map((entry) => entry.id));
    expect(list.skipped).toEqual(whole.skipped);
    const pages = Math.ceil(EDITOR_FIXTURE.articles.length / 4);
    expect(api.urls()).toEqual([FIRST_PAGE, ...Array.from({ length: pages - 1 }, (_, index) => `${FIRST_PAGE}&cursor=next.${(index + 1) * 4}`)]);
    // Unchanged pages: every one answers 304 and the same list object comes back (its entries are converted once).
    advance(30_000);
    expect(await client.list()).toBe(list);
    expect(api.calls.slice(pages).every((call) => call.headers.get("if-none-match") !== null)).toBe(true);
    // One changed page is a new list.
    api.state.articles.find((article) => article.id === fixtureId("live-3"))!.title = "A changed title (sample)";
    advance(30_000);
    const next = await client.list();
    expect(next).not.toBe(list);
    expect(next.items.find((entry) => entry.id === fixtureId("live-3"))?.title).toBe("A changed title (sample)");
  });

  it("drops the pages a shorter list no longer reaches, instead of keeping every cursor ever seen", async () => {
    const { api, client, advance } = setup(undefined, { pageSize: 4 });
    await client.list();
    const all = api.state.articles;
    api.state.articles = all.slice(0, 8);
    advance(30_000);
    await client.list();
    api.state.articles = all;
    advance(30_000);
    const before = api.calls.length;
    await client.list();
    const third = api.calls.slice(before).find((call) => cursorOf(call.url) === "next.8")!;
    // Read again from scratch: its old copy was let go.
    expect(third.headers.get("if-none-match")).toBeNull();
  });

  it("refuses a list whose cursor comes back, or that never ends", async () => {
    // First page → a → b → a again.
    const loop = setup(async (input) => listPage([item(1)], cursorOf(input) === "a" ? "b" : "a"));
    await expect(loop.client.list()).rejects.toMatchObject({ kind: "contract", endpoint: "list", detail: "the published list repeats a cursor" });
    // A page pointing at itself is the same loop.
    const self = setup(async () => listPage([], "b"));
    await expect(self.client.list()).rejects.toMatchObject({ kind: "contract", detail: "the published list repeats a cursor" });
    let requests = 0;
    const endless = setup(async () => listPage([], `c${++requests}`));
    await expect(endless.client.list()).rejects.toMatchObject({ kind: "contract", detail: `the published list has more than ${EDITOR_LIST_MAX_PAGES} pages` });
    expect(requests).toBe(EDITOR_LIST_MAX_PAGES);
  });

  it("keeps the first entry of an ID listed on two pages", async () => {
    const { client } = setup(async (input) => (cursorOf(input) === null ? listPage([item(1), item(2)], "p2") : listPage([{ ...item(2), title: "Again" }, item(3)], null)));
    const list = await client.list();
    expect(list.items.map((entry) => entry.title)).toEqual(["Sample 1", "Sample 2", "Sample 3"]);
    expect(list.skipped).toEqual([{ id: item(2).id, slug: "sample-2", reason: "id is listed twice (the first entry is kept)" }]);
  });

  it("serves the last copy through an outage for at most 10 minutes, backing off between attempts", async () => {
    const { api, client, advance } = setup();
    const list = await client.list();
    api.state.forcedStatus = 503;
    advance(60_000);
    expect(await client.list()).toBe(list);
    expect(api.calls).toHaveLength(2);
    advance(10_000);
    expect(await client.list()).toBe(list);
    expect(api.calls).toHaveLength(2);
    advance(30_000);
    expect(await client.list()).toBe(list);
    expect(api.calls).toHaveLength(3);
    advance(9 * 60_000);
    await expect(client.list()).rejects.toMatchObject({ kind: "unavailable", endpoint: "list" });
    api.state.forcedStatus = null;
    expect((await client.list()).items.length).toBe(list.items.length);
  });

  it("treats a network failure, a timeout and a 429 like an outage", async () => {
    const network = setup(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(network.client.list()).rejects.toMatchObject({ kind: "unavailable", detail: "network failure" });
    const hanging: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
    const client = createEditorPublicationClient({ baseUrl: FIXTURE_BASE_URL, handle: "exp", token: TOKEN, timeoutMs: 5, fetch: hanging });
    await expect(client.list()).rejects.toMatchObject({ kind: "unavailable", detail: "timed out" });
    const limited = setup();
    await limited.client.list();
    limited.api.state.forcedStatus = 429;
    limited.advance(60_000);
    expect((await limited.client.list()).items.length).toBeGreaterThan(0);
  });

  it("never hides a refused credential behind the cached copy", async () => {
    const { api, client, advance } = setup();
    await client.list();
    api.state.forcedStatus = 401;
    advance(60_000);
    await expect(client.list()).rejects.toMatchObject({ kind: "auth" });
    api.state.forcedStatus = 403;
    await expect(client.list()).rejects.toMatchObject({ kind: "auth" });
    await expect(client.preview(PREVIEW_TOKEN)).rejects.toMatchObject({ kind: "auth", endpoint: "preview" });
  });

  it("reads a 404 or 410 for the list as a credential that may not read this handle, never as an empty list", async () => {
    const other = setup(undefined, { handle: "niho" });
    await expect(other.client.list()).rejects.toMatchObject({ kind: "auth", endpoint: "list", detail: "the published list answered 404" });
    const { api, client, advance } = setup();
    await client.list();
    api.state.forcedStatus = 404;
    advance(60_000);
    await expect(client.list()).rejects.toMatchObject({ kind: "auth", detail: "the published list answered 404" });
    api.state.forcedStatus = 410;
    await expect(client.list()).rejects.toMatchObject({ kind: "auth", detail: "the published list answered 410" });
  });

  it("refuses a list that is too large, not JSON, redirected, refused as a bad request or not the contract, without serving the cache", async () => {
    const big = setup(async () => new Response("{}", { status: 200, headers: { "content-length": String(3 * 1024 * 1024) } }));
    await expect(big.client.list()).rejects.toMatchObject({ kind: "contract" });
    const html = setup(async () => new Response("<html>", { status: 200 }));
    await expect(html.client.list()).rejects.toMatchObject({ kind: "contract" });
    const moved = setup(async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }));
    await expect(moved.client.list()).rejects.toMatchObject({ kind: "contract", detail: "unexpected status 302" });
    for (const body of [{ items: [] }, { contractVersion: "2", items: [], nextCursor: null }, { contractVersion: "1", items: [], nextCursor: "a b" }]) {
      const shape = setup(async () => Response.json(body));
      await expect(shape.client.list(), JSON.stringify(body)).rejects.toMatchObject({ kind: "contract", detail: "the response does not match the contract" });
    }
    const { api, client, advance } = setup();
    await client.list();
    api.state.forcedStatus = 400;
    advance(60_000);
    await expect(client.list()).rejects.toMatchObject({ kind: "contract", detail: "unexpected status 400" });
  });

  it("reads a body once per updatedAt, and reports 410 (moved or not) and 404 as no longer published", async () => {
    const { api, client, advance } = setup();
    const first = await client.article(LIVE_1, LIVE_1_UPDATED);
    expect(first).toMatchObject({ status: "ok", result: { ok: true, body: { markdown: expect.stringContaining("## Start before sunset"), assets: [{ id: "asset-figure-1" }] } } });
    expect(api.urls()).toEqual([`/exp/published/${LIVE_1}.json`]);
    advance(60 * 60_000);
    expect(await client.article(LIVE_1, LIVE_1_UPDATED)).toEqual(first);
    expect(api.calls).toHaveLength(1);
    await client.article(LIVE_1, "2026-10-31T00:00:00.000Z");
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]!.headers.get("if-none-match")).toMatch(/^".+"$/);
    expect(await client.article(fixtureId("gone-1"), "x")).toEqual({ status: "gone" });
    expect(await client.article(fixtureId("moved-1"), "x")).toEqual({ status: "gone" });
    expect(await client.article("0e000000-0000-4000-8000-0000000000ff", "x")).toEqual({ status: "gone" });
  });

  it("revalidates a body that is still within its fresh period when the list's updatedAt moves on", async () => {
    const { api, client, advance } = setup();
    await client.article(LIVE_1, LIVE_1_UPDATED);
    const walk = api.state.articles.find((article) => article.id === LIVE_1)!;
    walk.updatedAt = "2026-10-31T00:00:10.000Z";
    walk.markdown = "## Updated\n\nNew text.";
    advance(5_000);
    const next = await client.article(LIVE_1, "2026-10-31T00:00:10.000Z");
    expect(next).toMatchObject({ status: "ok", result: { ok: true, body: { markdown: "## Updated\n\nNew text." } } });
    expect(next).not.toHaveProperty("stale");
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]!.headers.get("if-none-match")).toMatch(/^".+"$/);
  });

  it("serves an outage copy of a body as stale without keeping it as the newer version", async () => {
    const { api, client, advance } = setup();
    const first = await client.article(LIVE_1, LIVE_1_UPDATED);
    const walk = api.state.articles.find((article) => article.id === LIVE_1)!;
    walk.updatedAt = "2026-10-31T00:00:10.000Z";
    walk.markdown = "## Updated\n\nNew text.";
    api.state.forcedStatus = 503;
    advance(5_000);
    // The old body is shown for now, flagged as stale, and not recorded for the new updatedAt.
    expect(await client.article(LIVE_1, "2026-10-31T00:00:10.000Z")).toEqual({ status: "ok", result: (first as { result: unknown }).result, stale: true });
    // Within the back-off nothing is requested, and it is still not kept.
    advance(10_000);
    expect(await client.article(LIVE_1, "2026-10-31T00:00:10.000Z")).toMatchObject({ status: "ok", stale: true });
    // Once the API answers, the new body is read and only then kept: no further request.
    api.state.forcedStatus = null;
    advance(30_000);
    const recovered = await client.article(LIVE_1, "2026-10-31T00:00:10.000Z");
    expect(recovered).toMatchObject({ status: "ok", result: { ok: true, body: { markdown: "## Updated\n\nNew text." } } });
    expect(recovered).not.toHaveProperty("stale");
    const requests = api.calls.length;
    await client.article(LIVE_1, "2026-10-31T00:00:10.000Z");
    expect(api.calls).toHaveLength(requests);
  });

  it("leaves out one article whose body is too large or of another contract version, instead of failing the list", async () => {
    const { client } = setup(async (input) => String(input).includes("/published.json")
      ? listPage([], null)
      : new Response("x".repeat(10), { status: 200, headers: { "content-length": String(2 * 1024 * 1024) } }));
    expect(await client.article(LIVE_1, "t")).toEqual({ status: "ok", result: { ok: false, reason: "the response is too large or not JSON" } });
    const versioned = setup();
    versioned.api.state.articles.find((article) => article.id === LIVE_1)!.contractVersion = "2";
    expect(await versioned.client.article(LIVE_1, "t")).toEqual({ status: "ok", result: { ok: false, reason: "contractVersion is not 1" } });
  });

  it("reads previews without any cache; unknown or expired tokens are null, an outage throws", async () => {
    const { api, client } = setup();
    expect(await client.preview(PREVIEW_TOKEN)).toMatchObject({ ok: true, preview: { title: "An unfinished draft (sample)" } });
    await client.preview(PREVIEW_TOKEN);
    expect(api.calls).toHaveLength(2);
    expect(api.calls.every((call) => call.headers.get("if-none-match") === null && call.init.cache === "no-store")).toBe(true);
    expect(await client.preview(EDITOR_FIXTURE.expiredPreviewTokens[0]!)).toBeNull();
    expect(await client.preview("pv_synthetic-preview-not-a-secret-unknown-0001")).toBeNull();
    api.state.forcedStatus = 503;
    await expect(client.preview(PREVIEW_TOKEN)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("keeps the token and the preview path out of every error and log line", async () => {
    const { api, client, advance } = setup();
    await client.list();
    api.state.forcedStatus = 503;
    advance(60_000);
    await client.list();
    const failures: unknown[] = [];
    for (const status of [401, 500, 302, 400]) {
      api.state.forcedStatus = status;
      failures.push(await client.preview(PREVIEW_TOKEN).catch((error: unknown) => error));
    }
    api.state.forcedStatus = 404;
    advance(60_000);
    failures.push(await client.list().catch((error: unknown) => error));
    expect(failures.every((error) => error instanceof EditorPublicationError)).toBe(true);
    const text = [...failures.map(String), logged()].join("\n");
    expect(logged()).toContain("serving the copy");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(PREVIEW_TOKEN);
    expect(text).not.toContain(FIXTURE_BASE_URL);
    expect(text).not.toContain("include=unlisted");
  });
});
