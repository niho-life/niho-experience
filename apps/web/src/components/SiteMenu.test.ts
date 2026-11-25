import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/ja", useSearchParams: () => new URLSearchParams() }));

import { defaultStaticCopyValuesV1 } from "@niho/experience-presentation/v1";
import { SiteLocaleProvider } from "./SiteLocale";
import { SiteMenu } from "./SiteMenu";

const render = (props: Parameters<typeof SiteMenu>[0]) => renderToStaticMarkup(createElement(SiteLocaleProvider, { locale: "en", releaseId: "r", values: defaultStaticCopyValuesV1() } as never, createElement(SiteMenu, props)));

describe("SiteMenu (#645, #658)", () => {
  it("renders the items in order, then the language row, then the quiet foot link", () => {
    const html = render({ items: [{ href: "/a", label: "Alpha" }, { href: "/b", label: "Beta" }], foot: { href: "/f", label: "Foot" }, language: createElement("a", { href: "/x" }, "Lang") });
    const rows = [...html.matchAll(/<li([^>]*)>(.*?)<\/li>/g)].map((m) => m[2]!.replace(/<[^>]*>/g, ""));
    expect(rows).toEqual(["Alpha", "Beta", "Lang", "Foot"]);
    expect(html).toContain('href="/f"');
    expect(html).toContain("text-ink-soft");
    expect(html).toContain("empty:hidden");
  });

  it("names the button and the nav with `label` (default Menu) and leaves out the foot when none is given", () => {
    const html = render({ items: [{ href: "/a", label: "Alpha" }], label: "メニュー" });
    expect(html.match(/aria-label="メニュー"/g)).toHaveLength(2);
    expect(html.match(/<li/g)).toHaveLength(1);
    expect(render({ items: [] })).toContain('aria-label="Menu"');
  });
});
