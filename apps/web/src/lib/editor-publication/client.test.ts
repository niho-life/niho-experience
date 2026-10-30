import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EDITOR_FIXTURE, FIXTURE_BASE_URL, fakeEditorApi } from "./fixtures/fake-editor-api";

vi.mock("server-only", () => ({}));

const { createEditorPublicationClient, EditorPublicationError } = await import("./client");

const TOKEN = EDITOR_FIXTURE.token;
const PREVIEW_TOKEN = "synthetic-preview-token-0001";

function setup(fetchImpl?: typeof fetch) {
  const api = fakeEditorApi();
  let clock = Date.parse("2026-10-31T00:00:00Z");
  const client = createEditorPublicationClient({ baseUrl: FIXTURE_BASE_URL, handle: EDITOR_FIXTURE.handle, token: TOKEN, fetch: fetchImpl ?? api.fetch, now: () => clock });
  return { api, client, advance: (ms: number) => { clock += ms; } };
}

const errors = vi.spyOn(console, "error").mockImplementation(() => {});
beforeEach(() => {
  errors.mockClear();
});
afterAll(() => {
  errors.mockRestore();
});

const logged = () => errors.mock.calls.map((call) => call.join(" ")).join("\n");

describe("the editor publication client", () => {
  it("sends the bearer token with no Next cache, then keeps the list fresh for 30 s", async () => {
    const { api, client, advance } = setup();
    const list = await client.list();
    expect(list.items.length).toBeGreaterThan(0);
    expect(api.urls()).toEqual([`/${EDITOR_FIXTURE.handle}/published.json`]);
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
    api.state.articles = api.state.articles.filter((article) => article.id !== "ed-live-2");
    advance(30_000);
    const next = await client.list();
    expect(next).not.toBe(list);
    expect(next.items.map((item) => item.id)).not.toContain("ed-live-2");
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

  it("treats a network failure and a timeout like an outage", async () => {
    const network = setup(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(network.client.list()).rejects.toMatchObject({ kind: "unavailable", detail: "network failure" });
    const hanging: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
    const client = createEditorPublicationClient({ baseUrl: FIXTURE_BASE_URL, handle: "h", token: TOKEN, timeoutMs: 5, fetch: hanging });
    await expect(client.list()).rejects.toMatchObject({ kind: "unavailable", detail: "timed out" });
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

  it("refuses a list that is too large, not JSON, redirected or missing, without serving the cache", async () => {
    const big = setup(async () => new Response("{}", { status: 200, headers: { "content-length": String(3 * 1024 * 1024) } }));
    await expect(big.client.list()).rejects.toMatchObject({ kind: "contract" });
    const html = setup(async () => new Response("<html>", { status: 200 }));
    await expect(html.client.list()).rejects.toMatchObject({ kind: "contract" });
    const moved = setup(async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }));
    await expect(moved.client.list()).rejects.toMatchObject({ kind: "contract", detail: "unexpected status 302" });
    const shape = setup(async () => Response.json({ articles: [] }));
    await expect(shape.client.list()).rejects.toMatchObject({ kind: "contract" });
    const { api, client } = setup();
    api.state.forcedStatus = 404;
    await expect(client.list()).rejects.toMatchObject({ kind: "contract" });
  });

  it("reads a body once per updatedAt, and reports 410 and 404 as no longer published", async () => {
    const { api, client, advance } = setup();
    const first = await client.article("ed-live-1", "2026-10-30T03:00:00.000Z");
    expect(first).toMatchObject({ status: "ok", result: { ok: true, body: { related: ["evening-pottery-session", "home-cooked-dinner-with-locals"] } } });
    advance(60 * 60_000);
    expect(await client.article("ed-live-1", "2026-10-30T03:00:00.000Z")).toEqual(first);
    expect(api.calls).toHaveLength(1);
    await client.article("ed-live-1", "2026-10-31T00:00:00.000Z");
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]!.headers.get("if-none-match")).toMatch(/^".+"$/);
    expect(await client.article("ed-gone-1", "x")).toEqual({ status: "gone" });
    expect(await client.article("unknown-id", "x")).toEqual({ status: "gone" });
  });

  it("leaves out one article whose body is too large, instead of failing the list", async () => {
    const { client } = setup(async (input) => String(input).endsWith("/published.json")
      ? Response.json({ items: [] })
      : new Response("x".repeat(10), { status: 200, headers: { "content-length": String(2 * 1024 * 1024) } }));
    expect(await client.article("ed-live-1", "t")).toEqual({ status: "ok", result: { ok: false, reason: "the response is too large or not JSON" } });
  });

  it("reads previews without any cache; unknown or expired tokens are null, an outage throws", async () => {
    const { api, client } = setup();
    expect(await client.preview(PREVIEW_TOKEN)).toMatchObject({ ok: true, preview: { title: "An unfinished draft (sample)" } });
    await client.preview(PREVIEW_TOKEN);
    expect(api.calls).toHaveLength(2);
    expect(api.calls.every((call) => call.headers.get("if-none-match") === null && call.init.cache === "no-store")).toBe(true);
    expect(await client.preview("synthetic-preview-token-gone")).toBeNull();
    expect(await client.preview("synthetic-preview-token-none")).toBeNull();
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
    for (const status of [401, 500, 302]) {
      api.state.forcedStatus = status;
      failures.push(await client.preview(PREVIEW_TOKEN).catch((error: unknown) => error));
    }
    expect(failures.every((error) => error instanceof EditorPublicationError)).toBe(true);
    const text = [...failures.map(String), logged()].join("\n");
    expect(logged()).toContain("serving the copy");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(PREVIEW_TOKEN);
    expect(text).not.toContain(FIXTURE_BASE_URL);
  });
});
