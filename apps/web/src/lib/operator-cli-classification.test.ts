import { describe, expect, it } from "vitest";
import { run } from "../../../../scripts/experience/ops/main.ts";
import { CLASSIFICATION_CHUNK, parseChangeFile, planChanges, type Classification, type ProductRow } from "../../../../scripts/experience/ops/classification.ts";
import { OpsError, type Api, type ApiResponse } from "../../../../scripts/experience/ops/core.ts";

/* 運営の CLI (#576) ②: the classification target against an in-memory copy of the Admin API. No network; synthetic products only. */

const NOW = Date.parse("2026-11-14T00:00:00.000Z");
const EMPTY: Classification = { category: null, area: null, companions: [], occasions: [] };
const row = (providerId: string, productId: string, slug: string, classification: Classification = EMPTY): ProductRow => ({ providerId, productId, slug, title: `Title ${slug}`, status: "PUBLISHED", classification });

/** The Admin API's behaviour the CLI relies on: a list, an all-or-none save with `expected`, and a refused repeat of an operation ID. */
function fakeApi(initial: ProductRow[]) {
  const products = new Map(initial.map((item) => [`${item.providerId}/${item.productId}`, { ...item }]));
  const seen = new Set<string>();
  const puts: Array<{ operationId: string; items: number }> = [];
  const hooks = { beforePut: () => {}, failWith: null as null | { status: number; error: string } };
  const api: Api = {
    env: "stg",
    aiKind: "claude-code",
    async get() { return { status: 200, body: { products: [...products.values()] } }; },
    async send(_method, _path, body, operationId): Promise<ApiResponse> {
      hooks.beforePut();
      puts.push({ operationId, items: (body as { items: unknown[] }).items.length });
      if (seen.has(operationId)) return { status: 409, body: { error: "operation_already_recorded" } };
      seen.add(operationId);
      if (hooks.failWith) return { status: hooks.failWith.status, body: { error: hooks.failWith.error } };
      const items = (body as { items: Array<{ providerId: string; productId: string; classification: Classification; expected: Classification }> }).items;
      for (const item of items) if (JSON.stringify(products.get(`${item.providerId}/${item.productId}`)!.classification) !== JSON.stringify(item.expected)) return { status: 409, body: { error: "conflict" } };
      for (const item of items) products.set(`${item.providerId}/${item.productId}`, { ...products.get(`${item.providerId}/${item.productId}`)!, classification: item.classification });
      return { status: 200, body: { saved: items.length } };
    },
  };
  return { api, products, puts, hooks, seen };
}

const execute = (api: Api, file: string, ...flags: string[]) => run(["classification", "apply", "--file", "changes.json", ...flags], { environment: {}, api, now: () => NOW, readFile: () => file });
const items = (outcome: Awaited<ReturnType<typeof run>>) => ((outcome.output as { result?: { items: Array<{ key: string; status: string; error?: string }> }; items?: Array<{ key: string; status: string; error?: string }> }).result?.items ?? (outcome.output as { items: Array<{ key: string; status: string; error?: string }> }).items);

describe("parseChangeFile", () => {
  it("takes items that name a product by slug or by ids and give at least one classification key", () => {
    expect(parseChangeFile('{"items":[{"slug":"a","classification":{"category":"walk"}},{"providerId":"p","productId":"x","classification":{"occasions":[]}}]}')).toHaveLength(2);
  });
  it("refuses anything else, naming the item", () => {
    const bad = [
      "nope", "{}", '{"items":[]}', '{"items":[{"classification":{"category":"walk"}}]}', '{"items":[{"slug":"a","providerId":"p","productId":"x","classification":{"category":"walk"}}]}',
      '{"items":[{"slug":"a","classification":{}}]}', '{"items":[{"slug":"a","classification":{"colour":"red"}}]}', '{"items":[{"slug":"a","classification":{"category":"walk"},"price":1}]}', '{"items":[{"slug":"a"}]}', '{"items":[],"x":1}',
    ];
    for (const text of bad) expect(() => parseChangeFile(text), text).toThrow(/change file|items\[0\]/);
  });
});

describe("planChanges", () => {
  const products = [row("p1", "a", "walk-sample"), row("p1", "b", "food-sample"), row("p2", "c", "food-sample", { ...EMPTY, category: "food" })];
  it("merges the keys given onto the current value and lists what differs", () => {
    const [plan] = planChanges([{ slug: "walk-sample", classification: { category: "walk", companions: ["friends", "solo"] } }], products);
    expect(plan!.desired).toEqual({ category: "walk", area: null, companions: ["solo", "friends"], occasions: [] });
    expect(plan!.changes.map((change) => change.path)).toEqual(["category", "companions"]);
    expect(planChanges([{ providerId: "p2", productId: "c", classification: { category: "food" } }], products)[0]!.changes).toEqual([]);
  });
  it("reports an unknown product, an ambiguous slug, a product named twice and a value outside the site's lists", () => {
    const errors = planChanges([
      { slug: "nope", classification: { category: "walk" } }, { slug: "food-sample", classification: { category: "food" } },
      { slug: "walk-sample", classification: { category: "walk" } }, { providerId: "p1", productId: "a", classification: { area: "kita" } },
      { slug: "walk-sample", classification: { category: "bogus" } },
    ], products).map((plan) => plan.error);
    expect(errors).toEqual(["product_not_found", "slug_is_ambiguous_use_providerId_and_productId", undefined, "product_appears_twice", "product_appears_twice"]);
    expect(planChanges([{ slug: "walk-sample", classification: { category: "bogus" } }], products)[0]!.error).toBe("invalid_classification");
  });
});

describe("classification apply", () => {
  const file = JSON.stringify({ items: [{ slug: "walk-sample", classification: { category: "walk", area: "kita" } }, { slug: "food-sample", classification: { category: "food" } }] });
  const start = () => fakeApi([row("p1", "a", "walk-sample"), row("p1", "b", "food-sample")]);

  it("prints the differences and sends nothing without --yes", async () => {
    const fake = start();
    const out = await execute(fake.api, file);
    expect(out.exit).toBe(0);
    expect(items(out).map((item) => item.status)).toEqual(["dry_run", "dry_run"]);
    expect(fake.puts).toEqual([]);
    expect((await execute(fake.api, file, "--dry-run")).exit).toBe(0);
  });

  it("applies with --yes in one request per chunk, carrying what it read, and a second run changes nothing", async () => {
    const fake = start();
    const out = await execute(fake.api, file, "--yes");
    expect(out.exit).toBe(0);
    expect(items(out).map((item) => item.status)).toEqual(["applied", "applied"]);
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0]!.operationId).toMatch(/^op-20261114-[0-9a-f]{12}$/);
    expect(fake.products.get("p1/a")!.classification).toMatchObject({ category: "walk", area: "kita" });
    const again = await execute(fake.api, file, "--yes");
    expect(items(again).map((item) => item.status)).toEqual(["unchanged", "unchanged"]);
    expect(fake.puts).toHaveLength(1);
  });

  it("splits a big file into chunks", async () => {
    const many = Array.from({ length: CLASSIFICATION_CHUNK + 5 }, (_, i) => row("p1", `x${i}`, `slug-${i}`));
    const fake = fakeApi(many);
    const big = JSON.stringify({ items: many.map((item) => ({ slug: item.slug, classification: { category: "sea" } })) });
    const out = await execute(fake.api, big, "--yes");
    expect(out.exit).toBe(0);
    expect(fake.puts.map((put) => put.items)).toEqual([CLASSIFICATION_CHUNK, 5]);
  });

  it("stops at an item that changed meanwhile (exit 4), says what was done and what was not, and overwrites nothing", async () => {
    const many = Array.from({ length: CLASSIFICATION_CHUNK + 1 }, (_, i) => row("p1", `x${i}`, `slug-${i}`));
    const fake = fakeApi(many);
    fake.hooks.beforePut = () => { fake.products.get("p1/x3")!.classification = { ...EMPTY, category: "zen" }; };
    const big = JSON.stringify({ items: many.map((item) => ({ slug: item.slug, classification: { category: "sea" } })) });
    const out = await execute(fake.api, big, "--yes");
    expect(out.exit).toBe(4);
    const statuses = items(out).map((item) => item.status);
    expect(statuses.filter((status) => status === "failed")).toHaveLength(CLASSIFICATION_CHUNK);
    expect(statuses.filter((status) => status === "not_attempted")).toHaveLength(1);
    expect(fake.products.get("p1/x3")!.classification.category).toBe("zen");
    expect(fake.products.get("p1/x0")!.classification.category).toBeNull();
  });

  it("sends nothing when an item is wrong, and says which", async () => {
    const fake = start();
    const out = await execute(fake.api, JSON.stringify({ items: [{ slug: "walk-sample", classification: { category: "walk" } }, { slug: "missing", classification: { category: "walk" } }] }), "--yes");
    expect(out.exit).toBe(1);
    expect(items(out)).toEqual([{ key: "missing", status: "failed", error: "product_not_found" }, { key: "walk-sample", status: "not_attempted" }]);
    expect(fake.puts).toEqual([]);
  });

  it("recognises its own earlier run: the server already has the operation ID, the state is read again, and what is in place is unchanged", async () => {
    const fake = start();
    await execute(fake.api, file, "--yes");
    // Pretend the answer was lost: the products are back as they were read, but the server remembers the operation.
    fake.products.get("p1/a")!.classification = EMPTY; fake.products.get("p1/b")!.classification = EMPTY;
    const out = await execute(fake.api, file, "--yes");
    expect(out.exit).toBe(0);
    expect(items(out).map((item) => item.status)).toEqual(["applied", "applied"]);
    const ids = fake.puts.map((put) => put.operationId);
    expect(ids).toHaveLength(3);
    expect(ids[2]).toMatch(new RegExp(`^${ids[0]}-r[0-9a-f]{6}$`));
  });

  it("keeps what was applied when a later request gets no answer, and marks that chunk unconfirmed", async () => {
    const many = Array.from({ length: CLASSIFICATION_CHUNK * 2 + 1 }, (_, i) => row("p1", `x${i}`, `slug-${i}`));
    const fake = fakeApi(many);
    const original = fake.api.send;
    let calls = 0;
    (fake.api as { send: Api["send"] }).send = async (...args) => { calls += 1; if (calls === 2) throw new OpsError("unreachable", "no answer"); return original(...args); };
    const big = JSON.stringify({ items: many.map((item) => ({ slug: item.slug, classification: { category: "sea" } })) });
    const out = await execute(fake.api, big, "--yes");
    expect(out.exit).toBe(1);
    const all = items(out);
    expect(all.filter((item) => item.status === "applied")).toHaveLength(CLASSIFICATION_CHUNK);
    expect(all.filter((item) => item.error === "unreachable_result_unconfirmed")).toHaveLength(CLASSIFICATION_CHUNK);
    expect(all.filter((item) => item.status === "not_attempted")).toHaveLength(1);
  });

  it("treats a product that cannot be resolved after a re-read as a failure, not as done", async () => {
    const fake = start();
    await execute(fake.api, file, "--yes");
    fake.products.get("p1/a")!.classification = EMPTY;
    fake.products.delete("p1/b");
    const out = await execute(fake.api, file, "--yes");
    expect(out.exit).toBe(1);
    expect(items(out).some((item) => item.status === "failed")).toBe(true);
  });

  it("reports another refusal as failed with the server's code", async () => {
    const fake = start();
    fake.hooks.failWith = { status: 400, error: "invalid_input" };
    const out = await execute(fake.api, file, "--yes");
    expect(out.exit).toBe(1);
    expect(items(out).map((item) => item.error)).toEqual(["invalid_input", "invalid_input"]);
  });

  it("needs --file", async () => {
    expect((await run(["classification", "apply"], { environment: {}, api: start().api })).exit).toBe(2);
  });
});

describe("classification list and options", () => {
  it("lists, filters by slug, status and unclassified, and lists the values the site allows", async () => {
    const fake = fakeApi([row("p1", "a", "walk-sample", { ...EMPTY, category: "walk" }), { ...row("p1", "b", "food-sample"), status: "DRAFT" }]);
    const listed = async (...flags: string[]) => ((await run(["classification", "list", ...flags], { environment: {}, api: fake.api })).output as { result: { count: number } }).result.count;
    expect(await listed()).toBe(2);
    expect(await listed("--slug", "walk-sample")).toBe(1);
    expect(await listed("--status", "DRAFT")).toBe(1);
    expect(await listed("--unclassified")).toBe(1);
    const options = (await run(["classification", "options"], { environment: {}, api: fake.api })).output as { result: { category: Array<{ id: string }> } };
    expect(options.result.category.map((item) => item.id)).toContain("walk");
  });
});
