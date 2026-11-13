import { describe, expect, it } from "vitest";
import { run } from "../../../../scripts/experience/ops/main.ts";
import type { ProductDto } from "../../../../scripts/experience/ops/product.ts";
import type { Api, ApiResponse } from "../../../../scripts/experience/ops/core.ts";

/* 運営の CLI (#576) ④: the product and provider targets against an in-memory copy of /admin/api/product-workspaces. No network. */

const NOW = Date.parse("2026-11-14T00:00:00.000Z");
const ROOT = "/admin/api/product-workspaces";
const CONSENT = "consent-v1";
// Fake-API JSON has no fixed shape in these tests, so `any` is allowed for this one alias.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

const content = { japaneseOnly: true, ja: { title: "合成の体験", lead: "紹介" } };

function fakeApi(blockers: string[] = []) {
  let draftVersion = 1;
  let termsVersion = 0;
  let stateVersion = 0;
  let suspended = false;
  const providers = [{ providerId: "prv_1", publicDisplayName: "Sample", providerKind: "PERSON", profileVersion: 1 }];
  let product: (ProductDto & { terms: Record<string, unknown> | null }) | null = null;
  const sent: Array<{ method: string; path: string; body: Record<string, unknown>; operationId: string }> = [];
  const seen = new Set<string>();
  const sentRules = new Set<string>();
  const hooks = { beforeSend: () => {}, rejectNext: null as null | ApiResponse };
  const rev = () => Buffer.from(`1:${draftVersion}:${stateVersion}:${termsVersion}`).toString("base64url");
  const dto = (): ProductDto => ({ id: "x1", version: rev(), publicationBlockers: blockers, draft: product!.draft, saleTerms: product!.terms, offers: [], media: product!.media ?? [], acceptanceMode: "INSTANT" });
  const api: Api = {
    env: "stg", aiKind: "claude-code",
    async get(path) {
      if (path === ROOT) return { status: 200, body: { providers, sellers: [] } };
      if (path === `${ROOT}/prv_1/products`) return { status: 200, body: { products: product ? [dto()] : [], publicationConsentVersion: CONSENT } };
      if (path === `${ROOT}/prv_1/products/x1` && product) return { status: 200, body: { product: dto() } };
      if (path.startsWith(`${ROOT}/prv_1/products/x1/calendar?`)) return { status: 200, body: { rules: [...sentRules].map((id) => ({ id })), occurrences: [{ occurrenceId: "o1" }] } };
      if (path === "/admin/api/experience-publications/providers/prv_1/products/x1") return stateVersion === 0 ? { status: 404, body: { error: { code: "NOT_FOUND" } } } : { status: 200, body: { publication: { stateVersion, published: true, operationsSuspended: suspended, selfStoppedAtUtc: null, ownerResumeRequired: suspended } } };
      return { status: 404, body: { error: { code: "NOT_FOUND" } } };
    },
    async send(method, path, body, operationId, raw): Promise<ApiResponse> {
      hooks.beforeSend();
      sent.push({ method, path, body: body as Record<string, unknown>, operationId, raw } as never);
      if (seen.has(operationId)) return { status: 409, body: { error: "operation_already_recorded" } };
      seen.add(operationId);
      if (hooks.rejectNext) { const r = hooks.rejectNext; hooks.rejectNext = null; return r; }
      const b = (body ?? {}) as Loose;
      if (method === "POST" && path.endsWith("/calendar")) return seen.size && sentRules.has(b.commandId) ? { status: 200, body: { id: b.commandId, version: 1 } } : (sentRules.add(b.commandId), { status: 201, body: { id: b.commandId, version: 1 } });
      if (method === "POST" && path.endsWith("/media")) { product = { ...product!, media: [...(product!.media ?? []), { id: "m1", altText: raw!.headers["x-experience-photo-alt-text-utf8-base64url"] }] }; return { status: 201, body: { product: dto() } }; }
      if (method === "POST" && path.endsWith("/suspend")) { suspended = true; return { status: 200, body: { publication: { state: "OPERATIONS_SUSPENDED", stateVersion: stateVersion + 1 } } }; }
      if (method === "POST" && path.endsWith("/clear-suspension")) { suspended = false; return { status: 200, body: { publication: { state: "RESUME_REQUIRED", stateVersion: stateVersion + 1 } } }; }
      if (method === "POST" && path === ROOT) return { status: 201, body: { profile: { providerId: "prv_2", publicDisplayName: b.publicDisplayName } } };
      if (method === "POST" && path === `${ROOT}/prv_1/products`) {
        product = { id: "x1", version: "", draft: { slug: b.slug, publicTitle: b.publicTitle, content: b.content, currency: "JPY", unitAmount: b.unitAmount }, saleTerms: null, terms: null };
        return { status: 201, body: { product: dto() } };
      }
      if (!product) return { status: 404, body: { error: { code: "NOT_FOUND" } } };
      if (b.version !== rev()) return { status: 409, body: { error: { code: "VERSION_CONFLICT" } } };
      if (method === "PATCH") { product = { ...product, draft: b.draft }; draftVersion += 1; return { status: 200, body: { product: dto() } }; }
      if (method === "PUT" && path.endsWith("/sale-terms")) { product = { ...product, terms: b.saleTerms }; termsVersion += 1; return { status: 200, body: { product: dto() } }; }
      if (method === "POST" && path.endsWith("/publish")) return { status: 200, body: { publication: { status: "PUBLISHED", version: 1 } } };
      return { status: 404, body: {} };
    },
  };
  return { api, sent, hooks, setPublished: () => { stateVersion = 2; }, current: () => product, seed: () => { product = { id: "x1", version: "", draft: { slug: "tea", publicTitle: "茶", content, currency: "JPY", unitAmount: 5000 }, saleTerms: null, terms: null }; } };
}

const exec = (api: Api, argv: string[], file?: string, bytes?: Uint8Array) => run(["product", ...argv], { environment: {}, api, now: () => NOW, readFile: () => file ?? "", readBytes: () => bytes ?? new Uint8Array() });
const out = (outcome: Awaited<ReturnType<typeof run>>) => outcome.output as Loose;

describe("provider", () => {
  it("lists, and registers a provider only with the consent confirmed, once per public name", async () => {
    const fake = fakeApi();
    const run2 = (argv: string[]) => run(["provider", ...argv], { environment: {}, api: fake.api, now: () => NOW });
    expect(out(await run2(["list"])).result.providers).toHaveLength(1);
    expect((await run2(["create", "--name", "New", "--kind", "PERSON"])).exit).toBe(2);
    expect((await run2(["create", "--name", " New", "--kind", "PERSON", "--consent-confirmed"])).exit).toBe(2);
    expect(out(await run2(["create", "--name", "New", "--kind", "PERSON", "--consent-confirmed"])).result.status).toBe("dry_run");
    expect(fake.sent).toEqual([]);
    expect(out(await run2(["create", "--name", "New", "--kind", "PERSON", "--consent-confirmed", "--yes"])).result.status).toBe("applied");
    expect(fake.sent[0]).toMatchObject({ method: "POST", path: ROOT, body: { publicDisplayName: "New", providerKind: "PERSON", consentVersion: "provider-public-profile-v1", consentConfirmed: true } });
    expect(out(await run2(["create", "--name", "Sample", "--kind", "PERSON", "--consent-confirmed", "--yes"])).result.status).toBe("unchanged");
  });
});

describe("provider profile", () => {
  it("sets the public profile of an existing provider with the version it read, and a repeat changes nothing", async () => {
    const providers = [{ providerId: "prv_9", publicDisplayName: null as string | null, providerKind: null as string | null, profileVersion: null as number | null }];
    const sent: Array<{ method: string; path: string; body: { expectedVersion: number | null; profile?: unknown } }> = [];
    const api: Api = {
      env: "stg", aiKind: "claude-code",
      async get() { return { status: 200, body: { providers } }; },
      async send(method, path, body): Promise<ApiResponse> {
        sent.push({ method, path, body: body as never });
        const b = body as { expectedVersion: number | null; profile: { publicDisplayName: string; providerKind: string } };
        if (b.expectedVersion !== providers[0]!.profileVersion) return { status: 409, body: { error: { code: "VERSION_CONFLICT" } } };
        providers[0] = { providerId: "prv_9", publicDisplayName: b.profile.publicDisplayName, providerKind: b.profile.providerKind, profileVersion: (b.expectedVersion ?? 0) + 1 };
        return { status: 200, body: {} };
      },
    };
    const go = (argv: string[]) => run(["provider", "profile", ...argv], { environment: {}, api, now: () => NOW });
    const flags = ["--provider", "prv_9", "--name", "NIHO kamakura", "--kind", "BUSINESS", "--consent-confirmed"];
    expect((await go(flags)).output).toMatchObject({ mode: "dry-run", result: { status: "dry_run" } });
    expect(sent).toEqual([]);
    expect((await go(["--provider", "prv_9", "--name", "NIHO kamakura", "--kind", "BUSINESS", "--yes"])).exit).toBe(2);
    expect((await go([...flags, "--yes"])).output).toMatchObject({ result: { status: "applied" } });
    expect(sent[0]).toMatchObject({ method: "PUT", path: "/admin/api/product-workspaces/prv_9/profile", body: { expectedVersion: null, profile: { consentVersion: "provider-public-profile-v1", consentConfirmed: true } } });
    expect((await go([...flags, "--yes"])).output).toMatchObject({ result: { status: "unchanged" } });
    expect((await go(["--provider", "prv_9", "--name", "NIHO kamakura 2", "--kind", "BUSINESS", "--consent-confirmed", "--yes"])).output).toMatchObject({ result: { status: "applied" } });
    expect(sent[1]!.body.expectedVersion).toBe(1);
  });
});

describe("provider photo-add", () => {
  it("sends the photo with the consent version, the placement and the media version it read, and refuses a missing alt text", async () => {
    const sent: Array<{ path: string; headers: Record<string, string> }> = [];
    const api: Api = {
      env: "stg", aiKind: "claude-code",
      async get() { return { status: 200, body: { providerMedia: { version: 3, assets: [] } } }; },
      async send(_m, path, _b, _op, raw): Promise<ApiResponse> { sent.push({ path, headers: raw!.headers as Record<string, string> }); return { status: 201, body: {} }; },
    };
    const go = (argv: string[], bytes = new Uint8Array([1, 2])) => run(["provider", "photo-add", ...argv], { environment: {}, api, now: () => NOW, readBytes: () => bytes });
    const base = ["--provider", "prv_9", "--file", "me.png", "--alt", "A person", "--alt-ja", "人物"];
    expect((await go(["--provider", "prv_9", "--file", "me.png", "--alt", "A person", "--yes"])).exit).toBe(2);
    expect(out(await go(base)).result).toMatchObject({ status: "dry_run", photo: { placement: "PROVIDER_PHOTO" }, mediaVersion: 3 });
    expect(sent).toEqual([]);
    expect(out(await go([...base, "--yes"])).result.status).toBe("applied");
    expect(sent[0]!.path).toBe("/admin/api/product-workspaces/prv_9/provider-media");
    expect(sent[0]!.headers).toMatchObject({ "x-experience-photo-rights-confirmed": "true", "x-experience-provider-profile-consent-version": "provider-public-profile-v1", "x-experience-media-placement": "PROVIDER_PHOTO", "x-experience-provider-media-version": "3" });
    expect(out(await go([...base, "--logo", "--yes"])).result.placement).toBe("BUSINESS_LOGO");
  });
});

describe("product create, show and list", () => {
  const draft = JSON.stringify({ slug: "tea", publicTitle: "茶", unitAmount: 5000, content });
  it("plans first, creates with --yes in JPY, and does not create the same slug twice", async () => {
    const fake = fakeApi();
    expect(out(await exec(fake.api, ["create", "--provider", "prv_1", "--file", "d.json"], draft)).result.status).toBe("dry_run");
    expect(fake.sent).toEqual([]);
    const created = out(await exec(fake.api, ["create", "--provider", "prv_1", "--file", "d.json", "--yes"], draft));
    expect(created.result.status).toBe("applied");
    expect(fake.sent[0]).toMatchObject({ method: "POST", body: { slug: "tea", currency: "JPY", unitAmount: 5000 } });
    expect(out(await exec(fake.api, ["create", "--provider", "prv_1", "--file", "d.json", "--yes"], draft)).result.status).toBe("unchanged");
    expect(fake.sent).toHaveLength(1);
    expect(out(await exec(fake.api, ["list", "--provider", "prv_1"])).result).toMatchObject({ count: 1, products: [{ slug: "tea", japaneseOnly: true, hasSaleTerms: false }] });
    expect(out(await exec(fake.api, ["show", "--provider", "prv_1", "--product", "x1"])).result).toMatchObject({ id: "x1", draft: { slug: "tea" } });
  });
  it("refuses a file with a missing or unknown key before anything is sent", async () => {
    const fake = fakeApi();
    for (const text of ["nope", "[]", JSON.stringify({ slug: "tea" }), JSON.stringify({ slug: "tea", publicTitle: "t", unitAmount: 1, content, price: 2 })]) {
      expect((await exec(fake.api, ["create", "--provider", "prv_1", "--file", "d.json", "--yes"], text)).exit, text).toBe(1);
    }
    expect((await exec(fake.api, ["create", "--file", "d.json"], draft)).exit).toBe(2);
    expect(fake.sent).toEqual([]);
  });
  it("retries under a fresh operation ID when an earlier try failed after the server recorded it", async () => {
    const fake = fakeApi();
    fake.hooks.rejectNext = { status: 503, body: { error: { code: "UNAVAILABLE" } } };
    expect((await exec(fake.api, ["create", "--provider", "prv_1", "--file", "d.json", "--yes"], draft)).exit).toBe(1);
    const again = await exec(fake.api, ["create", "--provider", "prv_1", "--file", "d.json", "--yes"], draft);
    expect(out(again).result.status).toBe("applied");
    expect(fake.sent[1]!.operationId).toBe(fake.sent[0]!.operationId);
    expect(fake.sent[2]!.operationId).toMatch(new RegExp(`^${fake.sent[0]!.operationId}-r[0-9a-f]{6}$`));
  });
});

describe("product draft", () => {
  it("merges content by top-level key, changes only what is given, carries the revision it read, and a repeat changes nothing", async () => {
    const fake = fakeApi();
    fake.seed();
    const file = JSON.stringify({ publicTitle: "茶（改）", content: { ja: { title: "茶（改）", lead: "新" } } });
    const planned = out(await exec(fake.api, ["draft", "--provider", "prv_1", "--product", "x1", "--file", "c.json"], file));
    expect(planned.result.status).toBe("dry_run");
    expect(planned.result.changes.map((change: { path: string }) => change.path)).toEqual(["content.ja.lead", "content.ja.title", "publicTitle"].sort());
    expect(fake.sent).toEqual([]);
    expect(out(await exec(fake.api, ["draft", "--provider", "prv_1", "--product", "x1", "--file", "c.json", "--yes"], file)).result.status).toBe("applied");
    expect(fake.sent[0]).toMatchObject({ method: "PATCH", body: { draft: { slug: "tea", publicTitle: "茶（改）", unitAmount: 5000, currency: "JPY" } } });
    expect((fake.sent[0]!.body.draft as { content: Record<string, unknown> }).content.japaneseOnly).toBe(true);
    expect(out(await exec(fake.api, ["draft", "--provider", "prv_1", "--product", "x1", "--file", "c.json", "--yes"], file)).result.status).toBe("unchanged");
  });
  it("refuses a price or an unknown key here, and stops with exit 4 when the product changed after it was read", async () => {
    const fake = fakeApi();
    fake.seed();
    expect((await exec(fake.api, ["draft", "--provider", "prv_1", "--product", "x1", "--file", "c.json", "--yes"], JSON.stringify({ unitAmount: 1 }))).exit).toBe(1);
    const file = JSON.stringify({ publicTitle: "茶（改）" });
    await exec(fake.api, ["draft", "--provider", "prv_1", "--product", "x1", "--file", "c.json", "--yes"], JSON.stringify({ publicTitle: "一度目" }));
    fake.hooks.rejectNext = { status: 409, body: { error: { code: "VERSION_CONFLICT" } } };
    const conflict = await exec(fake.api, ["draft", "--provider", "prv_1", "--product", "x1", "--file", "c.json", "--yes"], file);
    expect(conflict.exit).toBe(4);
    expect(fake.current()!.draft.publicTitle).toBe("一度目");
  });
});

describe("product terms", () => {
  it("is terms-tier: changes the price (a draft patch) and then the sale terms with the new revision, and a repeat changes nothing", async () => {
    const fake = fakeApi();
    fake.seed();
    const file = JSON.stringify({ unitAmount: 6000, saleTerms: { maxPartySize: 6, bookingQuestions: [] } });
    const planned = out(await exec(fake.api, ["terms", "--provider", "prv_1", "--product", "x1", "--file", "t.json"], file));
    expect(planned).toMatchObject({ tier: "terms", mode: "dry-run" });
    expect(fake.sent).toEqual([]);
    expect(out(await exec(fake.api, ["terms", "--provider", "prv_1", "--product", "x1", "--file", "t.json", "--yes"], file)).result.status).toBe("applied");
    expect(fake.sent.map((item) => [item.method, item.path.split("/").pop()])).toEqual([["PATCH", "x1"], ["PUT", "sale-terms"]]);
    expect(fake.sent[1]!.operationId).toBe(`${fake.sent[0]!.operationId.slice(0, -2)}-b`);
    expect(fake.current()).toMatchObject({ draft: { unitAmount: 6000 }, terms: { maxPartySize: 6 } });
    expect(out(await exec(fake.api, ["terms", "--provider", "prv_1", "--product", "x1", "--file", "t.json", "--yes"], file)).result.status).toBe("unchanged");
    expect((await exec(fake.api, ["terms", "--provider", "prv_1", "--product", "x1", "--file", "t.json"], JSON.stringify({ slug: "x" }))).exit).toBe(1);
  });
});

describe("product terms with terms already set", () => {
  it("never sends the response-only fields back, and refuses a field that is not a sale-terms field", async () => {
    const fake = fakeApi();
    fake.seed();
    fake.current()!.terms = { version: 3, updatedAtUtc: "2026-11-01T00:00:00.000Z", maxPartySize: 4, cancellationPolicy: "FREE_UNTIL_24H", bookingQuestions: [], conditionsVersion: null };
    const result = out(await exec(fake.api, ["terms", "--provider", "prv_1", "--product", "x1", "--file", "t.json", "--yes"], JSON.stringify({ saleTerms: { maxPartySize: 6 } })));
    expect(result.result.status).toBe("applied");
    expect(result.result.changes.map((change: { path: string }) => change.path)).toEqual(["saleTerms.maxPartySize"]);
    expect(Object.keys(fake.sent[0]!.body.saleTerms as object).sort()).toEqual(["bookingQuestions", "cancellationPolicy", "conditionsVersion", "maxPartySize"]);
    const bad = await exec(fake.api, ["terms", "--provider", "prv_1", "--product", "x1", "--file", "t.json", "--yes"], JSON.stringify({ saleTerms: { version: 9 } }));
    expect(bad.exit).toBe(1);
    expect(fake.sent).toHaveLength(1);
  });
});

describe("product publish", () => {
  const flags = ["publish", "--provider", "prv_1", "--product", "x1", "--seller-confirmation", "WRITTEN"];
  it("needs the seller's confirmation method", async () => {
    const fake = fakeApi();
    fake.seed();
    expect((await exec(fake.api, ["publish", "--provider", "prv_1", "--product", "x1", "--yes"])).exit).toBe(2);
    expect((await exec(fake.api, ["publish", "--provider", "prv_1", "--product", "x1", "--seller-confirmation", "MAYBE", "--yes"])).exit).toBe(2);
    expect(fake.sent).toEqual([]);
  });
  it("is publish-tier: shows the blockers without --yes, refuses while any remains, and publishes the revision it read", async () => {
    const blocked = fakeApi(["PHOTO_REQUIRED"]);
    blocked.seed();
    expect(out(await exec(blocked.api, flags)).result).toMatchObject({ status: "dry_run", wouldPublish: false, blockers: ["PHOTO_REQUIRED"] });
    const refused = await exec(blocked.api, [...flags, "--yes"]);
    expect(refused.exit).toBe(1);
    expect(out(refused)).toMatchObject({ error: "publication_blocked", blockers: ["PHOTO_REQUIRED"] });
    expect(blocked.sent).toEqual([]);
    const ready = fakeApi();
    ready.seed();
    expect(out(await exec(ready.api, flags)).result).toMatchObject({ status: "dry_run", wouldPublish: true });
    const done = out(await exec(ready.api, [...flags, "--yes"]));
    expect(done).toMatchObject({ tier: "publish", mode: "apply", result: { status: "applied" } });
    expect(ready.sent[0]).toMatchObject({ method: "POST", body: { accepted: true, sellerConfirmationMethod: "WRITTEN", photoRightsConfirmed: true, consentVersion: CONSENT } });
  });
  it("says a product that is already published is unchanged, and does not mistake the draft API's FORBIDDEN for a sign-in problem", async () => {
    const fake = fakeApi();
    fake.seed();
    fake.setPublished();
    const again = out(await exec(fake.api, [...flags, "--yes"]));
    expect(again.result).toMatchObject({ status: "unchanged", state: { published: true } });
    expect(fake.sent).toEqual([]);
    const refused = await exec({ ...fake.api, get: async () => ({ status: 403, body: { error: { code: "FORBIDDEN" } } }) }, ["show", "--provider", "prv_1", "--product", "x1"]);
    expect(refused.exit).toBe(1);
    expect(out(refused).message).toContain("never published");
  });

  it("reports a publication the server blocked (422) with its blockers", async () => {
    const fake = fakeApi();
    fake.seed();
    fake.hooks.rejectNext = { status: 422, body: { error: { code: "PUBLICATION_BLOCKED", blockers: ["CONNECT_NOT_READY"] } } };
    const refused = await exec(fake.api, [...flags, "--yes"]);
    expect(refused.exit).toBe(1);
    expect(out(refused)).toMatchObject({ error: "publication_blocked", blockers: ["CONNECT_NOT_READY"] });
  });
});

const RULE = { timeZone: "Asia/Tokyo", startsOn: "2026-12-01", localStartTime: "10:00", durationMinutes: 90, capacity: 4, bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "WEEKLY" } };

describe("product calendar", () => {
  it("shows the dates in a range", async () => {
    const fake = fakeApi();
    fake.seed();
    expect(out(await exec(fake.api, ["calendar", "--provider", "prv_1", "--product", "x1", "--from", "2026-12-01", "--to", "2026-12-31"])).result).toMatchObject({ range: { from: "2026-12-01", to: "2026-12-31" }, occurrenceCount: 1 });
    expect((await exec(fake.api, ["calendar", "--provider", "prv_1", "--product", "x1", "--from", "soon"])).exit).toBe(2);
  });
  it("validates the rule with the domain's own parser, sends it under a command ID made from its content, and the same rule again changes nothing", async () => {
    const fake = fakeApi();
    fake.seed();
    const file = JSON.stringify(RULE);
    const planned = out(await exec(fake.api, ["calendar-add", "--provider", "prv_1", "--product", "x1", "--file", "r.json"], file));
    expect(planned.result.status).toBe("dry_run");
    expect(planned.result.commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(fake.sent).toEqual([]);
    expect(out(await exec(fake.api, ["calendar-add", "--provider", "prv_1", "--product", "x1", "--file", "r.json", "--yes"], file)).result.status).toBe("applied");
    expect(fake.sent[0]).toMatchObject({ method: "POST", body: { action: "createRule", experienceId: "x1", providerId: "prv_1", commandId: planned.result.commandId } });
    expect(out(await exec(fake.api, ["calendar-add", "--provider", "prv_1", "--product", "x1", "--file", "r.json", "--yes"], file)).result.status).toBe("unchanged");
    const same = JSON.stringify(Object.fromEntries(Object.entries(RULE).reverse()));
    expect(out(await exec(fake.api, ["calendar-add", "--provider", "prv_1", "--product", "x1", "--file", "r.json"], same)).result.commandId).toBe(planned.result.commandId);
    expect(out(await exec(fake.api, ["calendar-add", "--provider", "prv_1", "--product", "x1", "--file", "r.json"], JSON.stringify({ ...RULE, capacity: 5 }))).result.commandId).not.toBe(planned.result.commandId);
  });
  it("does not call a rule done because the server recorded the operation: it must be in the schedule, otherwise it is sent again", async () => {
    const fake = fakeApi();
    fake.seed();
    fake.hooks.rejectNext = { status: 503, body: { error: "unavailable" } };
    const file = JSON.stringify(RULE);
    expect((await exec(fake.api, ["calendar-add", "--provider", "prv_1", "--product", "x1", "--file", "r.json", "--yes"], file)).exit).toBe(1);
    const again = out(await exec(fake.api, ["calendar-add", "--provider", "prv_1", "--product", "x1", "--file", "r.json", "--yes"], file));
    expect(again.result.status).toBe("applied");
    expect(fake.sent[2]!.operationId).toMatch(new RegExp(`^${fake.sent[0]!.operationId}-r[0-9a-f]{6}$`));
  });

  it("refuses a rule the domain refuses", async () => {
    const fake = fakeApi();
    fake.seed();
    for (const bad of [{ ...RULE, timeZone: "UTC" }, { ...RULE, capacity: 0 }, { ...RULE, startsOn: "tomorrow" }, { ...RULE, recurrence: { kind: "MONTHLY" } }]) {
      const result = await exec(fake.api, ["calendar-add", "--provider", "prv_1", "--product", "x1", "--file", "r.json", "--yes"], JSON.stringify(bad));
      expect(result.exit, JSON.stringify(bad)).toBe(1);
      expect(out(result).error).toBe("invalid_rule");
    }
    expect(fake.sent).toEqual([]);
  });
});

describe("product photo-add", () => {
  const base = ["photo-add", "--provider", "prv_1", "--product", "x1", "--file", "tea.jpg", "--alt", "A tea bowl", "--alt-ja", "茶碗"];
  const bytes = new Uint8Array([1, 2, 3, 4]);
  it("needs the alt texts (no rights input: the owner clears the rights first), and takes jpg or png only", async () => {
    const fake = fakeApi();
    fake.seed();
    const without = (flag: string) => { const i = base.indexOf(flag); return base.filter((_, index) => !(index === i || (index === i + 1 && flag !== "--rights-confirmed"))); };
    for (const flag of ["--alt", "--alt-ja", "--file"]) expect((await exec(fake.api, [...without(flag), "--yes"], undefined, bytes)).exit, flag).toBe(2);
    expect((await exec(fake.api, [...base.map((item) => (item === "tea.jpg" ? "tea.gif" : item)), "--yes"], undefined, bytes)).exit).toBe(2);
    expect((await exec(fake.api, [...base, "--yes"], undefined, new Uint8Array())).exit).toBe(1);
    expect(fake.sent).toEqual([]);
  });
  it("prints the evidence without --yes, uploads the bytes with the rights header and encoded texts, and does not upload the same file twice", async () => {
    const fake = fakeApi();
    fake.seed();
    const planned = out(await exec(fake.api, base, undefined, bytes));
    expect(planned.result).toMatchObject({ status: "dry_run", evidence: { publicCredit: null }, photo: { bytes: 4, contentType: "image/jpeg" } });
    expect(planned.result.evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.sent).toEqual([]);
    const done = out(await exec(fake.api, [...base, "--credit", "撮影：NIHO", "--yes"], undefined, bytes));
    expect(done.result.status).toBe("applied");
    const raw = (fake.sent[0] as unknown as { raw: { headers: Record<string, string>; contentType: string; bytes: Uint8Array } }).raw;
    expect(raw.contentType).toBe("image/jpeg");
    expect(raw.headers).toMatchObject({ "x-experience-photo-rights-confirmed": "true", "x-experience-media-placement": "GALLERY" });
    expect(Buffer.from(raw.headers["x-experience-photo-alt-text-ja-utf8-base64url"]!, "base64url").toString("utf8")).toBe("茶碗");
    expect(Buffer.from(raw.headers["x-experience-photo-credit-utf8-base64url"]!, "base64url").toString("utf8")).toBe("撮影：NIHO");
    const repeat = await exec(fake.api, [...base, "--yes"], undefined, bytes);
    expect(repeat.exit).toBe(1);
    expect(out(repeat).error).toBe("photo_upload_unconfirmed");
    expect(fake.sent).toHaveLength(2);
  });
});

describe("product suspend and resume", () => {
  it("is publish-tier, needs a reason code, takes the state version from the revision, and has nothing to stop before the first publication", async () => {
    const fake = fakeApi();
    fake.seed();
    const stop = ["suspend", "--provider", "prv_1", "--product", "x1", "--reason", "SYNTHETIC_CLEANUP"];
    expect(out(await exec(fake.api, [...stop, "--yes"])).result.status).toBe("unchanged");
    expect((await exec(fake.api, ["suspend", "--provider", "prv_1", "--product", "x1", "--reason", "bad code", "--yes"])).exit).toBe(2);
    fake.setPublished();
    expect(out(await exec(fake.api, stop)).result).toMatchObject({ status: "dry_run", wouldSuspend: { stateVersion: 2, reason: "SYNTHETIC_CLEANUP" } });
    expect(fake.sent).toEqual([]);
    const done = out(await exec(fake.api, [...stop, "--yes"]));
    expect(done).toMatchObject({ tier: "publish", result: { status: "applied" } });
    expect(fake.sent[0]).toMatchObject({ method: "POST", path: "/admin/api/experience-publications/providers/prv_1/products/x1/suspend", body: { expectedStateVersion: 2, reasonCode: "SYNTHETIC_CLEANUP" } });
    expect(out(await exec(fake.api, [...stop, "--yes"])).result.status).toBe("unchanged");
    expect(out(await exec(fake.api, ["resume", "--provider", "prv_1", "--product", "x1", "--yes"])).result.status).toBe("applied");
    expect(fake.sent[1]).toMatchObject({ path: "/admin/api/experience-publications/providers/prv_1/products/x1/clear-suspension", body: { expectedStateVersion: 2 } });
    expect(out(await exec(fake.api, ["resume", "--provider", "prv_1", "--product", "x1", "--yes"])).result.status).toBe("unchanged");
  });
});
