import { describe, expect, it } from "vitest";
import type { GuideArticleRecord } from "@niho-experience/experience-store";
import {
  guidePublicationProblems,
  parseGuideDraftPreview,
} from "./guide-publication";
import {
  guidePublicationActionLabel,
  guidePublicationNeedsSave,
  guidePublicationStatusLabel,
} from "./guide-publication-ui";

const validArticle: GuideArticleRecord = {
  id: "article-synthetic",
  slug: "synthetic-guide",
  creatorNihoUserId: "writer-synthetic",
  subject: { kind: "WRITER" },
  categorySlug: "walks",
  title: "A synthetic walk",
  description: "A test-only description.",
  content: {
    markdown: "## Start here\n\nThis is safe test content.",
    author: { name: "Synthetic Writer", role: "Local guide", bio: "A test-only profile." },
  },
  status: "DRAFT",
  revision: 2,
  createdAtUtc: "2026-10-29T00:00:00.000Z",
  updatedAtUtc: "2026-10-29T01:00:00.000Z",
};

describe("guide publication validation", () => {
  it("accepts a complete saved article in an active category", () => {
    expect(guidePublicationProblems(validArticle, new Set(["walks"]))).toEqual([]);
  });

  it("points authors to missing or unconfirmed body photos before publication", () => {
    const assetId = "00000000-0000-4000-8000-000000000216";
    const article = {
      ...validArticle,
      content: { ...validArticle.content, markdown: `## Photo\n\n![Synthetic photo](niho-guide-asset:${assetId})` },
    };
    expect(guidePublicationProblems(article, new Set(["walks"]), [])).toContainEqual({
      field: "body", message: expect.stringContaining("利用できなくなった"),
    });
    expect(guidePublicationProblems(article, new Set(["walks"]), [{
      id: assetId, width: 100, height: 100, webConfirmed: false,
    }])).toContainEqual({ field: "body", message: expect.stringContaining("掲載許諾") });
    expect(guidePublicationProblems(article, new Set(["walks"]), [{
      id: assetId, width: 100, height: 100, publicCredit: "Synthetic", webConfirmed: true,
    }])).toEqual([]);
  });

  it("returns compact field-keyed corrections for incomplete or stale content", () => {
    const problems = guidePublicationProblems({
      ...validArticle,
      title: "[CONFIRM: title]",
      description: "",
      categorySlug: "retired",
      content: {
        markdown: "A paragraph with /sample/photo.jpg and [CONFIRM: fact].",
        author: { name: "Writer", role: "", bio: "[CONFIRM: profile]" },
      },
    }, new Set(["walks"]));
    expect(problems).toEqual(expect.arrayContaining([
      { field: "title", message: expect.stringContaining("確認待ち") },
      { field: "description", message: expect.stringContaining("説明") },
      { field: "category", message: expect.stringContaining("選び直") },
      { field: "author", message: expect.stringContaining("すべて") },
      { field: "body", message: expect.stringContaining("H2") },
      { field: "body", message: expect.stringContaining("サンプル") },
    ]));
  });

  it("treats parser failures and photos as body corrections", () => {
    const unsafe = guidePublicationProblems({
      ...validArticle,
      content: { ...validArticle.content, markdown: "## Unsafe\n\n<script>alert(1)</script>" },
    }, new Set(["walks"]));
    expect(unsafe).toContainEqual({ field: "body", message: expect.stringContaining("安全でないMarkdown") });

    const photo = guidePublicationProblems({
      ...validArticle,
      content: { ...validArticle.content, markdown: "## Photo\n\n![Synthetic](/approved/photo.jpg)" },
    }, new Set(["walks"]));
    expect(photo).toContainEqual({ field: "body", message: expect.stringContaining("写真") });
  });

  it("requires explicit Web permission for a selected cover", () => {
    expect(guidePublicationProblems({
      ...validArticle,
      cover: {
        assetId: "00000000-0000-4000-8000-000000000215",
        alt: "Synthetic cover",
        credit: "Synthetic fixture",
        webConfirmed: false,
      },
    }, new Set(["walks"]))).toContainEqual({
      field: "cover",
      message: expect.stringContaining("掲載許諾"),
    });
  });

  it("parses safe private previews and returns author-correctable errors", () => {
    expect(parseGuideDraftPreview(validArticle.content.markdown)).toMatchObject({ ok: true });
    expect(parseGuideDraftPreview("## Unsafe\n\n<script>bad</script>")).toEqual({
      ok: false,
      message: expect.stringContaining("安全でないMarkdown"),
    });
    expect(parseGuideDraftPreview("## Photo\n\n![Synthetic](/photo.jpg)")).toEqual({
      ok: false,
      message: expect.stringContaining("差し替え"),
    });
    expect(parseGuideDraftPreview("## Photo\n\n![Synthetic](niho-guide-asset:00000000-0000-4000-8000-000000000216)")).toMatchObject({ ok: true });
  });
});

describe("guide publication UI state", () => {
  it("keeps preview and publication behind a saved revision", () => {
    expect(guidePublicationNeedsSave(true, 3)).toBe(true);
    expect(guidePublicationNeedsSave(false, null)).toBe(true);
    expect(guidePublicationNeedsSave(false, 3)).toBe(false);
  });

  it("labels current status and the mutation without implying a new draft", () => {
    expect(guidePublicationStatusLabel("DRAFT")).toBe("未公開");
    expect(guidePublicationStatusLabel("PUBLISHED", "PUBLIC")).toBe("公開版あり");
    expect(guidePublicationStatusLabel("PUBLISHED", "UNLISTED")).toBe("非掲載の公開版あり");
    expect(guidePublicationActionLabel("PUBLISHED", false)).toBe("公開版を更新");
    expect(guidePublicationActionLabel("STOPPED", true)).toBe("保存中");
  });
});
