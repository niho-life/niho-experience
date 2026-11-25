import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SAMPLE_TERMS } from "@/lib/testing/guest-booking-fixtures";
import type { SitePublicExperience } from "@/lib/experience/site-publications";

vi.mock("@/components/Photo", () => ({ Photo: () => null }));

import { BookingSummaryHeader } from "./BookingSummaryHeader";

const offer = (over: Record<string, unknown> = {}) => ({ ...SAMPLE_TERMS.offers[0]!, ...over });
const item = (offers = [offer()]): SitePublicExperience => ({
  sellerDisclosure: null, hostBio: null,
  publication: {
    slug: "sample-walk", publicTitle: "Sample walk", providerPublicName: "まさと", providerPublicNameEn: "Masato", providerKind: "PERSON",
    japanese: { title: "合成の山道を歩く" }, photos: [{ src: "/p.jpg", alt: "alt", altJa: "山道", publicCredit: null }],
  },
  saleTerms: { offers },
}) as unknown as SitePublicExperience;
const fact = (html: string) => html.replace(/<[^>]+>/g, " ");

describe("BookingSummaryHeader", () => {
  it("links back to the experience, and says who it is with, how long, where and for how many, in English", () => {
    const html = renderToStaticMarkup(BookingSummaryHeader({ item: item(), locale: "en", area: "kita" }));
    expect(html).toContain('href="/experiences/sample-walk"');
    expect(html).toContain("Back to the experience");
    expect(html).toContain("Sample walk");
    expect(html).toContain("with Masato");
    expect(html).toContain("Kita-Kamakura");
    expect(fact(html)).toMatch(/guests/);
    expect(html).not.toContain("How a request works");
  });

  it("says it in Japanese, with the people it is met through when there are any", () => {
    const html = renderToStaticMarkup(BookingSummaryHeader({ item: item(), locale: "ja", area: "kita", people: [{ name: "菅 倫明" }] }));
    expect(html).toContain('href="/ja/experiences/sample-walk"');
    expect(html).toContain("体験のページへ");
    expect(html).toContain("合成の山道を歩く");
    expect(html).toContain("菅 倫明さんが案内");
    expect(html).toContain("北鎌倉");
    expect(renderToStaticMarkup(BookingSummaryHeader({ item: item(), locale: "ja" }))).toContain("まさとさんと");
  });

  it("shows the three steps of a request only for an approval product, and never calls it a booking", () => {
    for (const locale of ["en", "ja"] as const) {
      const html = renderToStaticMarkup(BookingSummaryHeader({ item: item([offer({ acceptanceMode: "APPROVAL" })]), locale }));
      expect(html.match(/<li/g)).toHaveLength(3);
      expect(html).toContain(locale === "ja" ? "申込みの流れ" : "How a request works");
    }
  });
});
