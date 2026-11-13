import { EXPERIENCE_API_CONTRACT } from "@niho-experience/api-client";
import type { ReactNode } from "react";
import { EN_STATIC_COPY_V1, PresentationRootV1, RichMessageV1, SiteFooterV1, type FooterLinkV1, type StaticCopyAccessorV1 } from "@niho/experience-presentation/v1";
import { PRESENTATION_PRIMITIVES_V1 } from "./PresentationV1";
import { NavLink } from "./NavLink";
import { SITE_DESCRIPTION } from "@/lib/public-metadata";
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
 * The English header. Since #562 the language button sits at its right end, in place of the "EN · ¥" pill and the row above the
 * header (a link to the Japanese page; the pill stays only where there is no Japanese site). Everything else is the presentation's
 * `SiteHeaderV1` markup, kept the same.
 */
export function SiteHeader({ brandLabel, exploreLabel, hostLabel, copy = EN_STATIC_COPY_V1, languageSwitch }: { brandLabel?: string; exploreLabel?: string; hostLabel?: string; copy?: StaticCopyAccessorV1; languageSwitch?: ReactNode } = {}) {
  const experiences = exploreLabel ?? copy.text("chrome.experiences");
  const { Link, Image } = PRESENTATION_PRIMITIVES_V1;
  return <header className="sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur-md backdrop-saturate-[1.2]">
    <div className="container-page flex h-16 items-center gap-1.5">
      <Link href="/" className="flex shrink-0 items-center gap-2 font-display text-xl font-semibold tracking-[-0.01em]">
        <span aria-hidden className="relative size-7 shrink-0 sm:size-8"><Image src="/icon.svg" alt="" sizes="32px" priority className="object-contain" /></span>
        <span className="flex items-baseline gap-1.5">{brandLabel ? <span>{brandLabel}</span> : <RichMessageV1 segments={copy.rich("chrome.brandRich")} emphasisClassName="font-normal text-ink-soft max-[479px]:sr-only" />}</span>
      </Link>
      <nav aria-label={copy.text("chrome.main")} className="ml-auto">
        <ul className="flex items-center gap-0.5 text-[0.9375rem] font-bold sm:gap-1">
          <li><NavLink href="/experiences" className="rounded-full px-2.5 py-2 hover:bg-sand sm:px-3">{experiences}</NavLink></li>
          <li className="hidden sm:block"><Link href="/host" className="rounded-full px-3 py-2 hover:bg-sand">{hostLabel || copy.text("chrome.host")}</Link></li>
          <li className="hidden sm:block"><Link href="/help" className="rounded-full px-3 py-2 hover:bg-sand">{copy.text("chrome.help")}</Link></li>
        </ul>
      </nav>
      {languageSwitch ?? <p className="shrink-0 rounded-full border border-line-strong px-2.5 py-1 text-[0.8125rem] font-extrabold whitespace-nowrap"><span aria-hidden>{copy.text("chrome.localeCurrency")}</span><span className="sr-only">{copy.text("chrome.localeCurrencyLabel")}</span></p>}
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
  return <SiteFooterV1 primitives={PRESENTATION_PRIMITIVES_V1} copy={copy} description={description ?? (locale === "en" ? SITE_DESCRIPTION : copy.text("chrome.footerDescription"))} copyright={copyright} previewNote={preview ? <PreviewNote catalog={preview} /> : undefined} links={links} />;
}

/** Public chrome is code-owned. Published visual documents never replace it. `footerLinks` adds links after the fixed ones (the guides, while some exist). */
export function CodeSiteChrome({ children, preview = null, copy = EN_STATIC_COPY_V1, languageSwitch, locale = "en", footerLinks }: { children?: ReactNode; preview?: PreviewCatalog | null; copy?: StaticCopyAccessorV1; languageSwitch?: ReactNode; locale?: SiteLocale; footerLinks?: readonly FooterLinkV1[] }) {
  return <PresentationRootV1 className="flex min-h-dvh flex-1 flex-col">
    <SiteHeader copy={copy} languageSwitch={languageSwitch} />
    <main id="main" className="flex-1">{children}</main>
    <SiteFooter preview={preview} copy={copy} locale={locale} links={footerLinks} />
  </PresentationRootV1>;
}
