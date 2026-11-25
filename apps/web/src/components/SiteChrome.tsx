import { EXPERIENCE_API_CONTRACT } from "@niho-experience/api-client";
import type { ReactNode } from "react";
import { EN_STATIC_COPY_V1, PresentationRootV1, RichMessageV1, SiteFooterV1, type FooterLinkV1, type StaticCopyAccessorV1 } from "@niho/experience-presentation/v1";
import { PRESENTATION_PRIMITIVES_V1 } from "./PresentationV1";
import { NavLink } from "./NavLink";
import { SiteMenu } from "./SiteMenu";
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
 * The English header (`SiteHeaderV1`'s look, code-owned since #645). From md: Experiences, Journal (only while a guides page
 * exists), About, Help, then the language button at the right end (the "EN · ¥" pill stays only where there is no Japanese site).
 * Below md only Experiences stays in the row; the rest, the language and a link for hosts live in the menu button (`SiteMenu`).
 * Hosts are no longer in the header row: "For hosts" is the menu's last item and the footer/home carry the rest.
 */
export function SiteHeader({ brandLabel, exploreLabel, hostLabel, copy = EN_STATIC_COPY_V1, languageSwitch, journalHref, menuLanguage }: { brandLabel?: string; exploreLabel?: string; hostLabel?: string; copy?: StaticCopyAccessorV1; languageSwitch?: ReactNode; journalHref?: string | null; menuLanguage?: ReactNode } = {}) {
  const experiences = exploreLabel ?? copy.text("chrome.experiences");
  const { Link, Image } = PRESENTATION_PRIMITIVES_V1;
  const item = "rounded-full px-2.5 py-2 hover:bg-sand md:px-3";
  return <header className="sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur-md backdrop-saturate-[1.2]">
    <div className="container-page flex h-16 items-center gap-1.5">
      <Link href="/" className="flex shrink-0 items-center gap-2 font-display text-xl font-semibold tracking-[-0.01em]">
        <span aria-hidden className="relative size-7 shrink-0 sm:size-8"><Image src="/icon.svg" alt="" sizes="32px" priority className="object-contain" /></span>
        <span className="flex items-baseline gap-1.5">{brandLabel ? <span>{brandLabel}</span> : <RichMessageV1 segments={copy.rich("chrome.brandRich")} emphasisClassName="font-normal text-ink-soft max-[479px]:sr-only" />}</span>
      </Link>
      <nav aria-label={copy.text("chrome.main")} className="ml-auto">
        <ul className="flex items-center gap-0.5 text-[0.9375rem] font-bold md:gap-1">
          <li><NavLink href="/experiences" className={item}>{experiences}</NavLink></li>
          {journalHref ? <li className="max-md:hidden"><NavLink href={journalHref} className={item}>Journal</NavLink></li> : null}
          <li className="max-md:hidden"><NavLink href="/about" className={item}>About</NavLink></li>
          <li className="max-md:hidden"><NavLink href="/help" className={item}>{copy.text("chrome.help")}</NavLink></li>
        </ul>
      </nav>
      <div className="max-[359px]:hidden">
        {languageSwitch ?? <p className="shrink-0 rounded-full border border-line-strong px-2.5 py-1 text-[0.8125rem] font-extrabold whitespace-nowrap"><span aria-hidden>{copy.text("chrome.localeCurrency")}</span><span className="sr-only">{copy.text("chrome.localeCurrencyLabel")}</span></p>}
      </div>
      <SiteMenu journalHref={journalHref} hostLabel={hostLabel || "For hosts"} language={menuLanguage} />
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
