import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HostArticleLinksPanel } from "./HostArticleLinksPanel";

describe("HostArticleLinksPanel", () => {
  it("renders a labelled email-only invitation control with a non-submit action", () => {
    const html = renderToStaticMarkup(createElement(HostArticleLinksPanel, { providerId: "provider.synthetic:1" }));
    expect(html).toContain('id="settings-article-invite"');
    expect(html).toContain('aria-labelledby="settings-article-invite"');
    expect(html).toContain('type="email"');
    expect(html).toContain('autoComplete="email"');
    expect(html).toContain('<button type="button"');
    expect(html).toContain("招待する");
    expect(html).not.toContain("nihoUserId");
  });
});
