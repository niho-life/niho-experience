import { describe, expect, it } from "vitest";
import { run } from "../../../../scripts/experience/ops/main.ts";
import { desiredListing, parsePeopleFile, resolveExperiences, type PersonRow } from "../../../../scripts/experience/ops/people.ts";
import type { Api, ApiResponse } from "../../../../scripts/experience/ops/core.ts";

/* 運営の CLI (#576) ③: the 街の人 target against an in-memory copy of /admin/api/people. No network; synthetic providers only. */

const NOW = Date.parse("2026-11-14T00:00:00.000Z");
type Listing = NonNullable<PersonRow["listing"]>;
const listing = (over: Partial<Listing> = {}): Listing => ({ slug: "yuki", roleJa: "料理家", areaJa: "長谷", quoteJa: null, introJa: null, sortOrder: 10, version: 1, updatedAtUtc: "2026-11-01T00:00:00.000Z", ...over });
const person = (providerId: string, over: Partial<PersonRow> = {}): PersonRow => ({ providerId, publicDisplayName: `Name ${providerId}`, photoReady: true, hasHostBio: true, publicExperienceCount: 1, listing: null, visible: false, ...over });

/** The products every provider has (the classification list the CLI reads to resolve slugs). */
const PRODUCTS = [
  { providerId: "prov-zen", productId: "zen-karate", slug: "zen-karate", title: "円覚寺で禅と空手を体験", status: "PUBLISHED" },
  { providerId: "prov-niho", productId: "dinner", slug: "dinner", title: "コミュニティディナー", status: "PUBLISHED" },
  { providerId: "prov-a", productId: "twin-a", slug: "twin", title: "同じ slug A", status: "PUBLISHED" },
  { providerId: "prov-b", productId: "twin-b", slug: "twin", title: "同じ slug B", status: "PUBLISHED" },
  { providerId: "prov-old", productId: "old", slug: "old", title: "保管", status: "ARCHIVED" },
];

function fakeApi(initial: PersonRow[]) {
  const people = new Map(initial.map((item) => [item.providerId, { ...item }]));
  const sent: Array<{ method: string; body: Record<string, unknown>; operationId: string }> = [];
  const seen = new Set<string>();
  const hooks = { beforeSend: () => {} };
  const api: Api = {
    env: "stg", aiKind: "claude-code",
    async get(path) { return path.includes("product-classifications") ? { status: 200, body: { products: PRODUCTS } } : { status: 200, body: { people: [...people.values()] } }; },
    async send(method, _path, rawBody, operationId): Promise<ApiResponse> {
      hooks.beforeSend();
      const body = rawBody as Record<string, unknown>;
      sent.push({ method, body, operationId });
      if (seen.has(operationId)) return { status: 409, body: { error: "operation_already_recorded" } };
      seen.add(operationId);
      const row = people.get(body.providerId as string);
      if (!row) return { status: 404, body: { error: "not_found" } };
      const version = row.listing?.version ?? null;
      if (method === "PUT") {
        if (body.expectedVersion !== version) return { status: 409, body: { error: "conflict" } };
        const next = body.listing as Omit<Listing, "version" | "updatedAtUtc">;
        // The server takes the links as given and answers them with what a product is called.
        const refs = (next as { experiences?: Array<{ providerId: string; productId: string }> }).experiences;
        if (refs) (next as Record<string, unknown>).experiences = refs.map((ref) => ({ ...ref, ...PRODUCTS.find((product) => product.providerId === ref.providerId && product.productId === ref.productId) }));
        if ([...people.values()].some((other) => other !== row && other.listing?.slug === next.slug)) return { status: 409, body: { error: "conflict" } };
        // Links the request did not carry stay as they are (the store leaves them when `experiences` is left out).
        const kept = (next as Record<string, unknown>).experiences ?? (row.listing as Record<string, unknown> | null)?.experiences;
        people.set(row.providerId, { ...row, listing: { ...next, ...(kept === undefined ? {} : { experiences: kept }), version: (version ?? 0) + 1, updatedAtUtc: "2026-11-14T00:00:00.000Z" } as never, visible: row.photoReady });
      } else {
        if (body.expectedVersion !== version) return { status: 409, body: { error: "conflict" } };
        people.set(row.providerId, { ...row, listing: null, visible: false });
      }
      return { status: 200, body: { people: [...people.values()] } };
    },
  };
  return { api, people, sent, hooks };
}

const execute = (api: Api, argv: string[], file?: string) => run(["people", ...argv], { environment: {}, api, now: () => NOW, readFile: () => file ?? "" });
type Out = { result?: { summary: Record<string, number>; items?: Array<{ key: string; status: string; error?: string; changes: Array<{ path: string; before: unknown; after: unknown }> }> }; items?: Array<{ key: string; status: string; error?: string }>; error?: string };
const body = (outcome: Awaited<ReturnType<typeof run>>) => outcome.output as Out;
const statuses = (outcome: Awaited<ReturnType<typeof run>>) => (body(outcome).result?.items ?? body(outcome).items ?? []).map((item) => item.status);

describe("parsePeopleFile and desiredListing", () => {
  it("takes providerId and a listing with known keys, once per provider", () => {
    expect(parsePeopleFile('{"items":[{"providerId":"p1","listing":{"slug":"yuki"}}]}')).toHaveLength(1);
    for (const text of ["x", "{}", '{"items":[]}', '{"items":[{"providerId":"p1"}]}', '{"items":[{"providerId":"p1","listing":{}}]}', '{"items":[{"providerId":"p1","listing":{"price":1}}]}', '{"items":[{"providerId":"p1","listing":{"slug":"a"}},{"providerId":"p1","listing":{"slug":"b"}}]}']) {
      expect(() => parsePeopleFile(text), text).toThrow();
    }
  });
  it("needs slug, roleJa, areaJa and sortOrder for a new listing, merges onto an existing one and normalises like the server", () => {
    expect(() => desiredListing(null, { slug: "yuki" })).toThrow(/roleJa/);
    expect(desiredListing(null, { slug: "yuki", roleJa: "料理家", areaJa: "長谷", sortOrder: 5, introJa: "一行目\r\n\r\n\r\n\r\n二行目 " })).toEqual({ slug: "yuki", roleJa: "料理家", areaJa: "長谷", quoteJa: null, introJa: "一行目\n\n二行目", sortOrder: 5 });
    expect(() => desiredListing(null, { slug: "yuki", roleJa: " 料理家 ", areaJa: "長谷", sortOrder: 5 })).toThrow(/roleJa/);
    expect(desiredListing({ slug: "yuki", roleJa: "料理家", areaJa: "長谷", quoteJa: null, introJa: null, sortOrder: 5 }, { quoteJa: "ひとこと" })).toMatchObject({ slug: "yuki", quoteJa: "ひとこと", sortOrder: 5 });
    expect(() => desiredListing(null, { slug: "Not Valid", roleJa: "a", areaJa: "b", sortOrder: 1 })).toThrow(/slug/);
    expect(() => desiredListing(null, { slug: "yuki", roleJa: "a", areaJa: "b", sortOrder: 10000 })).toThrow(/sortOrder/);
  });
});

describe("people apply", () => {
  const add = JSON.stringify({ items: [{ providerId: "p1", listing: { slug: "yuki", roleJa: "料理家", areaJa: "長谷", sortOrder: 10 } }] });

  it("is a publish-tier change: it prints the differences and sends nothing without --yes", async () => {
    const fake = fakeApi([person("p1")]);
    const out = await execute(fake.api, ["apply", "--file", "f.json"], add);
    expect(out.output).toMatchObject({ ok: true, tier: "publish", mode: "dry-run" });
    expect(statuses(out)).toEqual(["dry_run"]);
    expect(body(out).result!.items![0]!.changes.map((change) => change.path)).toEqual(["areaJa", "roleJa", "slug", "sortOrder"].sort());
    expect(fake.sent).toEqual([]);
  });

  it("lists a person with expectedVersion null, then changes only the keys given with the version it read, and a repeat changes nothing", async () => {
    const fake = fakeApi([person("p1")]);
    expect(statuses(await execute(fake.api, ["apply", "--file", "f.json", "--yes"], add))).toEqual(["applied"]);
    expect(fake.sent[0]).toMatchObject({ method: "PUT", body: { providerId: "p1", expectedVersion: null } });
    expect(fake.people.get("p1")!.listing).toMatchObject({ slug: "yuki", version: 1 });
    const edit = JSON.stringify({ items: [{ providerId: "p1", listing: { quoteJa: "朝のごはんを一緒に" } }] });
    expect(statuses(await execute(fake.api, ["apply", "--file", "f.json", "--yes"], edit))).toEqual(["applied"]);
    expect(fake.sent[1]).toMatchObject({ body: { expectedVersion: 1 } });
    expect(fake.people.get("p1")!.listing).toMatchObject({ slug: "yuki", quoteJa: "朝のごはんを一緒に", version: 2 });
    expect(statuses(await execute(fake.api, ["apply", "--file", "f.json", "--yes"], edit))).toEqual(["unchanged"]);
    expect(fake.sent).toHaveLength(2);
  });

  it("refuses, and overwrites nothing, when the row changed after it was read (exit 4) or the slug is taken", async () => {
    const fake = fakeApi([person("p1", { listing: listing(), visible: true }), person("p2")]);
    fake.hooks.beforeSend = () => { fake.people.set("p1", { ...fake.people.get("p1")!, listing: listing({ version: 2, roleJa: "画家" }) }); };
    const edit = JSON.stringify({ items: [{ providerId: "p1", listing: { sortOrder: 3 } }] });
    const out = await execute(fake.api, ["apply", "--file", "f.json", "--yes"], edit);
    expect(out.exit).toBe(4);
    expect(fake.people.get("p1")!.listing).toMatchObject({ roleJa: "画家", sortOrder: 10 });
    fake.hooks.beforeSend = () => {};
    const taken = JSON.stringify({ items: [{ providerId: "p2", listing: { slug: "yuki", roleJa: "a", areaJa: "b", sortOrder: 1 } }] });
    expect((await execute(fake.api, ["apply", "--file", "f.json", "--yes"], taken)).exit).toBe(4);
    expect(fake.people.get("p2")!.listing).toBeNull();
  });

  it("says which item is wrong and carries on with the others: no public profile, an invalid value", async () => {
    const fake = fakeApi([person("p1")]);
    const file = JSON.stringify({ items: [
      { providerId: "ghost", listing: { slug: "ghost", roleJa: "a", areaJa: "b", sortOrder: 1 } },
      { providerId: "p1", listing: { slug: "BAD SLUG", roleJa: "a", areaJa: "b", sortOrder: 1 } },
    ] });
    const out = await execute(fake.api, ["apply", "--file", "f.json", "--yes"], file);
    expect(out.exit).toBe(1);
    expect(body(out).items).toMatchObject([{ key: "ghost", status: "failed", error: "provider_has_no_public_profile" }, { key: "p1", status: "failed", error: "invalid_listing" }]);
    expect(fake.sent).toEqual([]);
  });
});

describe("people withdraw and list", () => {
  it("takes a person off with the version it read, and nothing happens for someone not listed", async () => {
    const fake = fakeApi([person("p1", { listing: listing({ version: 3 }), visible: true }), person("p2")]);
    expect(statuses(await execute(fake.api, ["withdraw", "--provider", "p1"]))).toEqual(["dry_run"]);
    expect(fake.sent).toEqual([]);
    expect(statuses(await execute(fake.api, ["withdraw", "--provider", "p1", "--yes"]))).toEqual(["applied"]);
    expect(fake.sent[0]).toMatchObject({ method: "DELETE", body: { providerId: "p1", expectedVersion: 3 } });
    expect(fake.people.get("p1")!.listing).toBeNull();
    expect(statuses(await execute(fake.api, ["withdraw", "--provider", "p2", "--yes"]))).toEqual(["unchanged"]);
    expect((await execute(fake.api, ["withdraw"])).exit).toBe(2);
  });

  it("lists, and filters listed, unlisted and one provider", async () => {
    const fake = fakeApi([person("p1", { listing: listing(), visible: true }), person("p2")]);
    const count = async (...flags: string[]) => ((await execute(fake.api, ["list", ...flags])).output as { result: { count: number } }).result.count;
    expect(await count()).toBe(2);
    expect(await count("--listed")).toBe(1);
    expect(await count("--unlisted")).toBe(1);
    expect(await count("--provider", "p2")).toBe(1);
  });

  it("says why a listed person is not shown: no OWNER account of their own, or no photo (#589)", async () => {
    const fake = fakeApi([
      person("p1", { listing: listing({ slug: "a" }), visible: true, hasOwner: true }),
      person("p2", { listing: listing({ slug: "b" }), visible: false, hasOwner: false }),
      person("p3", { listing: listing({ slug: "c" }), visible: false, hasOwner: false, photoReady: false }),
      person("p4"),
    ]);
    const people = ((await execute(fake.api, ["list"])).output as { result: { people: Array<{ providerId: string; hiddenBecause?: string[] }> } }).result.people;
    const reasons = Object.fromEntries(people.map((row) => [row.providerId, row.hiddenBecause]));
    expect(reasons).toEqual({
      p1: undefined,
      p2: ["本人のアカウントが無いため非公開"],
      p3: ["本人のアカウントが無いため非公開", "公開してよい提供者写真が無いため非公開"],
      p4: undefined,
    });
  });
});

describe("people apply: experiences (#585)", () => {
  const link = (experiences: unknown) => JSON.stringify({ items: [{ providerId: "p1", listing: { experiences } }] });
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
    const out = await execute(fake.api, ["apply", "--file", "f.json", "--yes"], JSON.stringify({ items: [{ providerId: "p1", listing: { quoteJa: "ひとこと" } }] }));
    expect(statuses(out)).toEqual(["applied"]);
    // Only what the file says is sent: the untouched links are not sent again (the server would re-check each of them).
    expect(fake.sent[0]).toMatchObject({ body: { listing: { quoteJa: "ひとこと" } } });
    expect((fake.sent[0]!.body.listing as Record<string, unknown>).experiences).toBeUndefined();
    expect(fake.people.get("p1")!.listing!.experiences).toHaveLength(1);
  });

  it("says which item is wrong (an unknown or ambiguous slug) without sending it, and carries on with the others", async () => {
    const fake = fakeApi([person("p1", { listing: listing({ experiences: [] } as never), visible: true }), person("p2", { listing: listing({ slug: "kei", experiences: [] } as never), visible: true })]);
    const file = JSON.stringify({ items: [{ providerId: "p1", listing: { experiences: ["nope"] } }, { providerId: "p2", listing: { experiences: ["twin"] } }] });
    const out = await execute(fake.api, ["apply", "--file", "f.json", "--yes"], file);
    expect(out.exit).toBe(1);
    expect(body(out).items).toMatchObject([{ key: "p1", status: "failed", error: "unknown_experience" }, { key: "p2", status: "failed", error: "slug_is_ambiguous_use_providerId_and_productId" }]);
    expect(fake.sent).toEqual([]);
  });
});
