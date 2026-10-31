import { describe, expect, it } from "vitest";
import { guideReadMinutes, shareableGuideImage } from "../guides";
import { guideArticleJsonLd } from "../structured-data";
import { parseEditorArticleBody, parseEditorPreview, parseEditorPublishedList, type EditorArticle } from "./contract";
import { EDITOR_COVER_ASSUMED_SIZE, EDITOR_PREVIEW_AUTHOR, editorArticleToGuide, editorPhotoUrl, editorPreviewToGuide } from "./convert";
import { EDITOR_FIXTURE, FIXTURE_ASSET_ORIGIN, fixtureArticle } from "./fixtures/fake-editor-api";

const policy = { assetOrigins: [FIXTURE_ASSET_ORIGIN] };
const SITE = "https://experience.example";

/** A fixture article as the source assembles it: the list's fields plus the body. */
function article(name: string): EditorArticle {
  const raw = Object.fromEntries(Object.entries(fixtureArticle(name)).filter(([key]) => !key.startsWith("$")));
  const summary = parseEditorPublishedList({ contractVersion: "1", items: [raw], nextCursor: null }).items[0];
  if (!summary) throw new Error(`${name} is not listed`);
  const body = parseEditorArticleBody({ contractVersion: "1", ...raw }, summary.id);
  if (!body.ok) throw new Error(body.reason);
  return { ...summary, ...body.body };
}

describe("an editor publication as a guide", () => {
  it("maps every field to the display model, with no pillar, FAQ, related guides or checked date", () => {
    const result = editorArticleToGuide(article("live-1"), policy);
    expect(result).toEqual({
      ok: true,
      guide: {
        slug: "sample-evening-walk",
        title: "A slow evening walk (sample guide)",
        description: "A synthetic guide for checking the editor source: an evening route, two stops and where to sit down.",
        category: { slug: "evenings", label: "Evenings", displayOrder: 1000 },
        author: { name: "Sample Writer" },
        publishedAt: "2026-10-20",
        updatedAt: "2026-10-30",
        hero: {
          src: "https://assets.editor.example/photos/cover-1.jpg",
          alt: "A quiet lane at dusk (sample photo)",
          width: 1600,
          height: 900,
          licensed: false,
          caption: "Photo: Sample Studio",
        },
        relatedExperienceSlugs: ["evening-pottery-session", "home-cooked-dinner-with-locals"],
        relatedGuideSlugs: [],
        faq: [],
        body: fixtureArticle("live-1").markdown,
      },
    });
    expect(EDITOR_COVER_ASSUMED_SIZE).toEqual({ width: 1600, height: 900 });
    if (result.ok) expect(guideReadMinutes(result.guide)).toBeGreaterThanOrEqual(1);
  });

  it("never shares an editor cover: no Open Graph image and no Article.image, and no jobTitle for a name-only author", () => {
    const result = editorArticleToGuide(article("live-1"), policy);
    if (!result.ok) throw new Error(result.reason);
    expect(shareableGuideImage(result.guide, SITE)).toBeNull();
    const jsonLd = guideArticleJsonLd(result.guide, SITE, "NIHO Experience");
    expect(jsonLd).not.toHaveProperty("image");
    expect(jsonLd.author).toEqual({ "@type": "Person", name: "Sample Writer" });
  });

  it("keeps an empty alt, shows no caption without a credit, labels a two-word category and marks unlisted", () => {
    const rainy = editorArticleToGuide(article("live-2"), policy);
    expect(rainy).toMatchObject({ ok: true, guide: { hero: { alt: "", licensed: false }, category: { slug: "day-trips", label: "Day trips", displayOrder: 1000 }, updatedAt: "2026-10-25" } });
    expect(rainy.ok && rainy.guide).not.toHaveProperty("unlisted");
    expect(rainy.ok && rainy.guide.hero).not.toHaveProperty("caption");
    const market = editorArticleToGuide(article("live-3"), policy);
    expect(market).toMatchObject({ ok: true, guide: { slug: "sample-market-morning" } });
    expect(market.ok && market.guide.hero).toBeUndefined();
    expect(editorArticleToGuide(article("unlisted-1"), policy)).toMatchObject({ ok: true, guide: { unlisted: true } });
  });

  it("leaves out unsafe content: http or foreign photos, internal asset references, script links, empty bodies", () => {
    expect(editorArticleToGuide(article("http-cover"), policy)).toEqual({ ok: false, reason: "cover is not an https URL on an allowed host" });
    expect(editorArticleToGuide(article("foreign-figure"), policy)).toEqual({ ok: false, reason: "a body photo is not an https URL on an allowed host" });
    expect(editorArticleToGuide(article("internal-asset"), policy)).toEqual({ ok: false, reason: "a body photo uses an internal guide asset reference" });
    expect(editorArticleToGuide(article("script-link"), policy)).toEqual({ ok: false, reason: "markdown is outside the guide subset at line 3" });
    const live = article("live-1");
    expect(editorArticleToGuide({ ...live, markdown: "  \n" }, policy)).toEqual({ ok: false, reason: "markdown is empty" });
    expect(editorArticleToGuide({ ...live, markdown: "## A\n\n![Local](/guides/local.jpg)" }, policy)).toEqual({ ok: false, reason: "a body photo is not an https URL on an allowed host" });
    expect(editorArticleToGuide({ ...live, assets: [{ ...live.assets[0]!, url: "https://elsewhere.example/a.jpg" }] }, policy)).toEqual({ ok: false, reason: "an asset is not an https URL on an allowed host" });
    // The reason names the line, never the offending text.
    expect(JSON.stringify(editorArticleToGuide(article("script-link"), policy))).not.toContain("javascript");
  });

  it("accepts photos only on the configured origins, over https and without credentials", () => {
    expect(editorPhotoUrl("https://assets.editor.example/a.jpg", policy)).toBe("https://assets.editor.example/a.jpg");
    expect(editorPhotoUrl("https://assets.editor.example:8443/a.jpg", policy)).toBeNull();
    expect(editorPhotoUrl("https://user@assets.editor.example/a.jpg", policy)).toBeNull();
    expect(editorPhotoUrl("http://assets.editor.example/a.jpg", policy)).toBeNull();
    expect(editorPhotoUrl("//assets.editor.example/a.jpg", policy)).toBeNull();
    expect(editorPhotoUrl("https://assets.editor.example/it's.jpg", policy)).toBeNull();
  });
});

describe("a preview draft as a guide", () => {
  const draft = (token: string) => {
    const parsed = parseEditorPreview(EDITOR_FIXTURE.previews[token as keyof typeof EDITOR_FIXTURE.previews]);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.preview;
  };

  it("renders a draft that meets none of the publication conditions, with neutral defaults", () => {
    expect(editorPreviewToGuide(draft("pv_synthetic-preview-not-a-secret-draft-000001"), policy, "2026-10-31")).toEqual({
      ok: true,
      guide: {
        slug: "sample-unfinished-draft",
        unlisted: true,
        title: "An unfinished draft (sample)",
        description: "",
        author: { name: "Sample Writer" },
        publishedAt: "2026-10-30",
        updatedAt: "2026-10-31",
        relatedExperienceSlugs: [],
        relatedGuideSlugs: [],
        faq: [],
        body: "Opening paragraph without a heading\\. [CONFIRM: opening hours]\n",
      },
    });
    // Nothing written yet: the preview slug and a neutral author with no role.
    expect(editorPreviewToGuide({ title: "T", markdown: "", assets: [], related: [] }, policy, "2026-10-31")).toMatchObject({
      ok: true,
      guide: { slug: "preview", author: EDITOR_PREVIEW_AUTHOR, publishedAt: "2026-10-31" },
    });
    expect(EDITOR_PREVIEW_AUTHOR).toEqual({ name: "Author not set" });
  });

  it("applies the same safety checks, explaining a Markdown error with its line for the writer", () => {
    expect(editorPreviewToGuide(draft("pv_synthetic-preview-not-a-secret-draft-000002"), policy, "2026-10-31")).toEqual({
      ok: false,
      reason: "markdown is outside the guide subset at line 3",
      detail: "line 3: Raw HTML is not supported",
    });
    const unsafeCover = { ...draft("pv_synthetic-preview-not-a-secret-draft-000001"), cover: { id: "c", url: "https://elsewhere.example/c.jpg", alt: "x" } };
    expect(editorPreviewToGuide(unsafeCover, policy, "2026-10-31")).toMatchObject({ ok: false, reason: "cover is not an https URL on an allowed host" });
  });
});
