import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONCIERGE_INTRO, HOST_PAGE, HOST_PLANS, SALES_PLAN_BASIS_POINTS, USAGE_PAGE } from "./ja-service-copy";
import { BUSINESS_GUIDE } from "./group-inquiry-guide";

/** The Japanese site's usage, host and inquiry-intro copy (#565): the figures are the confirmed ones, and nothing is promised for every experience. */
const ALL = JSON.stringify({ HOST_PAGE, HOST_PLANS, USAGE_PAGE, CONCIERGE_INTRO });

describe("the sales plan rates", () => {
  it("are the ones in docs/experience-sales-plans.md, and the same as the store's three fee rates", () => {
    const doc = readFileSync(new URL("../../../../docs/experience-sales-plans.md", import.meta.url), "utf8");
    expect(doc).toContain("NIHO完全代行（試験導入）20%");
    expect(doc).toContain("NIHOサポート 15%");
    expect(doc).toContain("独立販売 10%");
    expect(SALES_PLAN_BASIS_POINTS).toEqual({ omakase: 2000, support: 1500, independent: 1000 });
    expect(HOST_PLANS.map((plan) => [plan.name, plan.rate])).toEqual([["おまかせ", "20%"], ["サポート", "15%"], ["自分で販売", "10%"]]);
    const stated = ALL.match(/\d+(?:\.\d+)?%/g) ?? [];
    expect([...new Set(stated)].sort()).toEqual(["10%", "15%", "20%"]);
  });
});

describe("the copy", () => {
  it("promises nothing that covers every experience, and shows no track record", () => {
    for (const word of ["必ず", "絶対", "100%", "全額", "24時間前まで", "保証", "実績", "事例", "お客様の声", "利用者の声", "人気"]) expect(ALL, word).not.toContain(word);
  });

  it("has the pieces the issue lists", () => {
    expect(USAGE_PAGE.guests.map((item) => item.title)).toEqual(["取消について", "実施できないとき", "天気について", "連絡とお支払い"]);
    expect(USAGE_PAGE.hosts.map((item) => item.title)).toEqual(["申込みは断れます", "手取りは、一緒に決めます", "取消の扱いは、体験ごとに決めます", "細かいやりとりは任せられます"]);
    expect(HOST_PAGE.title).toBe("あなたの体験を、街の外の人へ。");
    expect(HOST_PAGE.talk).toBe("まず話してみる");
    expect(HOST_PAGE.steps).toHaveLength(4);
    expect(HOST_PAGE.questions.map((item) => item.question)).toHaveLength(5);
    expect(HOST_PLANS.every((plan) => plan.you.length > 0 && plan.niho.length > 0)).toBe(true);
    expect(CONCIERGE_INTRO.examples).toHaveLength(6);
    expect(CONCIERGE_INTRO.steps).toHaveLength(4);
  });

  it("reads the consultation fees from the same constants as the business and school pages", () => {
    expect(CONCIERGE_INTRO.fees).toBe(BUSINESS_GUIDE.fees);
    const text = JSON.stringify(CONCIERGE_INTRO.fees);
    expect(text).toContain("5,000円〜");
    expect(text).toContain("30,000円〜");
  });
});
