import { describe, expect, it } from "vitest";
import { SAMPLE_GUIDES, type Guide } from "@/content/guides";
import { kamakuraAfter4Pm } from "@/content/guides/kamakura-after-4-pm";
import { HOME_JOURNAL_LIMIT, homeJournal } from "./home-journal";

const [sample] = SAMPLE_GUIDES as [Guide, ...Guide[]];
const synthetic = (slug: string, extra: Partial<Guide> = {}): Guide => ({ ...sample, slug, title: `Synthetic ${slug}`, hero: undefined, ...extra });

describe("home journal", () => {
  it("puts the featured guide first, labels it as an editorial preview and keeps one card per slug", () => {
    const journal = homeJournal([synthetic("a"), kamakuraAfter4Pm, synthetic("b")], { featured: kamakuraAfter4Pm });
    expect(journal.items.map((item) => item.slug)).toEqual(["kamakura-after-4-pm", "a", "b"]);
    expect(journal.items[0]).toMatchObject({ badge: "Editorial preview", topic: { key: "evenings", label: "Evenings" }, image: null });
    expect(journal.items[1]!.badge).toBeNull();
  });

  it("marks drafts, shows only a safe hero path and dates by the check date when there is one", () => {
    const journal = homeJournal([
      synthetic("photo", { hero: { src: "/guides/a.jpg", alt: "A street", width: 3, height: 2, licensed: false }, checkedAt: "2026-10-20", updatedAt: "2026-10-01" }),
      synthetic("unsafe", { hero: { src: "javascript:alert(1)", alt: "x", width: 3, height: 2, licensed: false }, checkedAt: undefined, updatedAt: "2026-10-02" }),
    ], { draftSlugs: ["unsafe"] });
    expect(journal.items[0]).toMatchObject({ image: { src: "/guides/a.jpg", alt: "A street" }, dateKind: "Checked", dateTime: "2026-10-20", badge: null });
    expect(journal.items[1]).toMatchObject({ image: null, dateKind: "Updated", dateTime: "2026-10-02", badge: "Draft" });
  });

  it("lists the shown topics once each, CMS categories in display order before the label", () => {
    const category = (slug: string, displayOrder: number) => ({ category: { slug, label: slug.toUpperCase(), displayOrder } });
    const journal = homeJournal([synthetic("1", category("food", 2)), synthetic("2", category("walks", 1)), synthetic("3", category("food", 2)), synthetic("4", { pillar: undefined })]);
    expect(journal.topics).toEqual([{ key: "walks", label: "WALKS" }, { key: "food", label: "FOOD" }]);
    expect(journal.items[3]!.topic).toBeNull();
  });

  it("keeps pillar topics in the fixed pillar order", () => {
    const journal = homeJournal([synthetic("p", { pillar: "planning" }), synthetic("z", { pillar: "zazen" }), synthetic("e", { pillar: "evenings" })]);
    expect(journal.topics.map((topic) => topic.key)).toEqual(["evenings", "zazen", "planning"]);
  });

  it("stops at the limit and reports that more guides exist", () => {
    const guides = Array.from({ length: HOME_JOURNAL_LIMIT + 2 }, (_, index) => synthetic(`g${index}`));
    const journal = homeJournal(guides);
    expect(journal.items).toHaveLength(HOME_JOURNAL_LIMIT);
    expect(journal.more).toBe(true);
    expect(homeJournal(guides.slice(0, 3)).more).toBe(false);
  });
});
