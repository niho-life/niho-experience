import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteLocaleProvider, useSiteCopy } from "@/components/SiteLocale";
import { createJapaneseCopy } from "./ja-copy";
import { JA_STATIC_COPY_V1 } from "./ja-static-copy";

const japanese = { locale: "ja", values: JA_STATIC_COPY_V1 } as ComponentProps<typeof SiteLocaleProvider>;
const english = { locale: "en" } as ComponentProps<typeof SiteLocaleProvider>;

describe("the Japanese copy accessor (#59)", () => {
  it("turns the presentation package's English nouns into 日程, whoever served the values", () => {
    const copy = createJapaneseCopy(JA_STATIC_COPY_V1);
    expect(copy.text("booking.showMoreDates", { count: 1, noun: "date" })).toBe("さらに1件の日程を表示");
    expect(copy.text("booking.showMoreDates", { count: 4, noun: "dates" })).toBe("さらに4件の日程を表示");
    expect(copy.text("home.hostFeatureCta", { name: "陶房" })).toBe("陶房の工房を見る");
  });

  it("is what Japanese pages read in the browser too: the locale context builds it for ja only", () => {
    const Probe = ({ label }: { label: string }) => createElement("p", null, `${label}: ${useSiteCopy().text("booking.showMoreDates", { count: 2, noun: "dates" })}`);
    expect(renderToStaticMarkup(createElement(SiteLocaleProvider, japanese, createElement(Probe, { label: "ja" })))).toContain("さらに2件の日程を表示");
    // English keeps its own copy and its own nouns.
    expect(renderToStaticMarkup(createElement(SiteLocaleProvider, english, createElement(Probe, { label: "en" })))).toContain("Show 2 more dates");
  });
});
