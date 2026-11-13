import { describe, expect, it } from "vitest";
import { run } from "../../../../scripts/experience/ops/main.ts";
import { OFFICE_AUTHOR, type GuideDto } from "../../../../scripts/experience/ops/guide.ts";
import type { Api, ApiResponse } from "../../../../scripts/experience/ops/core.ts";

/* 運営の CLI (#576) ⑤: the article target against an in-memory copy of the /write/api/guides routes. No network. */

// Fake-API JSON has no fixed shape in these tests, so `any` is allowed for this one alias.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

const NOW = Date.parse("2026-11-14T00:00:00.000Z");
const ROOT = "/write/api/guides";

function fakeApi() {
  const guides = new Map<string, GuideDto & { cover?: Record<string, unknown> }>();
  const sent: Array<{ method: string; path: string; body: Loose | undefined; operationId: string; raw?: unknown }> = [];
  const seen = new Set<string>();
  const hooks = { rejectNext: null as null | ApiResponse };
  const api: Api = {
    env: "stg", aiKind: "claude-code",
    async get(path) {
      if (path === "/write/api/categories") return { status: 200, body: { categories: [{ slug: "walks" }] } };
      if (path === ROOT) return { status: 200, body: { guides: [...guides.values()] } };
      const id = path.slice(ROOT.length + 1);
      const guide = guides.get(id);
      return guide ? { status: 200, body: { guide } } : { status: 404, body: { error: "not_found" } };
    },
    async send(method, path, body, operationId, raw): Promise<ApiResponse> {
      sent.push({ method, path, body: body as never, operationId, raw });
      if (seen.has(operationId)) return { status: 409, body: { error: "operation_already_recorded" } };
      seen.add(operationId);
      if (hooks.rejectNext) { const r = hooks.rejectNext; hooks.rejectNext = null; return r; }
      const b = (body ?? {}) as Loose;
      if (method === "POST" && path === ROOT) {
        if (guides.has(b.id)) return { status: 200, body: { guide: guides.get(b.id), created: false } };
        const guide = { id: b.id, slug: b.slug, subject: { kind: "PROVIDER", providerId: b.providerId }, title: b.title, description: b.description, categorySlug: b.categorySlug, content: b.content, status: "DRAFT", revision: 1 } as GuideDto;
        guides.set(b.id, guide);
        return { status: 201, body: { guide, created: true } };
      }
      const id = path.split("/")[4]!;
      const guide = guides.get(id);
      if (!guide) return { status: 404, body: { error: "not_found" } };
      if (method === "PATCH") {
        if (b.expectedRevision !== guide.revision) return { status: 409, body: { error: "conflict" } };
        guides.set(id, { ...guide, slug: b.slug, title: b.title, description: b.description, content: b.content, ...(b.cover === undefined ? {} : b.cover === null ? { cover: undefined } : { cover: b.cover }), revision: guide.revision + 1 });
        return { status: 200, body: { guide: guides.get(id) } };
      }
      if (path.endsWith("/media") && method === "POST") return { status: 201, body: { asset: { id: "asset-1" } } };
      if (path.includes("/media/") && method === "PUT") return { status: 200, body: { asset: { id: "asset-1", webConfirmed: true } } };
      if (path.endsWith("/publication") && method === "POST") {
        if (b.expectedRevision !== guide.revision) return { status: 409, body: { error: "conflict" } };
        guides.set(id, { ...guide, status: "PUBLISHED", revision: guide.revision + 1 });
        return { status: 200, body: { publication: { status: "PUBLISHED", visibility: b.visibility } } };
      }
      if (path.endsWith("/publication") && method === "DELETE") {
        guides.set(id, { ...guide, status: "STOPPED", revision: guide.revision + 1 });
        return { status: 200, body: { publication: { status: "STOPPED" } } };
      }
      return { status: 404, body: {} };
    },
  };
  return { api, guides, sent, hooks };
}

const exec = (api: Api, argv: string[], file?: string, bytes?: Uint8Array) => run(["guide", ...argv], { environment: {}, api, now: () => NOW, readFile: () => file ?? "", readBytes: () => bytes ?? new Uint8Array() });
const out = (o: Awaited<ReturnType<typeof run>>) => o.output as Loose;
const file = JSON.stringify({ slug: "rainy", title: "雨の日の鎌倉", description: "雨の日。", categorySlug: "walks", content: { markdown: "## 見出し\n\n本文です。" } });

describe("guide create", () => {
  it("plans first, creates a Japanese draft under the office byline, and does not create the same slug twice", async () => {
    const fake = fakeApi();
    expect(out(await exec(fake.api, ["create", "--provider", "prov-a", "--file", "a.json"], file)).result.status).toBe("dry_run");
    expect(fake.sent).toEqual([]);
    const done = out(await exec(fake.api, ["create", "--provider", "prov-a", "--file", "a.json", "--yes"], file));
    expect(done.result).toMatchObject({ status: "applied", guide: { slug: "rainy", status: "DRAFT", providerId: "prov-a", language: "ja" } });
    expect(fake.sent[0]!.body).toMatchObject({ providerId: "prov-a", content: { language: "ja", author: OFFICE_AUTHOR } });
    expect(fake.sent[0]!.body!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(out(await exec(fake.api, ["create", "--provider", "prov-a", "--file", "a.json", "--yes"], file)).result.status).toBe("unchanged");
    expect(fake.guides.size).toBe(1);
  });
  it("lets the file name another author, and refuses a missing or unknown key", async () => {
    const fake = fakeApi();
    const author = { name: "別の人", role: "ホスト", bio: "紹介" };
    await exec(fake.api, ["create", "--provider", "prov-a", "--file", "a.json", "--yes"], JSON.stringify({ ...JSON.parse(file), content: { markdown: "## a\n\nb", author } }));
    expect(fake.sent[0]!.body!.content.author).toEqual(author);
    for (const text of ["nope", "[]", JSON.stringify({ slug: "x" }), JSON.stringify({ ...JSON.parse(file), price: 1 }), JSON.stringify({ ...JSON.parse(file), content: {} })]) {
      expect((await exec(fake.api, ["create", "--provider", "prov-a", "--file", "a.json", "--yes"], text)).exit, text).toBe(1);
    }
    expect((await exec(fake.api, ["create", "--file", "a.json"], file)).exit).toBe(2);
  });
});

describe("guide draft", () => {
  it("merges content by key, sends the revision it read, and a repeat changes nothing", async () => {
    const fake = fakeApi();
    await exec(fake.api, ["create", "--provider", "prov-a", "--file", "a.json", "--yes"], file);
    const id = [...fake.guides.keys()][0]!;
    const change = JSON.stringify({ title: "雨の日の鎌倉（改）", content: { markdown: "## 新\n\n本文" } });
    const planned = out(await exec(fake.api, ["draft", "--id", id, "--file", "c.json"], change));
    expect(planned.result.status).toBe("dry_run");
    expect(planned.result.changes.map((c: { path: string }) => c.path).sort()).toEqual(["content.markdown", "title"]);
    expect(out(await exec(fake.api, ["draft", "--id", id, "--file", "c.json", "--yes"], change)).result.status).toBe("applied");
    const patch = fake.sent.at(-1)!;
    expect(patch).toMatchObject({ method: "PATCH", body: { expectedRevision: 1, slug: "rainy", categorySlug: "walks" } });
    expect(patch.body!.content).toMatchObject({ language: "ja", author: OFFICE_AUTHOR, markdown: "## 新\n\n本文" });
    expect(patch.body!.cover).toBeUndefined();
    expect(out(await exec(fake.api, ["draft", "--id", id, "--file", "c.json", "--yes"], change)).result.status).toBe("unchanged");
  });
  it("stops with exit 4 when the article changed after it was read", async () => {
    const fake = fakeApi();
    await exec(fake.api, ["create", "--provider", "prov-a", "--file", "a.json", "--yes"], file);
    const id = [...fake.guides.keys()][0]!;
    fake.hooks.rejectNext = { status: 409, body: { error: "conflict" } };
    expect((await exec(fake.api, ["draft", "--id", id, "--file", "c.json", "--yes"], JSON.stringify({ title: "別" }))).exit).toBe(4);
    expect(fake.guides.get(id)!.title).toBe("雨の日の鎌倉");
  });
});

describe("guide photo-add", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  it("needs no rights input: it uploads, confirms the photo for the web with the office credit, and can set it as the cover", async () => {
    const fake = fakeApi();
    await exec(fake.api, ["create", "--provider", "prov-a", "--file", "a.json", "--yes"], file);
    const id = [...fake.guides.keys()][0]!;
    const base = ["photo-add", "--id", id, "--file", "rain.jpg", "--alt", "A rainy lane"];
    expect(out(await exec(fake.api, base, undefined, bytes)).result).toMatchObject({ status: "dry_run", photo: { contentType: "image/jpeg", credit: "NIHO kamakura", cover: false } });
    const sentBefore = fake.sent.length;
    const done = out(await exec(fake.api, [...base, "--cover", "--yes"], undefined, bytes));
    expect(JSON.stringify(done)).toContain("applied");
    expect(done.result).toMatchObject({ status: "applied", assetId: "asset-1", cover: true });
    const [upload, confirm, patch] = fake.sent.slice(sentBefore);
    expect(upload).toMatchObject({ method: "POST", path: `${ROOT}/${id}/media` });
    expect((upload!.raw as { contentType: string }).contentType).toBe("image/jpeg");
    expect(confirm).toMatchObject({ method: "PUT", body: { publicCredit: "NIHO kamakura", webConfirmed: true } });
    expect(patch).toMatchObject({ method: "PATCH", body: { cover: { assetId: "asset-1", alt: "A rainy lane", credit: "NIHO kamakura", webConfirmed: true } } });
    expect(out(await exec(fake.api, [...base, "--yes"], undefined, bytes)).result.status).toBe("unchanged");
  });
  it("needs the article id, a file of the right kind and an alt text", async () => {
    const fake = fakeApi();
    for (const argv of [["photo-add", "--file", "a.jpg", "--alt", "x"], ["photo-add", "--id", "g1", "--file", "a.gif", "--alt", "x"], ["photo-add", "--id", "g1", "--file", "a.jpg"]]) expect((await exec(fake.api, [...argv, "--yes"], undefined, bytes)).exit, argv.join(" ")).toBe(2);
    expect((await exec(fake.api, ["photo-add", "--id", "g1", "--file", "a.jpg", "--alt", "x", "--yes"], undefined, new Uint8Array())).exit).toBe(1);
  });
});

describe("guide publish and stop", () => {
  it("is publish-tier: shows what would be published, publishes the revision it read, and stops it again", async () => {
    const fake = fakeApi();
    await exec(fake.api, ["create", "--provider", "prov-a", "--file", "a.json", "--yes"], file);
    const id = [...fake.guides.keys()][0]!;
    const planned = out(await exec(fake.api, ["publish", "--id", id]));
    expect(planned).toMatchObject({ tier: "publish", mode: "dry-run", result: { status: "dry_run", wouldPublish: { visibility: "PUBLIC" } } });
    expect((await exec(fake.api, ["publish", "--id", id, "--visibility", "HIDDEN", "--yes"])).exit).toBe(2);
    expect(out(await exec(fake.api, ["publish", "--id", id, "--yes"])).result).toMatchObject({ status: "applied", publication: { status: "PUBLISHED" } });
    expect(fake.sent.at(-1)).toMatchObject({ method: "POST", body: { expectedRevision: 1, visibility: "PUBLIC" } });
    expect(out(await exec(fake.api, ["stop", "--id", id])).result.status).toBe("dry_run");
    expect(out(await exec(fake.api, ["stop", "--id", id, "--yes"])).result.status).toBe("applied");
    expect(fake.sent.at(-1)).toMatchObject({ method: "DELETE", body: { expectedRevision: 2 } });
    expect(out(await exec(fake.api, ["stop", "--id", id, "--yes"])).result.status).toBe("unchanged");
  });
  it("lists and shows, and reports the categories", async () => {
    const fake = fakeApi();
    await exec(fake.api, ["create", "--provider", "prov-a", "--file", "a.json", "--yes"], file);
    const id = [...fake.guides.keys()][0]!;
    expect(out(await exec(fake.api, ["list"])).result).toMatchObject({ count: 1, guides: [{ id, slug: "rainy" }] });
    expect(out(await exec(fake.api, ["show", "--id", id])).result.guide.content.markdown).toContain("本文");
    expect(out(await exec(fake.api, ["categories"])).result.categories).toHaveLength(1);
  });
});
