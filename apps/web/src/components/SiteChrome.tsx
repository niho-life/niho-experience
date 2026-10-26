import { EXPERIENCE_API_CONTRACT } from "@niho-experience/api-client";
import type { ReactNode } from "react";
import { EN_STATIC_COPY_V1, PresentationRootV1, SiteFooterV1, SiteHeaderV1, type FooterLinkV1, type StaticCopyAccessorV1 } from "@niho/experience-presentation/v1";
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
          <strong className="font-extrabold text-ink-soft">Preview</strong> · real hosts; dates, prices and photos are provisional · nothing can be booked
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

export function SiteHeader({ brandLabel, exploreLabel, hostLabel, copy = EN_STATIC_COPY_V1, languageSwitch }: { brandLabel?: string; exploreLabel?: string; hostLabel?: string; copy?: StaticCopyAccessorV1; languageSwitch?: ReactNode } = {}) {
  const experiences = exploreLabel ?? copy.text("chrome.experiences");
  return <>{languageSwitch ? <div className="border-b border-line bg-sand"><div className="container-page flex justify-end py-1.5">{languageSwitch}</div></div> : null}<SiteHeaderV1 primitives={PRESENTATION_PRIMITIVES_V1} copy={copy} labels={{ brand: brandLabel, experiences, host: hostLabel }} experiencesLink={<NavLink href="/experiences" className="rounded-full px-2.5 py-2 hover:bg-sand sm:px-3">{experiences}</NavLink>} /></>;
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
