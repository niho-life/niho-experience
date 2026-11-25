import { describe, expect, it } from "vitest";
import { bookButtonSnippet, embedBookSnippet, embedBookUrl } from "./embed-snippet";

const ORIGIN = "https://experience.example.test";

describe("embed snippet (#638)", () => {
  it("points the widget URL at /embed with the slug encoded", () => {
    expect(embedBookUrl(ORIGIN, "kamakura-dinner")).toBe(`${ORIGIN}/embed/experiences/kamakura-dinner/book`);
    expect(embedBookUrl(`${ORIGIN}/some/path`, "a b/c")).toBe(`${ORIGIN}/embed/experiences/a%20b%2Fc/book`);
    expect(embedBookUrl("http://localhost:3000", "x")).toBe("http://localhost:3000/embed/experiences/x/book");
  });

  it("hands out nothing for an origin or slug it would not link", () => {
    expect(embedBookUrl("http://experience.example.test", "x")).toBeNull();
    expect(embedBookUrl("not a url", "x")).toBeNull();
    expect(embedBookUrl(ORIGIN, "")).toBeNull();
    expect(embedBookUrl(ORIGIN, "a".repeat(161))).toBeNull();
    expect(embedBookSnippet({ siteOrigin: ORIGIN, slug: "", title: "x" })).toBeNull();
    expect(bookButtonSnippet({ siteOrigin: "ftp://example.test", slug: "x" })).toBeNull();
  });

  it("writes the code of docs/embed.md, checking messages against this site's origin", () => {
    expect(embedBookSnippet({ siteOrigin: ORIGIN, slug: "kamakura-dinner", title: "Kamakura Dinner" })).toBe([
      `<iframe id="niho-exp-book" src="${ORIGIN}/embed/experiences/kamakura-dinner/book"`,
      `  title="Book Kamakura Dinner" loading="lazy" style="width:100%;max-width:520px;height:760px;border:0"></iframe>`,
      `<script>(function(){var f=document.getElementById("niho-exp-book");`,
      `window.addEventListener("message",function(e){`,
      `  if(e.origin!=="${ORIGIN}"||e.source!==f.contentWindow)return;`,
      `  var d=e.data||{};`,
      `  if(d.type==="niho-experience-embed-resize")f.style.height=Math.max(240,Math.ceil(d.height))+"px";`,
      `  if(d.type==="niho-experience-embed-top")f.scrollIntoView({block:"start"});`,
      `});})();</script>`,
    ].join("\n"));
  });

  it("keeps the title attribute whole whatever the title holds", () => {
    const snippet = embedBookSnippet({ siteOrigin: ORIGIN, slug: "x", title: `Tea "&" <b>sweets</b>` })!;
    expect(snippet).toContain(`title="Book Tea &quot;&amp;&quot; &lt;b&gt;sweets&lt;/b&gt;" loading="lazy"`);
    expect(snippet).not.toContain("<b>");
  });

  it("links the button to the public page with the provider's referral mark", () => {
    const snippet = bookButtonSnippet({ siteOrigin: ORIGIN, slug: "kamakura-dinner" })!;
    expect(snippet).toContain(`<a href="${ORIGIN}/experiences/kamakura-dinner?utm_source=provider&amp;utm_medium=referral" target="_blank" rel="noopener"`);
    expect(snippet).toContain(">Book now</a>");
  });
});
