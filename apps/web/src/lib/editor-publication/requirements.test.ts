import { describe, expect, it, vi } from "vitest";
import { GUIDE_LIMITS, guidePublishProblems, shareableGuideImage } from "../guides";
import { parseEditorArticleBody, parseEditorPreview, parseEditorPublishedList } from "./contract";
import { editorArticleToGuide, editorPreviewToGuide } from "./convert";
import { EDITOR_FIXTURE, FIXTURE_ASSET_ORIGIN } from "./fixtures/fake-editor-api";
import { guidePublicationRequirements } from "./requirements";

vi.mock("@/lib/config", () => ({ config: { siteUrl: "https://experience.example" } }));

const { GET } = await import("@/app/api/public/guides/publication-requirements/route");

const SITE = "https://experience.example";

describe("the publication requirements (#253, provisional v1)", () => {
  it("declares every NIHO Experience condition, with limits taken from the guide rules", () => {
    expect(guidePublicationRequirements(SITE)).toEqual({
      version: 1,
      dest: "niho-experience",
      label: "NIHO Experience",
      origin: SITE,
      pathPrefix: "/guides",
      preview: { path: "/guides/preview", tokenParam: "token" },
      conditions: [
        { id: "language-en", kind: "lang", equals: "en" },
        { id: "cover", kind: "cover", required: true, requireLicensed: true },
        { id: "lead", kind: "lead", required: true, maxLength: GUIDE_LIMITS.descriptionMaxLength },
        { id: "title", kind: "title", required: true, maxLength: GUIDE_LIMITS.titleMaxLength },
        { id: "category", kind: "category", required: true },
        { id: "heading", kind: "min-headings", min: 1 },
        { id: "no-confirm-marker", kind: "no-confirm-marker" },
        { id: "related-experiences-listed", kind: "related-experiences-listed", lookup: `${SITE}/experiences/{slug}` },
      ],
    });
  });

  it("agrees with what this site accepts on receipt: English, and the declared title and lead limits", () => {
    const declared = Object.fromEntries(guidePublicationRequirements(SITE).conditions.map((condition) => [condition.id, condition]));
    const item = (title: string, lead: string, lang = "en") => ({
      id: "ed-1", slug: "a-guide", dest: "niho-experience", range: "live", lang, title, lead,
      category: { slug: "planning", label: "Planning" }, author: { name: "Sample Writer", role: "Writer" },
      publishedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
    });
    const titleMax = (declared.title as { maxLength: number }).maxLength;
    const leadMax = (declared.lead as { maxLength: number }).maxLength;
    const accepted = (title: string, lead: string, lang?: string) => parseEditorPublishedList({ items: [item(title, lead, lang)] }).items.length === 1;
    expect(accepted("t".repeat(titleMax), "l".repeat(leadMax))).toBe(true);
    expect(accepted("t".repeat(titleMax + 1), "lead")).toBe(false);
    expect(accepted("title", "l".repeat(leadMax + 1))).toBe(false);
    expect(accepted("title", "lead", (declared["language-en"] as { equals: string }).equals)).toBe(true);
    expect(accepted("title", "lead", "ja")).toBe(false);
  });

  it("agrees with the site's own editorial checks: a publication meeting the declaration passes them, a bare draft does not", () => {
    const raw = EDITOR_FIXTURE.articles.find((candidate) => candidate.id === "ed-live-1")!;
    const body = parseEditorArticleBody(raw, raw.id);
    if (!body.ok) throw new Error(body.reason);
    const result = editorArticleToGuide({ ...parseEditorPublishedList({ items: [raw] }).items[0]!, ...body.body }, { assetOrigins: [FIXTURE_ASSET_ORIGIN] });
    if (!result.ok) throw new Error(result.reason);
    const editorial = (problems: string[]) => problems.filter((problem) => /heading|CONFIRM/.test(problem));
    // Cover with sharing rights, lead, category, a ## heading and no [CONFIRM: …]: nothing left for the heading/CONFIRM rules.
    expect(result.guide).toMatchObject({ hero: { licensed: true }, category: { slug: "evenings" } });
    expect(result.guide.description).not.toBe("");
    expect(shareableGuideImage(result.guide, SITE)).toBe("https://assets.editor.example/photos/cover-1.jpg");
    expect(editorial(guidePublishProblems(result.guide))).toEqual([]);
    const draft = parseEditorPreview(EDITOR_FIXTURE.previews["synthetic-preview-token-0001"]);
    if (!draft.ok) throw new Error(draft.reason);
    const preview = editorPreviewToGuide(draft.preview, { assetOrigins: [FIXTURE_ASSET_ORIGIN] }, "2026-10-31");
    if (!preview.ok) throw new Error(preview.reason);
    expect(editorial(guidePublishProblems(preview.guide))).toHaveLength(2);
  });

  it("is served publicly as cacheable JSON for any origin, outside search", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(guidePublicationRequirements(SITE));
  });
});
