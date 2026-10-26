import { describe, expect, it } from "vitest";
import { articleJsonLd, serializeJsonLd } from "./structured-data";

const guide = {
  slug: "kamakura-after-4-pm",
  title: "Kamakura After 4 PM",
  description: "How to spend a Kamakura evening.",
  hero: "/guides/media/dusk.jpg",
  published: "2026-11-10",
  updated: "2026-11-12",
  author: "Sample Author",
  authorRole: "Founder, NIHO kamakura",
};

describe("articleJsonLd", () => {
  it("describes a guide with its byline, dates and the site as publisher", () => {
    expect(articleJsonLd(guide, "https://experiences.example", "NIHO Experience", "Evenings in Kamakura")).toEqual({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "Kamakura After 4 PM",
      description: "How to spend a Kamakura evening.",
      image: ["https://experiences.example/guides/media/dusk.jpg"],
      datePublished: "2026-11-10",
      dateModified: "2026-11-12",
      author: { "@type": "Person", name: "Sample Author", jobTitle: "Founder, NIHO kamakura" },
      publisher: { "@type": "Organization", "@id": "https://experiences.example/#organization", name: "NIHO Experience", url: "https://experiences.example/" },
      mainEntityOfPage: { "@type": "WebPage", "@id": "https://experiences.example/guides/kamakura-after-4-pm" },
      url: "https://experiences.example/guides/kamakura-after-4-pm",
      inLanguage: "en",
      articleSection: "Evenings in Kamakura",
    });
  });

  it("keeps an https hero as is and escapes markup when embedded", () => {
    const data = articleJsonLd({ ...guide, hero: "https://images.example/dusk.jpg", title: "</script><b>" }, "https://experiences.example", "NIHO Experience", "Evenings in Kamakura");
    expect(data.image).toEqual(["https://images.example/dusk.jpg"]);
    expect(serializeJsonLd(data)).not.toContain("</script>");
  });
});
