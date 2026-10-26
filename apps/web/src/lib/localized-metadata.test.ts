import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { siteUrl: "https://experience.example.com", indexingAllowed: true } }));
const shell = vi.hoisted(() => ({ released: false }));
vi.mock("@/lib/localized-content", async () => {
  const { assertSameJapaneseRelease } = await vi.importActual<typeof import("@/lib/localized-release")>("@/lib/localized-release");
  return {
    getJapaneseDetail: async () => ({ releaseId: "release-1", experience: { slug: "translated-experience", title: "翻訳した体験", lead: "鎌倉で過ごす時間。" } }),
    getJapaneseCopy: async () => ({ releaseId: "release-1" }),
    getJapaneseSidecar: async () => ({ releaseId: "release-1" }),
    getPreparedJapaneseStaticRelease: async () => {
      if (!shell.released) throw new Error("incomplete static shell");
      return { releaseId: "release-1" };
    },
    assertSameJapaneseRelease,
    japaneseRenderableDocument: vi.fn(),
  };
});

import { japaneseExperienceMetadata } from "@/components/pages/ExperiencePageContent";

describe("Japanese dynamic metadata", () => {
  it("stays unavailable and noindex when the whole static shell is incomplete", async () => {
    await expect(japaneseExperienceMetadata({
      params: Promise.resolve({ slug: "translated-experience" }),
      searchParams: Promise.resolve({}),
    })).resolves.toEqual({ title: "Japanese experience unavailable", robots: { index: false, follow: false } });
  });

  it("links back to the English page and x-default once the Japanese page renders", async () => {
    shell.released = true;
    const metadata = await japaneseExperienceMetadata({ params: Promise.resolve({ slug: "translated-experience" }), searchParams: Promise.resolve({}) });
    expect(metadata.alternates).toEqual({
      canonical: "https://experience.example.com/ja/experiences/translated-experience",
      languages: {
        en: "https://experience.example.com/experiences/translated-experience",
        ja: "https://experience.example.com/ja/experiences/translated-experience",
        "x-default": "https://experience.example.com/experiences/translated-experience",
      },
    });
  });
});
