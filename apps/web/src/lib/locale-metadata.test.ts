import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { siteUrl: "https://experience.example.com", indexingAllowed: true } }));
vi.mock("./config", () => ({ config: { siteUrl: "https://experience.example.com", indexingAllowed: true } }));
vi.mock("./localized-content", () => ({
  getJapaneseDetail: async (slug: string) => {
    if (slug !== "translated-experience") throw new Error("missing");
    return { releaseId: "release-1" };
  },
  getPreparedJapaneseStaticRelease: async () => { throw new Error("not used"); },
}));

import { experienceAlternates } from "./locale-metadata";

const EN = "https://experience.example.com/experiences";

describe("experience hreflang", () => {
  it("links the approved Japanese page next to the English one and x-default", async () => {
    await expect(experienceAlternates("translated-experience", `${EN}/translated-experience`)).resolves.toEqual({
      canonical: `${EN}/translated-experience`,
      languages: { en: `${EN}/translated-experience`, ja: "https://experience.example.com/ja/experiences/translated-experience", "x-default": `${EN}/translated-experience` },
    });
  });

  it("never points at a Japanese page that does not exist", async () => {
    await expect(experienceAlternates("english-only", `${EN}/english-only`)).resolves.toEqual({
      canonical: `${EN}/english-only`,
      languages: { en: `${EN}/english-only`, "x-default": `${EN}/english-only` },
    });
  });
});
