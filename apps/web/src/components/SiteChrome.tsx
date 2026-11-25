import { EXPERIENCE_API_CONTRACT } from "@niho-experience/api-client";
import type { ReactNode } from "react";
import { EN_STATIC_COPY_V1, PresentationRootV1, RichMessageV1, SiteFooterV1, type FooterLinkV1, type StaticCopyAccessorV1 } from "@niho/experience-presentation/v1";
import { PRESENTATION_PRIMITIVES_V1 } from "./PresentationV1";
import { LocalizedLink } from "./LocalizedLink";
import { NavLink } from "./NavLink";
import { SiteMenu, type SiteMenuItem } from "./SiteMenu";
import { siteNav, type SiteNavEntry } from "@/lib/site-nav";
import { SITE_FOOTER_DESCRIPTION } from "@/lib/public-metadata";
import type { SiteLocale } from "@/lib/localized-content";

export type PreviewCatalog = "synthetic" | "pilot";

/**
 * Previews only: one small line at the very bottom of the footer (owner decision 2026-10-20).
 * Synthetic data is invented, pilot data is real but provisional. Nothing here is bookable for real.
 */
export function PreviewNote({ catalog }: { catalog: PreviewCatalog }) {
  return (
    <p role="note" className="border-t border-line py-3 text-xs leading-snug text-muted">
      {catalog === "pilot" ? (
        <>
          <strong className="font-extrabold text-ink-soft">Preview</strong> · schedules and prices are for review; availability is simulated · no real bookings
        </>
      ) : (
        <>
          <strong className="font-extrabold text-ink-soft">Preview with sample data</strong> · hosts, dates and prices are invented · nothing can be booked
        </>
      )}{" "}
      <span className="whitespace-nowrap">
        · API contract {EXPERIENCE_API_CONTRACT.version} ({EXPERIENCE_API_CONTRACT.status})
      </span>
    </p>
  );
}

/**
 * The site header, one component for both languages (#658; `SiteHeaderV1`'s look, code-owned since #645). The tabs come from
 * `siteNav()` (lib/site-nav.ts), the one place where the two languages differ. From md: every "row" and "tabs" entry, then the
 * language button at the right end (the "EN · ¥" pill stays only where there is no Japanese site). Below md only the "row"
 * entry stays; every entry, the language and a link for hosts live in the menu button (`SiteMenu`).
 * Hosts are not in the header row: the menu's last item (`foot`) and the footer/home carry them. `rowEnd` is one extra item
 * from lg (the signed-in host's link). Without `entries` this is the English header, as the old page documents call it.
 */
export function SiteHeader({ brandLabel, exploreLabel, hostLabel, copy = EN_STATIC_COPY_V1, languageSwitch, journalHref, menuLanguage, entries, navLabel, menuLabel, foot, rowEnd }: {
  brandLabel?: string; exploreLabel?: string; hostLabel?: string; copy?: StaticCopyAccessorV1; languageSwitch?: ReactNode; journalHref?: string | null; menuLanguage?: ReactNode;
  entries?: readonly SiteNavEntry[]; navLabel?: string; menuLabel?: string; foot?: SiteMenuItem | null; rowEnd?: ReactNode;
} = {}) {
  const list = entries ?? siteNav("en", { guides: Boolean(journalHref), inquiry: false }).map((entry) => entry.href === "/experiences" ? { ...entry, label: exploreLabel ?? copy.text("chrome.experiences") }
    : entry.href === "/guides" ? { ...entry, href: journalHref ?? entry.href }
    : entry.href === "/help" ? { ...entry, label: copy.text("chrome.help") } : entry);
  const { Image } = PRESENTATION_PRIMITIVES_V1;
  const item = "rounded-full px-2.5 py-2 whitespace-nowrap hover:bg-sand md:px-3";
  return <header className="sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur-md backdrop-saturate-[1.2]">
    <div className="container-page flex h-16 items-center gap-1.5">
      {/* lang="en": the wordmark is the same on the Japanese site, in the brand face (globals.css maps the faces back under [lang="en"]). */}
      <LocalizedLink href="/" lang="en" className="flex shrink-0 items-center gap-2 font-display text-xl font-semibold tracking-[-0.01em]">
        <span aria-hidden className="relative size-7 shrink-0 sm:size-8"><Image src="/icon.svg" alt="" sizes="32px" priority className="object-contain" /></span>
        <span className="flex items-baseline gap-1.5">{brandLabel ? <span>{brandLabel}</span> : <RichMessageV1 segments={copy.rich("chrome.brandRich")} emphasisClassName="font-normal text-ink-soft max-[479px]:sr-only" />}</span>
      </LocalizedLink>
      <nav aria-label={navLabel ?? copy.text("chrome.main")} className="ml-auto">
        <ul className="flex items-center gap-0.5 text-[0.9375rem] font-bold md:gap-1">
          {list.filter((entry) => entry.where !== "menu").map((entry) => <li key={entry.href} className={entry.where === "tabs" ? "max-md:hidden" : undefined}>
            <NavLink href={entry.href} className={item}>{entry.short ? <><span className="lg:hidden">{entry.short}</span><span className="max-lg:hidden">{entry.label}</span></> : entry.label}</NavLink>
          </li>)}
          {rowEnd ? <li className="max-lg:hidden">{rowEnd}</li> : null}
        </ul>
      </nav>
      <div className="max-[359px]:hidden">
        {languageSwitch ?? <p className="shrink-0 rounded-full border border-line-strong px-2.5 py-1 text-[0.8125rem] font-extrabold whitespace-nowrap"><span aria-hidden>{copy.text("chrome.localeCurrency")}</span><span className="sr-only">{copy.text("chrome.localeCurrencyLabel")}</span></p>}
      </div>
      <SiteMenu
        label={menuLabel}
        items={list.map((entry) => ({ href: entry.href, label: entry.menuLabel ?? entry.label }))}
        foot={foot === undefined ? { href: "/host", label: hostLabel || "For hosts" } : foot}
        language={menuLanguage}
      />
    </div>
  </header>;
}

export function SiteFooter({
  description,
  copyright,
  preview = null,
  copy = EN_STATIC_COPY_V1,
  locale = "en",
  links,
}: { description?: string; copyright?: string; preview?: PreviewCatalog | null; copy?: StaticCopyAccessorV1; locale?: SiteLocale; links?: readonly FooterLinkV1[] } = {}) {
  return <SiteFooterV1 primitives={PRESENTATION_PRIMITIVES_V1} copy={copy} description={description ?? (locale === "en" ? SITE_FOOTER_DESCRIPTION : copy.text("chrome.footerDescription"))} copyright={copyright} previewNote={preview ? <PreviewNote catalog={preview} /> : undefined} links={links} />;
}

/** Public chrome is code-owned. Published visual documents never replace it. `footerLinks` adds links after the fixed ones (the guides, while some exist). */
export function CodeSiteChrome({ children, preview = null, copy = EN_STATIC_COPY_V1, languageSwitch, locale = "en", footerLinks, journalHref, menuLanguage }: { children?: ReactNode; preview?: PreviewCatalog | null; copy?: StaticCopyAccessorV1; languageSwitch?: ReactNode; locale?: SiteLocale; footerLinks?: readonly FooterLinkV1[]; journalHref?: string | null; menuLanguage?: ReactNode }) {
  return <PresentationRootV1 className="flex min-h-dvh flex-1 flex-col">
    <SiteHeader copy={copy} languageSwitch={languageSwitch} journalHref={journalHref} menuLanguage={menuLanguage} />
    <main id="main" className="flex-1">{children}</main>
    <SiteFooter preview={preview} copy={copy} locale={locale} links={footerLinks} />
  </PresentationRootV1>;
}
