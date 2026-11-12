import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ config: { groupInquiryEnabled: true } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));

import { GroupGuidePage } from "@/components/pages/GroupGuidePage";
import { InquiryBand } from "@/components/InquiryBand";
import { inquiryContextFromSearch } from "@/lib/group-inquiry-entry";
import { inquiryFooterLinks } from "@/lib/group-inquiry-links";
import { BUSINESS_GUIDE, GROUP_GUIDE_FACTS, GROUP_GUIDE_NUMBERS, SCHOOLS_GUIDE, from, n, range, type GroupGuide } from "@/lib/group-inquiry-guide";

/** 法人・団体の方へ / 学校の方へ (#532): the guides' figures come from one place and the pages open the form on the right kind. */
beforeEach(() => { state.config = { groupInquiryEnabled: true }; });

const textOf = (guide: GroupGuide): string => JSON.stringify(guide);

describe("the guides' figures", () => {
  it("keep every number in one list, once each, and show only numbers that list holds", () => {
    const keys = GROUP_GUIDE_NUMBERS.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(n("freeConsultMinutes")).toBe("20分");
    expect(from("planningFeeGroupFrom")).toBe("30,000円〜");
    expect(range("bizOffsiteCapacityMin", "bizOffsiteCapacityMax")).toBe("12〜20人");
    expect(() => n("nope" as never)).toThrow();
    // A digit in the guides' text is either a figure from the list/facts or a numbering word, never typed into the copy by hand.
    const allowed = new Set([...GROUP_GUIDE_NUMBERS.map((item) => item.value.toLocaleString("en-US")), ...Object.values(GROUP_GUIDE_FACTS).flatMap((fact) => fact.value.match(/\d[\d,]*/g) ?? []), "1", "2"]);
    for (const guide of [BUSINESS_GUIDE, SCHOOLS_GUIDE]) {
      for (const digits of textOf(guide).match(/\d[\d,]*/g) ?? []) expect(allowed.has(digits), `${guide.kind}: ${digits}`).toBe(true);
    }
  });

  it("says the first talk is free and about 20 minutes, puts the day-of presence in the quote, and promises nothing", () => {
    for (const guide of [BUSINESS_GUIDE, SCHOOLS_GUIDE]) {
      const text = textOf(guide);
      expect(text).toContain("無料（20分ほど）");
      expect(text).toContain("必要なときに、お見積りに含めます");
      // No track record, testimonials or guarantees.
      for (const word of ["必ず", "絶対", "保証", "実績", "事例", "お客様の声", "満足度", "好評", "多数"]) expect(text, word).not.toContain(word);
    }
  });
});

describe("GroupGuidePage", () => {
  it("opens the form on the company/organization kind, with its entry, from every button", () => {
    const html = renderToStaticMarkup(createElement(GroupGuidePage, { guide: BUSINESS_GUIDE }));
    expect(html).toContain("チームの一日を、鎌倉の街で。");
    const hrefs = [...html.matchAll(/href="(\/ja\/inquiry[^"]*)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));
    expect(hrefs.length).toBe(2);
    for (const href of hrefs) expect(inquiryContextFromSearch(Object.fromEntries(new URL(href, "https://x.test").searchParams))).toMatchObject({ kind: "CORPORATE", entry: "CORPORATE" });
    expect(html).toContain('href="/ja/schools"');
  });

  it("opens the form on the school kind, with its questions for teachers", () => {
    const html = renderToStaticMarkup(createElement(GroupGuidePage, { guide: SCHOOLS_GUIDE }));
    expect(html).toContain("一度に何人まで受けられますか");
    expect(html).toContain("昼食はとれますか");
    expect(html).toContain("資料と見積を相談する");
    const hrefs = [...html.matchAll(/href="(\/ja\/inquiry[^"]*)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));
    for (const href of hrefs) expect(inquiryContextFromSearch(Object.fromEntries(new URL(href, "https://x.test").searchParams))).toMatchObject({ kind: "SCHOOL", entry: "SCHOOL" });
  });

  it("is a 404 while the inquiry feature is off", () => {
    state.config = { groupInquiryEnabled: false };
    expect(() => renderToStaticMarkup(createElement(GroupGuidePage, { guide: SCHOOLS_GUIDE }))).toThrow("NEXT_NOT_FOUND");
  });
});

describe("the links from the Japanese site", () => {
  it("add the form and both guides to the footer only while the feature is on", () => {
    expect(inquiryFooterLinks().map((link) => link.href)).toEqual(["/ja/inquiry", "/ja/business", "/ja/schools"]);
    state.config = { groupInquiryEnabled: false };
    expect(inquiryFooterLinks()).toEqual([]);
  });

  it("invites from the top page to the form, the company guide and the school guide", () => {
    const html = renderToStaticMarkup(createElement(InquiryBand));
    expect(html).toContain('href="/ja/inquiry"');
    expect(html).toContain('href="/ja/business"');
    expect(html).toContain('href="/ja/schools"');
    expect(html).toContain("はじめの相談は無料です");
  });
});
