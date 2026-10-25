import { beforeEach, describe, expect, it, vi } from "vitest";

const japanese = vi.hoisted(() => ({ staticRelease: "release-1" as string | null, detailRelease: "release-1" }));

vi.mock("server-only", () => ({}));
vi.mock("./config", () => ({ config: { siteUrl: "https://experience.example.com", indexingAllowed: true } }));
vi.mock("./localized-content", async () => {
  const { assertSameJapaneseRelease } = await vi.importActual<typeof import("./localized-release")>("./localized-release");
  return {
    assertSameJapaneseRelease,
    getJapaneseDetail: async (slug: string) => {
      if (slug !== "translated-experience") throw new Error("missing");
      return { releaseId: japanese.detailRelease };
    },
    getPreparedJapaneseStaticRelease: async () => {
      if (!japanese.staticRelease) throw new Error("incomplete static shell");
      return { releaseId: japanese.staticRelease };
    },
  };
});

import { experienceAlternates } from "./locale-metadata";

const EN = "https://experience.example.com/experiences";
const englishOnly = (url: string) => ({ canonical: url, languages: { en: url, "x-default": url } });

describe("experience hreflang", () => {
  beforeEach(() => { japanese.staticRelease = "release-1"; japanese.detailRelease = "release-1"; });

  it("links the Japanese page next to the English one and x-default when it would render", async () => {
    await expect(experienceAlternates("translated-experience", `${EN}/translated-experience`)).resolves.toEqual({
      canonical: `${EN}/translated-experience`,
      languages: { en: `${EN}/translated-experience`, ja: "https://experience.example.com/ja/experiences/translated-experience", "x-default": `${EN}/translated-experience` },
    });
  });

  it("never points at a Japanese page that does not exist", async () => {
    await expect(experienceAlternates("english-only", `${EN}/english-only`)).resolves.toEqual(englishOnly(`${EN}/english-only`));
  });

  it("leaves ja out while /ja shows only \"unavailable\": no static release, or a different release", async () => {
    japanese.staticRelease = null;
    await expect(experienceAlternates("translated-experience", `${EN}/translated-experience`)).resolves.toEqual(englishOnly(`${EN}/translated-experience`));
    japanese.staticRelease = "release-2";
    await expect(experienceAlternates("translated-experience", `${EN}/translated-experience`)).resolves.toEqual(englishOnly(`${EN}/translated-experience`));
  });
});
