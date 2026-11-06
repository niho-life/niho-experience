import { describe, expect, it, vi } from "vitest";
import { GUIDE_LIMITS, guidePublishProblems, shareableGuideImage } from "../guides";
import { parseEditorArticleBody, parseEditorPreview, parseEditorPublishedList } from "./contract";
import { editorArticleToGuide, editorPreviewToGuide } from "./convert";
import { EDITOR_FIXTURE, FIXTURE_ASSET_ORIGIN, fixtureArticle } from "./fixtures/fake-editor-api";
import { guidePublicationRequirements } from "./requirements";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { siteUrl: "https://experience.example" } }));
const routeMocks = vi.hoisted(() => ({
  categories: [{ slug: "evenings", labelEn: "Evenings", labelJa: "夕方", displayOrder: 1, revision: 1 }],
}));
vi.mock("@/lib/experience/store-server", () => ({ articleAuthorityRepository: () => ({
  listActiveCategories: async () => routeMocks.categories,
}) }));

const { GET } = await import("@/app/api/public/guides/publication-requirements/route");

const SITE = "https://experience.example";
const CATEGORIES = [{ slug: "evenings", labelEn: "Evenings", labelJa: "夕方", displayOrder: 1, revision: 1 }] as const;

/**
 * The editor's closed rules for a destination declaration, copied from niho-life/niho-editor
 * packages/editor-publish/src/declaration.ts (schema version 1) and its contract's vocabularies. The editor rejects a
 * whole declaration over one unknown kind, field or value, so a drift here would close publishing to this site: this
 * copy says which path breaks. Update it with the editor's rules, never to make a declaration pass.
 */
const DESTS = ["exp", "niho", "site"];
const RANGES = ["live", "unlisted"];
const LANGS = ["ja", "en"];
const EXTRA_KEYS = ["app", "news", "xp"];
const BLOCK_TYPES = ["paragraph", "heading", "list", "quote", "figure", "divider", "note"];
const MARK_TYPES = ["bold", "italic", "strike", "code", "link"];
const FIXES = ["lang", "cover", "lead", "category", "body", "related"];
const TOP_KEYS = ["schemaVersion", "id", "label", "host", "path", "ranges", "extras", "accepts", "requires"];
const KIND_KEYS: Record<string, { allowed: string[]; required: string[] }> = {
  lang: { allowed: ["equals"], required: ["equals"] },
  cover: { allowed: ["consent"], required: ["consent"] },
  lead: { allowed: ["max"], required: [] },
  category: { allowed: ["oneOf"], required: [] },
  headings: { allowed: ["min"], required: ["min"] },
  noConfirm: { allowed: [], required: [] },
  relatedLive: { allowed: [], required: [] },
  title: { allowed: ["max"], required: ["max"] },
  images: { allowed: ["alt"], required: ["alt"] },
};
const LIMITS = { maxLabel: 80, maxMessage: 200, maxConditions: 32, maxCategories: 100, maxCategoryLength: 160, maxLead: 10_000, maxHeadings: 100, maxTitle: 500, maxHost: 253, maxPath: 64 };
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cs}/u;
const CONDITION_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH = /^[a-z0-9-]*$/;

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function isDeclarationHost(value: unknown): boolean {
  if (typeof value !== "string" || !value || value.length > LIMITS.maxHost) return false;
  const labels = value.split(".");
  if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label)) || labels.some((label) => label.startsWith("xn--"))) return false;
  return !/^[0-9]+$/.test(labels.at(-1)!);
}

/** Every path the editor would refuse (`$.requires[2].max` …), empty when the declaration is accepted. */
function declarationIssues(input: unknown): string[] {
  const issues: string[] = [];
  const closed = (value: unknown, path: string, allowed: string[], required: string[]): Fields | null => {
    if (!isFields(value)) {
      issues.push(path);
      return null;
    }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(`${path}.${key}`);
    for (const key of required) if (value[key] === undefined) issues.push(`${path}.${key}`);
    return value;
  };
  const textAt = (value: unknown, path: string, max: number) => {
    if (typeof value !== "string" || CONTROL.test(value) || !value.trim() || [...value].length > max) issues.push(path);
  };
  const intAt = (value: unknown, path: string, min: number, max: number) => {
    if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) issues.push(path);
  };
  const setAt = (value: unknown, path: string, allowed: string[], nonEmpty: boolean) => {
    if (!Array.isArray(value) || (nonEmpty && !value.length) || new Set(value).size !== value.length || value.some((entry) => !allowed.includes(entry as string))) issues.push(path);
  };
  const top = closed(input, "$", TOP_KEYS, TOP_KEYS);
  if (!top) return issues;
  if (top.schemaVersion !== 1) issues.push("$.schemaVersion");
  if (!DESTS.includes(top.id as string)) issues.push("$.id");
  textAt(top.label, "$.label", LIMITS.maxLabel);
  if (!isDeclarationHost(top.host)) issues.push("$.host");
  if (typeof top.path !== "string" || top.path.length > LIMITS.maxPath || !PATH.test(top.path)) issues.push("$.path");
  setAt(top.ranges, "$.ranges", RANGES, true);
  if (top.id === "site" && Array.isArray(top.ranges) && top.ranges.includes("unlisted")) issues.push("$.ranges");
  setAt(top.extras, "$.extras", EXTRA_KEYS, false);
  if (top.id !== "exp" && Array.isArray(top.extras) && top.extras.includes("xp")) issues.push("$.extras");
  const accepts = closed(top.accepts, "$.accepts", ["blocks", "marks"], ["blocks", "marks"]);
  if (accepts) {
    setAt(accepts.blocks, "$.accepts.blocks", BLOCK_TYPES, false);
    setAt(accepts.marks, "$.accepts.marks", MARK_TYPES, false);
  }
  if (!Array.isArray(top.requires) || top.requires.length > LIMITS.maxConditions) return [...issues, "$.requires"];
  const ids = new Set<unknown>();
  top.requires.forEach((condition: unknown, index) => {
    const path = `$.requires[${index}]`;
    const kind = isFields(condition) ? condition.kind : undefined;
    const shape = typeof kind === "string" ? KIND_KEYS[kind] : undefined;
    if (!shape) {
      issues.push(`${path}.kind`);
      return;
    }
    const fields = closed(condition, path, ["id", "message", "fix", "kind", ...shape.allowed], ["id", "message", "fix", ...shape.required]);
    if (!fields) return;
    if (typeof fields.id !== "string" || !CONDITION_ID.test(fields.id) || ids.has(fields.id)) issues.push(`${path}.id`);
    ids.add(fields.id);
    textAt(fields.message, `${path}.message`, LIMITS.maxMessage);
    if (!FIXES.includes(fields.fix as string)) issues.push(`${path}.fix`);
    if (kind === "lang" && !LANGS.includes(fields.equals as string)) issues.push(`${path}.equals`);
    if (kind === "cover" && typeof fields.consent !== "boolean") issues.push(`${path}.consent`);
    if (kind === "lead" && fields.max !== undefined) intAt(fields.max, `${path}.max`, 1, LIMITS.maxLead);
    if (kind === "headings") intAt(fields.min, `${path}.min`, 1, LIMITS.maxHeadings);
    if (kind === "title") intAt(fields.max, `${path}.max`, 1, LIMITS.maxTitle);
    if (kind === "images" && typeof fields.alt !== "boolean") issues.push(`${path}.alt`);
    if (kind === "category" && fields.oneOf !== undefined) {
      const oneOf = fields.oneOf;
      if (!Array.isArray(oneOf) || !oneOf.length || oneOf.length > LIMITS.maxCategories || new Set(oneOf).size !== oneOf.length) issues.push(`${path}.oneOf`);
      else oneOf.forEach((entry: unknown, at) => textAt(entry, `${path}.oneOf[${at}]`, LIMITS.maxCategoryLength));
    }
  });
  return issues;
}

/** The declaration as JSON, then changed: the drift checks below start from a copy. */
const declared = () => JSON.parse(JSON.stringify(guidePublicationRequirements(SITE, CATEGORIES))) as Fields & { requires: Fields[] };

describe("the destination declaration (#253, editor declaration schema 1)", () => {
  it("declares NIHO Experience's conditions in the editor's vocabulary, with limits taken from the guide rules", () => {
    expect(guidePublicationRequirements(SITE, CATEGORIES)).toEqual({
      schemaVersion: 1,
      id: "exp",
      label: "NIHO Experience",
      host: "experience.example",
      path: "guides",
      ranges: ["live", "unlisted"],
      extras: ["app"],
      accepts: { blocks: ["paragraph", "heading", "list", "figure", "note"], marks: ["bold", "italic", "link"] },
      requires: [
        { id: "lang-en", kind: "lang", equals: "en", message: "英語で書いてください", fix: "lang" },
        { id: "cover", kind: "cover", consent: true, message: "カバー写真を設定する場合は掲載許諾を確認してください", fix: "cover" },
        { id: "lead", kind: "lead", max: GUIDE_LIMITS.descriptionMaxLength, message: `リードを設定する場合は ${GUIDE_LIMITS.descriptionMaxLength} 字以内にしてください`, fix: "lead" },
        { id: "category", kind: "category", oneOf: ["evenings"], message: "カテゴリを選んでください", fix: "category" },
        { id: "headings", kind: "headings", min: 1, message: "本文に見出しを 1 つ以上入れてください", fix: "body" },
        { id: "no-confirm", kind: "noConfirm", message: "未確認の印（CONFIRM）を解消してください", fix: "body" },
        { id: "related-live", kind: "relatedLive", message: "掲載中の関連する体験を選んでください", fix: "related" },
        { id: "title", kind: "title", max: GUIDE_LIMITS.titleMaxLength, message: `題名を ${GUIDE_LIMITS.titleMaxLength} 字以内にしてください`, fix: "body" },
        { id: "image-alt", kind: "images", alt: true, message: "写真に代替テキスト（alt）を入れてください", fix: "body" },
      ],
    });
    expect(guidePublicationRequirements("https://experience.niho.life").host).toBe("experience.niho.life");
  });

  it("passes the editor's closed rules, which still catch every kind of drift", () => {
    expect(declarationIssues(guidePublicationRequirements(SITE, CATEGORIES))).toEqual([]);
    const drifted: [(declaration: ReturnType<typeof declared>) => void, string][] = [
      [(d) => { d.version = 1; }, "$.version"],
      [(d) => { d.schemaVersion = 2; }, "$.schemaVersion"],
      [(d) => { d.id = "niho-experience"; }, "$.id"],
      [(d) => { d.host = "127.0.0.1:3000"; }, "$.host"],
      [(d) => { d.path = "/guides"; }, "$.path"],
      [(d) => { d.extras = ["guides"]; }, "$.extras"],
      [(d) => { d.accepts = { blocks: ["table"], marks: [] }; }, "$.accepts.blocks"],
      [(d) => { d.requires.push({ id: "word-count", kind: "wordCount", message: "x", fix: "body" }); }, "$.requires[9].kind"],
      [(d) => { delete d.requires[7]!.max; }, "$.requires[7].max"],
      [(d) => { d.requires[7]!.max = 501; }, "$.requires[7].max"],
      [(d) => { d.requires[8]!.alt = "yes"; }, "$.requires[8].alt"],
      [(d) => { d.requires[0]!.maxLength = 1; }, "$.requires[0].maxLength"],
      [(d) => { d.requires[1]!.fix = "photo"; }, "$.requires[1].fix"],
      [(d) => { d.requires[2]!.max = 0; }, "$.requires[2].max"],
      [(d) => { d.requires[3]!.id = "Category"; }, "$.requires[3].id"],
      [(d) => { d.requires[4]!.message = "x".repeat(201); }, "$.requires[4].message"],
      [(d) => { delete d.requires[1]!.consent; }, "$.requires[1].consent"],
    ];
    for (const [change, path] of drifted) {
      const declaration = declared();
      change(declaration);
      expect(declarationIssues(declaration), path).toContain(path);
    }
  });

  it("accepts an omitted cover and lead while retaining the lead limit and English requirement", () => {
    const requires = guidePublicationRequirements(SITE).requires;
    const leadMax = requires.find((condition) => condition.kind === "lead")!.max;
    const lang = requires.find((condition) => condition.kind === "lang")!.equals;
    const item = (lead: string | null, itemLang: string) => ({
      ...Object.fromEntries(Object.entries(fixtureArticle("live-3")).filter(([key]) => !key.startsWith("$"))), lead, lang: itemLang,
    });
    const accepted = (lead: string | null, itemLang: string = lang) => parseEditorPublishedList({ contractVersion: "1", items: [item(lead, itemLang)], nextCursor: null }).items.length === 1;
    expect(accepted("l".repeat(leadMax))).toBe(true);
    expect(accepted("l".repeat(leadMax + 1))).toBe(false);
    expect(accepted(null)).toBe(true);
    expect(accepted("A lead.", "ja")).toBe(false);
  });

  it("agrees with the site's own editorial checks: a publication meeting the declaration passes them, a bare draft does not", () => {
    const raw = Object.fromEntries(Object.entries(fixtureArticle("live-1")).filter(([key]) => !key.startsWith("$")));
    const body = parseEditorArticleBody({ contractVersion: "1", ...raw }, String(raw.id));
    if (!body.ok) throw new Error(body.reason);
    const result = editorArticleToGuide({ ...parseEditorPublishedList({ contractVersion: "1", items: [raw], nextCursor: null }).items[0]!, ...body.body }, { assetOrigins: [FIXTURE_ASSET_ORIGIN] });
    if (!result.ok) throw new Error(result.reason);
    const editorial = (problems: string[]) => problems.filter((problem) => /heading|CONFIRM/.test(problem));
    // A cover with consent, a lead, a category, a ## heading and no [CONFIRM: …]: nothing left for the heading/CONFIRM rules.
    expect(result.guide).toMatchObject({ hero: { licensed: false }, category: { slug: "evenings" } });
    expect(result.guide.description).not.toBe("");
    // Consent to publish is not a right to share: the cover stays off social cards.
    expect(shareableGuideImage(result.guide, SITE)).toBeNull();
    expect(editorial(guidePublishProblems(result.guide))).toEqual([]);
    const draft = parseEditorPreview(EDITOR_FIXTURE.previews["pv_synthetic-preview-not-a-secret-draft-000001"]);
    if (!draft.ok) throw new Error(draft.reason);
    const preview = editorPreviewToGuide(draft.preview, { assetOrigins: [FIXTURE_ASSET_ORIGIN] }, "2026-10-31");
    if (!preview.ok) throw new Error(preview.reason);
    expect(editorial(guidePublishProblems(preview.guide))).toHaveLength(2);
  });

  it("reads active categories for every publication check and is never accepted from a stale cache", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(guidePublicationRequirements(SITE, CATEGORIES));
  });

  it("fails closed when Admin has no active category instead of publishing with a stale option", async () => {
    routeMocks.categories = [];
    try {
      const response = await GET();
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "categories_not_configured" });
    } finally {
      routeMocks.categories = [...CATEGORIES];
    }
  });
});
