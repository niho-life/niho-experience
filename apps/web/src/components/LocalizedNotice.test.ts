import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EN_STATIC_COPY_V1 } from "@niho/experience-presentation/v1";
import { JA_STATIC_COPY_V1 } from "@/lib/ja-static-copy";
import { Notice } from "./ui";
import { SiteLocaleProvider } from "./SiteLocale";

// Children go as createElement's own argument (lint), so the props are typed without them.
const japanese = { locale: "ja", values: JA_STATIC_COPY_V1 } as ComponentProps<typeof SiteLocaleProvider>;
const notice = (tone: "info" | "warn" | "danger" | "success", extra: Record<string, unknown> = {}) =>
  createElement(Notice, { tone, title: "タイトル", ...extra }, "本文");

describe("Notice labels follow the page's language (#59)", () => {
  it("says お知らせ / ご注意 / 問題 / 完了 on a Japanese page, never the English label", () => {
    for (const [tone, label, english] of [["info", "お知らせ", "Note"], ["warn", "ご注意", "Heads up"], ["danger", "問題", "Problem"], ["success", "完了", "Done"]] as const) {
      const html = renderToStaticMarkup(createElement(SiteLocaleProvider, japanese, notice(tone)));
      expect(html, tone).toContain(label);
      expect(html, tone).not.toContain(english);
    }
  });

  it("keeps the English labels on the English site, and lets an explicit copy win", () => {
    expect(renderToStaticMarkup(notice("info"))).toContain("Note");
    expect(renderToStaticMarkup(notice("warn"))).toContain("Heads up");
    const html = renderToStaticMarkup(createElement(SiteLocaleProvider, japanese, notice("info", { copy: EN_STATIC_COPY_V1 })));
    expect(html).toContain("Note");
  });
});
