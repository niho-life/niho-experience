import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HelpFaq } from "./HelpFaq";

describe("Help common questions (#645)", () => {
  const html = renderToStaticMarkup(HelpFaq());
  it("lists the five questions as details with their answers", () => {
    expect(html).toContain("Common questions");
    expect(html.match(/<details/g)).toHaveLength(5);
    for (const q of ["Do I need an account?", "How do I pay?", "What language is an experience held in?", "Where do we meet?", "How far is Kamakura from Tokyo?"]) expect(html).toContain(q);
    expect(html).toContain("About one hour by train.");
  });
});
