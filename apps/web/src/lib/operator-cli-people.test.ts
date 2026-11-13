import { describe, expect, it } from "vitest";
import { run } from "../../../../scripts/experience/ops/main.ts";
import { desiredListing, parsePeopleFile, resolveExperiences, type PersonRow } from "../../../../scripts/experience/ops/people.ts";
import type { Api, ApiResponse } from "../../../../scripts/experience/ops/core.ts";

/* 運営の CLI (#576) ③: the 街の人 target against an in-memory copy of /admin/api/people. No network; synthetic providers only. */

const NOW = Date.parse("2026-11-14T00:00:00.000Z");
type Listing = NonNullable<PersonRow["listing"]>;
const listing = (over: Partial<Listing> = {}): Listing => ({ id: "plg_00000000000000000000000000000001", slug: "yuki", nameJa: "雪", roleJa: "料理家", areaJa: "長谷", quoteJa: null, introJa: null, sortOrder: 10, version: 1, updatedAtUtc: "2026-11-01T00:00:00.000Z", ...over });
/** A row of the Admin list: a listed person (with `listing`, whose slug names them) or a member not listed yet (`listing: null`). */
const person = (providerId: string, over: Partial<PersonRow> = {}): PersonRow => ({ key: `new:${providerId}:hst_${providerId}`, providerId, providerName: `Name ${providerId}`, memberId: `hst_${providerId}`, memberRole: "OWNER", photoReady: true, listing: null, visible: false, ...over });

/** The products every provider has (the classification list the CLI reads to resolve slugs). */
const PRODUCTS = [
  { providerId: "prov-zen", productId: "zen-karate", slug: "zen-karate", title: "円覚寺で禅と空手を体験", status: "PUBLISHED" },
  { providerId: "prov-niho", productId: "dinner", slug: "dinner", title: "コミュニティディナー", status: "PUBLISHED" },
  { providerId: "prov-a", productId: "twin-a", slug: "twin", title: "同じ slug A", status: "PUBLISHED" },
  { providerId: "prov-b", productId: "twin-b", slug: "twin", title: "同じ slug B", status: "PUBLISHED" },
  { providerId: "prov-old", productId: "old", slug: "old", title: "保管", status: "ARCHIVED" },
];

function fakeApi(initial: PersonRow[]) {
  let rows: PersonRow[] = initial.map((item) => ({ ...item }));
  const sent: Array<{ method: string; body: Record<string, unknown>; operationId: string }> = [];
  const seen = new Set<string>();
  const hooks = { beforeSend: () => {} };
  const listingOf = (slug: string) => rows.find((row) => row.listing?.slug === slug)?.listing ?? null;
  const api: Api = {
    env: "stg", aiKind: "claude-code",
    async get(path) { return path.includes("product-classifications") ? { status: 200, body: { products: PRODUCTS } } : { status: 200, body: { people: rows } }; },
    async send(method, _path, rawBody, operationId): Promise<ApiResponse> {
      hooks.beforeSend();
      const body = rawBody as Record<string, unknown>;
      sent.push({ method, body, operationId });
      if (seen.has(operationId)) return { status: 409, body: { error: "operation_already_recorded" } };
      seen.add(operationId);
      const row = typeof body.listingId === "string" ? rows.find((candidate) => candidate.listing?.id === body.listingId) : undefined;
      const version = row?.listing?.version ?? null;
      if (method === "PUT") {
        if (body.expectedVersion !== version || (body.listingId !== null && !row)) return { status: body.listingId !== null && !row ? 404 : 409, body: { error: body.listingId !== null && !row ? "not_found" : "conflict" } };
        const next = body.listing as Record<string, unknown>;
        // The server takes the links as given and answers them with what a product is called.
        const refs = next.experiences as Array<{ providerId: string; productId: string }> | undefined;
        if (refs) next.experiences = refs.map((ref) => ({ ...ref, ...PRODUCTS.find((product) => product.providerId === ref.providerId && product.productId === ref.productId) }));
        if (rows.some((other) => other !== row && other.listing?.slug === next.slug)) return { status: 409, body: { error: "conflict" } };
        // Links and photo the request did not carry stay as they are (the store leaves them when they are left out).
        const kept = { experiences: next.experiences ?? (row?.listing as Record<string, unknown> | undefined)?.experiences, photo: next.photo ?? (row?.listing as Record<string, unknown> | undefined)?.photo };
        const memberId = (body.memberId ?? null) as string | null;
        const saved = { ...next, ...(kept.experiences === undefined ? {} : { experiences: kept.experiences }), ...(kept.photo === undefined ? {} : { photo: kept.photo }), id: row?.listing?.id ?? `plg_${String(rows.length + 1).padStart(32, "0")}`, version: (version ?? 0) + 1, updatedAtUtc: "2026-11-14T00:00:00.000Z" } as never;
        const updated: PersonRow = { ...(row ?? person(body.providerId as string)), providerId: body.providerId as string, memberId, memberRole: memberId === null ? null : "OWNER", listing: saved, visible: memberId !== null };
        rows = row ? rows.map((candidate) => (candidate === row ? updated : candidate)) : [...rows, updated];
      } else {
        if (!row) return { status: 404, body: { error: "not_found" } };
        if (body.expectedVersion !== version) return { status: 409, body: { error: "conflict" } };
        rows = rows.filter((candidate) => candidate !== row);
      }
      return { status: 200, body: { people: rows } };
    },
  };
  return { api, get rows() { return rows; }, listingOf, sent, hooks };
}

const execute = (api: Api, argv: string[], file?: string) => run(["people", ...argv], { environment: {}, api, now: () => NOW, readFile: () => file ?? "" });
type Out = { result?: { summary: Record<string, number>; items?: Array<{ key: string; status: string; error?: string; changes: Array<{ path: string; before: unknown; after: unknown }> }> }; items?: Array<{ key: string; status: string; error?: string }>; error?: string };
const body = (outcome: Awaited<ReturnType<typeof run>>) => outcome.output as Out;
const statuses = (outcome: Awaited<ReturnType<typeof run>>) => (body(outcome).result?.items ?? body(outcome).items ?? []).map((item) => item.status);

describe("parsePeopleFile and desiredListing", () => {
  it("takes providerId, an optional memberId and a listing with a slug and known keys, once per slug", () => {
    expect(parsePeopleFile('{"items":[{"providerId":"p1","listing":{"slug":"yuki"}}]}')).toHaveLength(1);
    expect(parsePeopleFile('{"items":[{"providerId":"p1","memberId":"hst_1","listing":{"slug":"yuki"}},{"providerId":"p1","memberId":null,"listing":{"slug":"kei"}}]}')).toHaveLength(2);
    for (const text of ["x", "{}", '{"items":[]}', '{"items":[{"providerId":"p1"}]}', '{"items":[{"providerId":"p1","listing":{}}]}', '{"items":[{"providerId":"p1","listing":{"price":1,"slug":"a"}}]}', '{"items":[{"providerId":"p1","memberId":"","listing":{"slug":"a"}}]}', '{"items":[{"providerId":"p1","listing":{"roleJa":"a"}}]}', '{"items":[{"providerId":"p1","listing":{"slug":"a"}},{"providerId":"p2","listing":{"slug":"a"}}]}']) {
      expect(() => parsePeopleFile(text), text).toThrow();
    }
  });
  it("needs slug, nameJa, roleJa, areaJa and sortOrder for a new listing, merges onto an existing one and normalises like the server", () => {
    expect(() => desiredListing(null, { slug: "yuki" })).toThrow(/nameJa/);
    expect(desiredListing(null, { slug: "yuki", nameJa: "雪", roleJa: "料理家", areaJa: "長谷", sortOrder: 5, introJa: "一行目\r\n\r\n\r\n\r\n二行目 " })).toEqual({ slug: "yuki", nameJa: "雪", roleJa: "料理家", areaJa: "長谷", quoteJa: null, introJa: "一行目\n\n二行目", sortOrder: 5 });
    expect(() => desiredListing(null, { slug: "yuki", nameJa: "雪", roleJa: " 料理家 ", areaJa: "長谷", sortOrder: 5 })).toThrow(/roleJa/);
    expect(desiredListing({ slug: "yuki", nameJa: "雪", roleJa: "料理家", areaJa: "長谷", quoteJa: null, introJa: null, sortOrder: 5 }, { quoteJa: "ひとこと" })).toMatchObject({ slug: "yuki", quoteJa: "ひとこと", sortOrder: 5 });
    expect(() => desiredListing(null, { slug: "Not Valid", nameJa: "a", roleJa: "a", areaJa: "b", sortOrder: 1 })).toThrow(/slug/);
    expect(() => desiredListing(null, { slug: "yuki", nameJa: "a", roleJa: "a", areaJa: "b", sortOrder: 10000 })).toThrow(/sortOrder/);
  });
});

describe("people apply", () => {
  const first = { slug: "yuki", nameJa: "雪", roleJa: "料理家", areaJa: "長谷", sortOrder: 10 };
  const add = JSON.stringify({ items: [{ providerId: "p1", memberId: "hst_p1", listing: first }] });

  it("is a publish-tier change: it prints the differences and sends nothing without --yes", async () => {
    const fake = fakeApi([person("p1")]);
    const out = await execute(fake.api, ["apply", "--file", "f.json"], add);
    expect(out.output).toMatchObject({ ok: true, tier: "publish", mode: "dry-run" });
    expect(statuses(out)).toEqual(["dry_run"]);
    expect(body(out).result!.items![0]!.changes.map((change) => change.path)).toEqual(expect.arrayContaining(["areaJa", "memberId", "nameJa", "providerId", "roleJa", "slug", "sortOrder"]));
    expect(fake.sent).toEqual([]);
  });

  it("lists a person (no id, expectedVersion null), then changes only the keys given with the id and version it read, and a repeat changes nothing", async () => {
    const fake = fakeApi([person("p1")]);
    expect(statuses(await execute(fake.api, ["apply", "--file", "f.json", "--yes"], add))).toEqual(["applied"]);
    expect(fake.sent[0]).toMatchObject({ method: "PUT", body: { listingId: null, providerId: "p1", memberId: "hst_p1", expectedVersion: null } });
    expect(fake.listingOf("yuki")).toMatchObject({ slug: "yuki", nameJa: "雪", version: 1 });
    // The member is kept when the file leaves it out.
    const edit = JSON.stringify({ items: [{ providerId: "p1", listing: { slug: "yuki", quoteJa: "朝のごはんを一緒に" } }] });
    expect(statuses(await execute(fake.api, ["apply", "--file", "f.json", "--yes"], edit))).toEqual(["applied"]);
    expect(fake.sent[1]).toMatchObject({ body: { listingId: expect.stringMatching(/^plg_/), providerId: "p1", memberId: "hst_p1", expectedVersion: 1 } });
    expect(fake.listingOf("yuki")).toMatchObject({ slug: "yuki", quoteJa: "朝のごはんを一緒に", version: 2 });
    expect(statuses(await execute(fake.api, ["apply", "--file", "f.json", "--yes"], edit))).toEqual(["unchanged"]);
    expect(fake.sent).toHaveLength(2);
  });

  it("makes a draft without a member, and attaches or moves a person to another provider and member", async () => {
    const fake = fakeApi([]);
    const draft = JSON.stringify({ items: [{ providerId: "p-proxy", listing: first }] });
    expect(statuses(await execute(fake.api, ["apply", "--file", "f.json", "--yes"], draft))).toEqual(["applied"]);
    expect(fake.sent[0]).toMatchObject({ body: { providerId: "p-proxy", memberId: null } });
    expect(fake.rows[0]).toMatchObject({ providerId: "p-proxy", memberId: null, visible: false });
    const move = JSON.stringify({ items: [{ providerId: "p-niho", memberId: "hst_takuya", listing: { slug: "yuki" } }] });
    const dry = await execute(fake.api, ["apply", "--file", "f.json"], move);
    expect(body(dry).result!.items![0]!.changes.map((change) => change.path).sort()).toEqual(["memberId", "providerId"]);
    expect(statuses(await execute(fake.api, ["apply", "--file", "f.json", "--yes"], move))).toEqual(["applied"]);
    expect(fake.sent[1]).toMatchObject({ body: { providerId: "p-niho", memberId: "hst_takuya", expectedVersion: 1 } });
    expect(fake.rows[0]).toMatchObject({ providerId: "p-niho", memberId: "hst_takuya", visible: true });
    // null detaches the member again.
    expect(statuses(await execute(fake.api, ["apply", "--file", "f.json", "--yes"], JSON.stringify({ items: [{ providerId: "p-niho", memberId: null, listing: { slug: "yuki" } }] })))).toEqual(["applied"]);
    expect(fake.rows[0]).toMatchObject({ memberId: null, visible: false });
  });

  it("refuses, and overwrites nothing, when the row changed after it was read (exit 4)", async () => {
    const fake = fakeApi([person("p1", { listing: listing(), visible: true }), person("p2")]);
    fake.hooks.beforeSend = () => { fake.rows[0] = { ...fake.rows[0]!, listing: listing({ version: 2, roleJa: "画家" }) }; };
    const edit = JSON.stringify({ items: [{ providerId: "p1", listing: { slug: "yuki", sortOrder: 3 } }] });
    const out = await execute(fake.api, ["apply", "--file", "f.json", "--yes"], edit);
    expect(out.exit).toBe(4);
    expect(fake.listingOf("yuki")).toMatchObject({ roleJa: "画家", sortOrder: 10 });
  });

  it("says which item is wrong and carries on with the others: an invalid value, a missing field", async () => {
    const fake = fakeApi([person("p1")]);
    const file = JSON.stringify({ items: [
      { providerId: "p1", listing: { slug: "no-name", roleJa: "a", areaJa: "b", sortOrder: 1 } },
      { providerId: "p1", listing: { slug: "BAD SLUG", nameJa: "a", roleJa: "a", areaJa: "b", sortOrder: 1 } },
    ] });
    const out = await execute(fake.api, ["apply", "--file", "f.json", "--yes"], file);
    expect(out.exit).toBe(1);
    expect(body(out).items).toMatchObject([{ key: "no-name", status: "failed", error: "invalid_listing" }, { key: "BAD SLUG", status: "failed", error: "invalid_listing" }]);
    expect(fake.sent).toEqual([]);
  });
});

describe("people withdraw and list", () => {
  it("takes a person off with the id and version it read, by slug", async () => {
    const fake = fakeApi([person("p1", { listing: listing({ version: 3 }), visible: true }), person("p2")]);
    expect(statuses(await execute(fake.api, ["withdraw", "--slug", "yuki"]))).toEqual(["dry_run"]);
    expect(fake.sent).toEqual([]);
    expect(statuses(await execute(fake.api, ["withdraw", "--slug", "yuki", "--yes"]))).toEqual(["applied"]);
    expect(fake.sent[0]).toMatchObject({ method: "DELETE", body: { listingId: "plg_00000000000000000000000000000001", expectedVersion: 3 } });
    expect(fake.listingOf("yuki")).toBeNull();
    expect((await execute(fake.api, ["withdraw", "--slug", "yuki", "--yes"])).exit).not.toBe(0);
    expect((await execute(fake.api, ["withdraw"])).exit).toBe(2);
  });

  it("lists, and filters listed, unlisted, one provider and one slug", async () => {
    const fake = fakeApi([person("p1", { listing: listing(), visible: true }), person("p2")]);
    const count = async (...flags: string[]) => ((await execute(fake.api, ["list", ...flags])).output as { result: { count: number } }).result.count;
    expect(await count()).toBe(2);
    expect(await count("--listed")).toBe(1);
    expect(await count("--unlisted")).toBe(1);
    expect(await count("--provider", "p2")).toBe(1);
    expect(await count("--slug", "yuki")).toBe(1);
  });

  it("says why a listed person is not shown: not a current member of their provider, or no photo (#589)", async () => {
    const fake = fakeApi([
      person("p1", { listing: listing({ id: "plg_1", slug: "a" }), visible: true }),
      person("p2", { listing: listing({ id: "plg_2", slug: "b" }), visible: false, memberId: null, memberRole: null }),
      person("p3", { listing: listing({ id: "plg_3", slug: "c" }), visible: false, memberRole: null, photoReady: false }),
      person("p4"),
    ]);
    const people = ((await execute(fake.api, ["list"])).output as { result: { people: Array<{ providerId: string; hiddenBecause?: string[] }> } }).result.people;
    const reasons = Object.fromEntries(people.map((row) => [row.providerId, row.hiddenBecause]));
    expect(reasons).toEqual({
      p1: undefined,
      p2: ["本人のアカウントが提供者のメンバー（オーナー・共同ホスト）でないため非公開"],
      p3: ["本人のアカウントが提供者のメンバー（オーナー・共同ホスト）でないため非公開", "公開してよい写真が無いため非公開"],
      p4: undefined,
    });
  });
});

describe("people apply: experiences (#585)", () => {
  const link = (experiences: unknown) => JSON.stringify({ items: [{ providerId: "p1", listing: { slug: "yuki", experiences } }] });
  const listed = () => fakeApi([person("p1", { listing: listing({ experiences: [] } as never), visible: true })]);

  it("takes a slug, or {providerId, productId}, and nothing else", () => {
    expect(parsePeopleFile(link(["zen-karate", { providerId: "prov-a", productId: "twin-a" }]))).toHaveLength(1);
    for (const bad of ["zen-karate", [""], [1], [{ providerId: "x" }], [{ providerId: "x", productId: "y", slug: "z" }], Array.from({ length: 51 }, () => "a")]) {
      expect(() => parsePeopleFile(link(bad)), JSON.stringify(bad)).toThrow();
    }
  });

  it("resolves a slug to its one product, refuses an unknown, ambiguous or archived one, and a product named twice", () => {
    expect(resolveExperiences(PRODUCTS, ["zen-karate", { providerId: "prov-b", productId: "twin-b" }])).toEqual([{ providerId: "prov-zen", productId: "zen-karate" }, { providerId: "prov-b", productId: "twin-b" }]);
    expect(() => resolveExperiences(PRODUCTS, ["twin"])).toThrow(/ambiguous|more than one/);
    expect(() => resolveExperiences(PRODUCTS, ["nope"])).toThrow(/slug nope/);
    expect(() => resolveExperiences(PRODUCTS, ["old"])).toThrow(/slug old/);
    expect(() => resolveExperiences(PRODUCTS, [{ providerId: "prov-a", productId: "nope" }])).toThrow(/prov-a\/nope/);
    expect(() => resolveExperiences(PRODUCTS, ["zen-karate", { providerId: "prov-zen", productId: "zen-karate" }])).toThrow(/twice/);
  });

  it("shows the links as a difference without --yes, sends them replaced as a whole with --yes, and a repeat changes nothing", async () => {
    const fake = listed();
    const dry = await execute(fake.api, ["apply", "--file", "f.json"], link(["zen-karate", "dinner"]));
    expect(statuses(dry)).toEqual(["dry_run"]);
    expect(body(dry).result!.items![0]!.changes.map((change) => change.path)).toEqual(["experiences"]);
    expect(fake.sent).toEqual([]);
    expect(statuses(await execute(fake.api, ["apply", "--file", "f.json", "--yes"], link(["zen-karate", "dinner"])))).toEqual(["applied"]);
    expect(fake.sent[0]).toMatchObject({ method: "PUT", body: { providerId: "p1", expectedVersion: 1, listing: { experiences: [{ providerId: "prov-zen", productId: "zen-karate" }, { providerId: "prov-niho", productId: "dinner" }] } } });
    expect(statuses(await execute(fake.api, ["apply", "--file", "f.json", "--yes"], link(["zen-karate", "dinner"])))).toEqual(["unchanged"]);
    // Replaced: only the one named is left; an empty list clears.
    expect(statuses(await execute(fake.api, ["apply", "--file", "f.json", "--yes"], link(["dinner"])))).toEqual(["applied"]);
    expect(statuses(await execute(fake.api, ["apply", "--file", "f.json", "--yes"], link([])))).toEqual(["applied"]);
  });

  it("leaves the links alone when the file does not say them", async () => {
    const fake = fakeApi([person("p1", { listing: listing({ experiences: [{ providerId: "prov-zen", productId: "zen-karate", slug: "zen-karate" }] } as never), visible: true })]);
    const out = await execute(fake.api, ["apply", "--file", "f.json", "--yes"], JSON.stringify({ items: [{ providerId: "p1", listing: { slug: "yuki", quoteJa: "ひとこと" } }] }));
    expect(statuses(out)).toEqual(["applied"]);
    // Only what the file says is sent: the untouched links are not sent again (the server would re-check each of them).
    expect(fake.sent[0]).toMatchObject({ body: { listing: { quoteJa: "ひとこと" } } });
    expect((fake.sent[0]!.body.listing as Record<string, unknown>).experiences).toBeUndefined();
    expect(fake.listingOf("yuki")!.experiences).toHaveLength(1);
  });

  it("says which item is wrong (an unknown or ambiguous slug) without sending it, and carries on with the others", async () => {
    const fake = fakeApi([person("p1", { listing: listing({ experiences: [] } as never), visible: true }), person("p2", { listing: listing({ id: "plg_2", slug: "kei", experiences: [] } as never), visible: true })]);
    const file = JSON.stringify({ items: [{ providerId: "p1", listing: { slug: "yuki", experiences: ["nope"] } }, { providerId: "p2", listing: { slug: "kei", experiences: ["twin"] } }] });
    const out = await execute(fake.api, ["apply", "--file", "f.json", "--yes"], file);
    expect(out.exit).toBe(1);
    expect(body(out).items).toMatchObject([{ key: "yuki", status: "failed", error: "unknown_experience" }, { key: "kei", status: "failed", error: "slug_is_ambiguous_use_providerId_and_productId" }]);
    expect(fake.sent).toEqual([]);
  });
});
