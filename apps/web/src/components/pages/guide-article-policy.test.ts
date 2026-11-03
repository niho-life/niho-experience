import { describe, expect, it } from "vitest";
import type { Guide } from "@/content/guides";
import { withoutUnverifiedPreviewRelated } from "./guide-article-policy";

const guide: Guide = {
  slug: "synthetic-preview",
  title: "Synthetic preview",
  description: "Synthetic preview description",
  author: { name: "Synthetic Writer" },
  publishedAt: "2030-01-01",
  updatedAt: "2030-01-01",
  relatedExperienceSlugs: ["currently-unverified"],
  relatedGuideSlugs: [],
  faq: [],
  body: "## Preview",
};

describe("editor preview related experience policy", () => {
  it("removes unverified related slugs without rejecting the preview body", () => {
    expect(withoutUnverifiedPreviewRelated(guide, true)).toMatchObject({ relatedExperienceSlugs: [] });
    expect(guide.relatedExperienceSlugs).toEqual(["currently-unverified"]);
  });

  it("does not alter variants whose authority is handled elsewhere", () => {
    expect(withoutUnverifiedPreviewRelated(guide, false)).toBe(guide);
  });
});
