import type { SiteLocale } from "./localized-content";

/**
 * The header's tabs for both languages (#658). The header is one component (`SiteHeader`); what differs by language is
 * written here and nowhere else (owner decision 2026-11-25: the two sites share their layout, and differ only on purpose).
 *
 * `where`: "row" stays in the header row at every width, "tabs" joins the row from md, "menu" is only in the menu below md.
 * Every entry is in the menu. `short` replaces the label in the row below lg; `menuLabel` replaces it in the menu.
 * A page that does not exist yet is not listed (`guides`: a guides page exists; `inquiry`: group inquiries are open).
 */
export type SiteNavEntry = Readonly<{ href: string; label: string; short?: string; menuLabel?: string; where: "row" | "tabs" | "menu" }>;

export function siteNav(locale: SiteLocale, has: Readonly<{ guides: boolean; inquiry: boolean }>): SiteNavEntry[] {
  if (locale === "ja") return [
    { href: "/ja/experiences", label: "体験をさがす", short: "さがす", where: "row" },
    ...(has.guides ? [{ href: "/ja/guides", label: "読みもの", where: "tabs" } as const] : []),
    { href: "/ja/about", label: "NIHOについて", where: "tabs" },
    // 日本語だけ：企業・学校とご相談。英語には相手のページが無い（意図した差）。
    ...(has.inquiry ? [
      { href: "/ja/business", label: "企業・学校", menuLabel: "企業・学校の方へ", where: "tabs" } as const,
      { href: "/ja/inquiry", label: "ご相談", where: "menu" } as const,
    ] : []),
    { href: "/ja/help", label: "ヘルプ", where: "tabs" },
  ];
  return [
    { href: "/experiences", label: "Experiences", where: "row" },
    ...(has.guides ? [{ href: "/guides", label: "Journal", where: "tabs" } as const] : []),
    { href: "/about", label: "About", where: "tabs" },
    { href: "/help", label: "Help", where: "tabs" },
  ];
}
