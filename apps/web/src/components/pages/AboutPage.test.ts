import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/about", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/image", () => ({ default: () => null }));

import { AboutPage } from "./AboutPage";

describe("About page (#645)", () => {
  const html = renderToStaticMarkup(AboutPage());

  it("has one h1 and h2 headings after it", () => {
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("It starts in the town");
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("<h2"));
  });

  it("shows the three captions and the booking steps", () => {
    for (const line of ["Each one hosted by people who live here.", "Everyday life and culture, not sightseeing.", "Small enough for one table and real conversation."]) expect(html).toContain(line);
    expect(html.match(/<li class="flex items-start gap-4 rounded-\[22px\]/g)).toHaveLength(3);
  });

  it("links to the experiences, the help page and hosting", () => {
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(expect.arrayContaining(["/experiences", "/help", "/host"]));
    expect(html).toContain("See the experiences");
    expect(html).toContain("Live in Kamakura?");
  });
});
