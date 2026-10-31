import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createStaticCopyV1, defaultStaticCopyValuesV1 } from "@niho/experience-presentation/v1";

/** The footer's Privacy link on the English and the Japanese pages (#285): code-owned, to the one English notice. Synthetic settings only. */
const state = vi.hoisted(() => ({
  guideCatalog: {} as Record<string, unknown>,
  hasGuides: false,
  config: {
    apiMode: "http", siteUrl: "https://experience.example", umamiWebsiteId: "", publicApiVersion: "1.0", indexingAllowed: true, guideEditorSiteOrigin: "", mockCatalog: "synthetic",
  },
}));
vi.mock("server-only", () => ({}));
// The Japanese layout always renders the language switch, which reads the address.
vi.mock("next/navigation", () => ({ usePathname: () => "/ja", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/config", () => ({ get config() { return state.config; }, isPreview: false }));
vi.mock("@/lib/guide-registry", () => ({ guideCatalogForSite: async () => state.guideCatalog, hasGuidesPage: () => state.hasGuides }));
vi.mock("@/lib/localized-content", () => ({
  getJapaneseStaticCounterparts: async () => ({}),
  getPreparedJapaneseStaticRelease: async () => ({ copy: { copy: createStaticCopyV1(defaultStaticCopyValuesV1()), releaseId: "release-1", values: defaultStaticCopyValuesV1() }, counterparts: {} }),
}));

import JapaneseRootLayout from "@/app/(ja)/ja/layout";
import RootLayout from "@/app/(site)/layout";
import { PRIVACY_PATH, privacyFooterLink } from "./privacy-link";

const footer = (markup: string) => /<footer[\s\S]*<\/footer>/.exec(markup)?.[0] ?? "";
const links = (markup: string) => [...footer(markup).matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((match) => [match[1], match[2]]);

describe("the Privacy footer link", () => {
  it("is one code-owned link to the English notice, labelled for the page's language", () => {
    expect(PRIVACY_PATH).toBe("/privacy");
    expect(privacyFooterLink("en")).toEqual({ href: "/privacy", label: "Privacy" });
    expect(privacyFooterLink("ja")).toEqual({ href: "/privacy", label: "プライバシー" });
  });

  it("is in the English footer after the fixed links, with the guides and writers links before it when they exist", async () => {
    const plain = links(renderToStaticMarkup(await RootLayout({ children: createElement("p", null, "page") })));
    expect(plain.at(-1)).toEqual(["/privacy", "Privacy"]);
    expect(plain.map(([href]) => href)).toEqual(["/experiences", "/host", "/help", "/privacy"]);
    state.hasGuides = true;
    state.config = { ...state.config, guideEditorSiteOrigin: "https://editor.example" };
    try {
      const more = links(renderToStaticMarkup(await RootLayout({ children: createElement("p", null, "page") })));
      expect(more.map(([href]) => href)).toEqual(["/experiences", "/host", "/help", "/guides", "https://editor.example", "/privacy"]);
    } finally {
      state.hasGuides = false;
      state.config = { ...state.config, guideEditorSiteOrigin: "" };
    }
  });

  it("is in the Japanese footer as 「プライバシー」 and still opens the English page, while the other links stay under /ja", async () => {
    const markup = renderToStaticMarkup(await JapaneseRootLayout({ children: createElement("p", null, "ページ") }));
    const rows = links(markup);
    expect(rows).toContainEqual(["/privacy", "プライバシー"]);
    expect(rows).toContainEqual(["/ja/help", expect.any(String)]);
    expect(rows.some(([href]) => href === "/ja/privacy")).toBe(false);
  });
});
