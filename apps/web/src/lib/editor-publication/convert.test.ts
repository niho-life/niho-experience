import { describe, expect, it } from "vitest";
import { guideReadMinutes } from "../guides";
import { parseEditorArticleBody, parseEditorPreview, parseEditorPublishedList, type EditorArticle } from "./contract";
import { editorArticleToGuide, editorPhotoUrl, editorPreviewToGuide } from "./convert";
import { EDITOR_FIXTURE, FIXTURE_ASSET_ORIGIN } from "./fixtures/fake-editor-api";

const policy = { assetOrigins: [FIXTURE_ASSET_ORIGIN] };

/** A fixture article as the source assembles it: the list's fields plus the body. */
function article(id: string): EditorArticle {
  const raw = EDITOR_FIXTURE.articles.find((candidate) => candidate.id === id)!;
  const summary = parseEditorPublishedList({ items: [raw] }).items[0]!;
  const body = parseEditorArticleBody(raw, id);
  if (!body.ok) throw new Error(body.reason);
  return { ...summary, ...body.body };
}

describe("an editor publication as a guide", () => {
  it("maps every field to the display model, with no pillar, FAQ or related guides", () => {
    const result = editorArticleToGuide(article("ed-live-1"), policy);
    expect(result).toEqual({
      ok: true,
      guide: {
        slug: "sample-evening-walk",
        title: "A slow evening walk (sample guide)",
        description: "A synthetic guide for checking the editor source: an evening route, two stops and where to sit down.",
        category: { slug: "evenings", label: "Evenings", displayOrder: 10 },
        author: { name: "Sample Writer", role: "Contributing writer (sample)", bio: "A synthetic author used only in fixtures." },
        publishedAt: "2026-10-20",
        updatedAt: "2026-10-30",
        checkedAt: "2026-10-29",
        hero: {
          src: "https://assets.editor.example/photos/cover-1.jpg",
          alt: "A quiet lane at dusk (sample photo)",
          width: 1600,
          height: 1067,
          licensed: true,
          caption: "Photo: Sample Studio",
        },
        relatedExperienceSlugs: ["evening-pottery-session", "home-cooked-dinner-with-locals"],
        relatedGuideSlugs: [],
        faq: [],
        body: EDITOR_FIXTURE.articles[0]!.markdown,
      },
    });
    if (result.ok) expect(guideReadMinutes(result.guide)).toBeGreaterThanOrEqual(1);
  });

  it("keeps a cover without a sharing declaration off social cards, orders an unordered category last and marks unlisted", () => {
    const rainy = editorArticleToGuide(article("ed-live-2"), policy);
    expect(rainy).toMatchObject({ ok: true, guide: { hero: { licensed: false }, category: { displayOrder: 1000 }, updatedAt: "2026-10-25" } });
    expect(rainy.ok && rainy.guide).not.toHaveProperty("unlisted");
    expect(rainy.ok && rainy.guide.hero).not.toHaveProperty("caption");
    const market = editorArticleToGuide(article("ed-live-3"), policy);
    expect(market).toMatchObject({ ok: true, guide: { slug: "sample-market-morning" } });
    expect(market.ok && market.guide.hero).toBeUndefined();
    expect(editorArticleToGuide(article("ed-unlisted-1"), policy)).toMatchObject({ ok: true, guide: { unlisted: true } });
  });

  it("leaves out unsafe content: http or foreign photos, internal asset references, script links, empty bodies", () => {
    expect(editorArticleToGuide(article("ed-http-cover"), policy)).toEqual({ ok: false, reason: "cover is not an https URL on an allowed host" });
    expect(editorArticleToGuide(article("ed-foreign-figure"), policy)).toEqual({ ok: false, reason: "a body photo is not an https URL on an allowed host" });
    expect(editorArticleToGuide(article("ed-internal-asset"), policy)).toEqual({ ok: false, reason: "a body photo uses an internal guide asset reference" });
    expect(editorArticleToGuide(article("ed-script-link"), policy)).toEqual({ ok: false, reason: "markdown is outside the guide subset at line 3" });
    const live = article("ed-live-1");
    expect(editorArticleToGuide({ ...live, markdown: "  \n" }, policy)).toEqual({ ok: false, reason: "markdown is empty" });
    expect(editorArticleToGuide({ ...live, markdown: "## A\n\n![Local](/guides/local.jpg)" }, policy)).toEqual({ ok: false, reason: "a body photo is not an https URL on an allowed host" });
    expect(editorArticleToGuide({ ...live, assets: [{ ...live.assets[0]!, url: "https://elsewhere.example/a.jpg" }] }, policy)).toEqual({ ok: false, reason: "an asset is not an https URL on an allowed host" });
    // The reason names the line, never the offending text.
    expect(JSON.stringify(editorArticleToGuide(article("ed-script-link"), policy))).not.toContain("javascript");
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
    expect(editorPreviewToGuide(draft("synthetic-preview-token-0001"), policy, "2026-10-31")).toEqual({
      ok: true,
      guide: {
        slug: "preview",
        unlisted: true,
        title: "An unfinished draft (sample)",
        description: "",
        author: { name: "Author not set", role: "Writer" },
        publishedAt: "2026-10-31",
        updatedAt: "2026-10-31",
        relatedExperienceSlugs: [],
        relatedGuideSlugs: [],
        faq: [],
        body: "Opening paragraph without a heading. [CONFIRM: opening hours]\n",
      },
    });
  });

  it("applies the same safety checks, explaining a Markdown error with its line for the writer", () => {
    expect(editorPreviewToGuide(draft("synthetic-preview-token-0002"), policy, "2026-10-31")).toEqual({
      ok: false,
      reason: "markdown is outside the guide subset at line 3",
      detail: "line 3: Raw HTML is not supported",
    });
    const unsafeCover = { ...draft("synthetic-preview-token-0001"), cover: { id: "c", url: "https://elsewhere.example/c.jpg", width: 10, height: 10, alt: "x", licensed: false } };
    expect(editorPreviewToGuide(unsafeCover, policy, "2026-10-31")).toMatchObject({ ok: false, reason: "cover is not an https URL on an allowed host" });
  });
});
