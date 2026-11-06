import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Guide } from "@/content/guides/types";

/** The guide page's metadata with synthetic guides: the share image and the description fallback. */
const state = vi.hoisted(() => ({ guide: null as Guide | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { siteUrl: "https://experience.example" }, isPreview: false }));
vi.mock("@/lib/guide-registry", () => ({
  findGuide: async () => (state.guide ? { guide: state.guide, draft: false } : null),
  missingGuideRedirect: async () => null,
}));
vi.mock("@/components/pages/GuideArticle", () => ({ GuideArticle: () => null }));

import { generateMetadata } from "./page";

const COVER = "https://assets.editor.example/photos/cover-1.jpg";
const guide = (extra: Partial<Guide> = {}): Guide => ({
  slug: "sample-evening-walk",
  title: "A slow evening walk (sample guide)",
  description: "A synthetic lead.",
  author: { name: "Sample Writer" },
  publishedAt: "2026-10-20",
  updatedAt: "2026-10-30",
  relatedExperienceSlugs: [],
  relatedGuideSlugs: [],
  faq: [],
  body: "## A\n\nThe opening paragraph of the body.",
  ...extra,
});
const metadata = async () => generateMetadata({ params: Promise.resolve({ slug: "sample-evening-walk" }), searchParams: Promise.resolve({}) });

beforeEach(() => {
  state.guide = null;
});

describe("guide page metadata", () => {
  it("shares a licensed editor cover without declaring its stand-in size", async () => {
    state.guide = guide({ hero: { src: COVER, alt: "A lane", width: 1600, height: 900, sizeAssumed: true, licensed: true } });
    const result = await metadata();
    expect(result.openGraph?.images).toEqual([{ url: COVER, alt: "A lane" }]);
    expect(result.twitter?.images).toEqual([COVER]);
  });

  it("declares the size of a licensed photo whose size is its own, and shares no unlicensed cover", async () => {
    state.guide = guide({ hero: { src: COVER, alt: "A lane", width: 1200, height: 800, licensed: true } });
    expect((await metadata()).openGraph?.images).toEqual([{ url: COVER, width: 1200, height: 800, alt: "A lane" }]);
    state.guide = guide({ hero: { src: COVER, alt: "A lane", width: 1600, height: 900, sizeAssumed: true, licensed: false } });
    expect((await metadata()).openGraph?.images).toEqual([]);
  });

  it("describes a guide without a lead by the opening of its body, everywhere the description goes", async () => {
    state.guide = guide({ description: "" });
    const result = await metadata();
    expect(result.description).toBe("The opening paragraph of the body.");
    expect(result.openGraph?.description).toBe("The opening paragraph of the body.");
    expect(result.twitter?.description).toBe("The opening paragraph of the body.");
    state.guide = guide();
    expect((await metadata()).description).toBe("A synthetic lead.");
  });
});
