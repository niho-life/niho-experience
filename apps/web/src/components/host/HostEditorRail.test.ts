import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HostEditorRail, ListingSteps } from "./HostEditorRail";

const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("ListingSteps", () => {
  it("separates the mock self-publication flow from the legacy HTTP review flow", () => {
    const mock = words(renderToStaticMarkup(createElement(ListingSteps, { status: "draft" })));
    expect(mock).toContain("下書き");
    expect(mock).toContain("公開中");
    expect(mock).not.toContain("審査");

    const legacy = words(renderToStaticMarkup(createElement(ListingSteps, { status: "review", flow: "legacy-review" })));
    expect(legacy).toContain("下書き");
    expect(legacy).toContain("審査");
    expect(legacy).toContain("掲載中");
  });

  const rail = (status: "draft" | "live" | "paused", owner: boolean, requirements: string[] = [], settingsHref?: string) => renderToStaticMarkup(createElement(HostEditorRail, {
    listing: { status, ...(status === "draft" ? {} : { liveSince: "2026-10-12" }) },
    requirements,
    settingsHref,
    dirty: false,
    owner,
    consent: false,
    onConsent: () => undefined,
    actions: { onPublish: () => undefined, onPause: () => undefined },
    publicPath: "/experiences/sample",
    publicUrl: status === "live" ? "https://example.test/experiences/sample" : null,
    offers: [],
    onOffers: () => undefined,
    lang: "en",
    englishBehind: false,
    language: "en",
    onLanguage: () => undefined,
    today: "2026-10-21",
  }));

  it("shows self-publication controls only to the owner and keeps blockers closed", () => {
    const ready = rail("draft", true);
    expect(words(ready)).toContain("掲載の条件に同意する");
    expect(words(ready)).toContain("同意して公開");
    expect(ready).toMatch(/<button[^>]*disabled=""[^>]*>同意して公開<\/button>/);

    const blocked = words(rail("draft", true, ["売上受取口座", "提供者規約への同意"]));
    expect(blocked).toContain("売上受取口座");
    expect(blocked).toContain("提供者規約への同意");
    expect(blocked).not.toContain("掲載の条件に同意する");

    const editor = words(rail("draft", false));
    expect(editor).toContain("公開・停止・再開はオーナーが行います");
    expect(editor).not.toContain("同意して公開");
  });

  it("links to the selected provider's settings only for provider or account blockers", () => {
    const href = "/host/settings?providerId=sample-provider#settings-payout";
    const blocked = rail("draft", true, ["売上受取口座"], href);
    expect(words(blocked)).toContain("設定で確認する");
    expect(blocked).toContain(`href="${href.replace("&", "&amp;")}"`);

    expect(words(rail("draft", true, ["表紙写真"]))).not.toContain("設定で確認する");
  });

  it("requires fresh consent to resume and hides live stop from a non-owner", () => {
    const paused = rail("paused", true);
    expect(words(paused)).toContain("同意して公開を再開");
    expect(paused).toMatch(/<button[^>]*disabled=""[^>]*>同意して公開を再開<\/button>/);

    expect(words(rail("live", true))).toContain("公開を停止する");
    const editor = words(rail("live", false));
    expect(editor).toContain("公開の停止はオーナーが行います");
    expect(editor).not.toContain("公開を停止する");
  });
});
