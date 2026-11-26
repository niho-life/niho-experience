import { EXPERIENCE_API_CONTRACT } from "@niho-experience/api-client";
import type { ReactNode } from "react";
import { EN_STATIC_COPY_V1, PresentationRootV1, RichMessageV1, type StaticCopyAccessorV1 } from "@niho/experience-presentation/v1";
import { PRESENTATION_PRIMITIVES_V1 } from "./PresentationV1";
import { LocalizedLink } from "./LocalizedLink";
import { NavLink } from "./NavLink";
import { SiteMenu } from "./SiteMenu";
import { siteNavigation, type SiteNavigation } from "@/lib/site-nav";
import { privacyFooterLink } from "@/lib/privacy-link";
import { HandIcon, RubberStamp } from "./HandIcon";
import type { SiteLocale } from "@/lib/localized-content";


export type PreviewCatalog = "synthetic" | "pilot";


/**
 * Previews only: one small line at the very bottom of the footer (owner decision 2026-10-20).
 * Synthetic data is invented, pilot data is real but provisional. Nothing here is bookable for real.
 */
export function PreviewNote({ catalog, locale = "en" }: { catalog: PreviewCatalog; locale?: SiteLocale }) {
  return (
    <p role="note" className="border-t border-line py-3 text-xs leading-snug text-muted">
      {locale === "ja" ? (catalog === "pilot" ? (
        <><strong className="font-extrabold text-ink-soft">プレビュー</strong> · 日程と料金は確認用です。残席は実際の在庫ではありません · 予約できません</>
      ) : (
        <><strong className="font-extrabold text-ink-soft">サンプルデータのプレビュー</strong> · ホスト・日程・料金は仮のものです · 予約できません</>
      )) : catalog === "pilot" ? (
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

/** Code-owned header shared by the English and Japanese public layouts. */
export function SiteHeader({
  brandLabel, exploreLabel, hostLabel, copy = EN_STATIC_COPY_V1, languageSwitch, menuLanguage,
  navigation = siteNavigation("en"), signedIn = false,
}: {
  brandLabel?: string; exploreLabel?: string; hostLabel?: string; copy?: StaticCopyAccessorV1;
  languageSwitch?: ReactNode; menuLanguage?: ReactNode; navigation?: SiteNavigation; signedIn?: boolean;
} = {}) {
  const { Image } = PRESENTATION_PRIMITIVES_V1;
  const item = "block rounded-full px-2.5 py-2 whitespace-nowrap hover:bg-sand md:px-3";
  return <header className="sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur-md backdrop-saturate-[1.2]">
    <div className="container-page flex h-16 items-center gap-1.5">
      <LocalizedLink href="/" lang="en" className="flex shrink-0 items-center gap-2 font-display text-xl font-semibold tracking-[-0.01em]">
        <span aria-hidden className="relative size-7 shrink-0 sm:size-8"><Image src="/icon.svg" alt="" sizes="32px" priority className="object-contain" /></span>
        <span className="flex items-baseline gap-1.5">{brandLabel || <RichMessageV1 segments={copy.rich("chrome.brandRich")} emphasisClassName="font-normal text-ink-soft max-[479px]:sr-only" />}</span>
      </LocalizedLink>
      <nav aria-label={copy.text("chrome.main")} className="ml-auto">
        <ul className="flex items-center gap-0.5 text-[0.9375rem] font-bold md:gap-1">
          {navigation.header.map((entry) => <li key={entry.href} className={entry.mobile ? undefined : "max-md:hidden"}>
            <NavLink href={entry.href} className={item}>{entry.short ? <><span className="lg:hidden">{entry.short}</span><span className="max-lg:hidden">{entry.label}</span></>
              : entry.mobile ? exploreLabel || entry.label : entry.label}</NavLink>
          </li>)}
          <li className={signedIn ? "max-lg:hidden" : "max-md:hidden"}>
            <NavLink href={navigation.headerHost.href} prefetch={signedIn ? false : undefined} className={signedIn ? `${item} flex items-center gap-1.5` : `${item} text-sm font-normal text-ink-soft`}>
              {signedIn ? <span aria-hidden className="grid size-7 place-items-center rounded-full bg-leaf-pale"><HandIcon name="house" className="size-4 text-moss" /></span> : null}
              {hostLabel || navigation.headerHost.label}
            </NavLink>
          </li>
        </ul>
      </nav>
      <div className="max-[359px]:hidden">
        {languageSwitch ?? <p className="shrink-0 rounded-full border border-line-strong px-2.5 py-1 text-[0.8125rem] font-extrabold whitespace-nowrap"><span aria-hidden>{copy.text("chrome.localeCurrency")}</span><span className="sr-only">{copy.text("chrome.localeCurrencyLabel")}</span></p>}
      </div>
      <SiteMenu navigation={navigation.mobile} language={menuLanguage} />
    </div>
  </header>;
}

const FOOTER_TEXT = {
  en: { description: "Book small experiences with people who live in Kamakura.", operator: "Made by NIHO, the town’s living room, two minutes from Kamakura Station." },
  ja: { description: "鎌倉に暮らす人が開く、少人数の体験を予約できるサイトです。", operator: "運営：NIHO kamakura（鎌倉駅西口から歩いて2分）" },
};

export function SiteFooter({
  description, copyright, preview = null, copy = EN_STATIC_COPY_V1, locale = "en", groups = siteNavigation(locale).footer, language,
}: {
  description?: string; copyright?: string; preview?: PreviewCatalog | null; copy?: StaticCopyAccessorV1;
  locale?: SiteLocale; groups?: SiteNavigation["footer"]; language?: ReactNode;
} = {}) {
  const { Image } = PRESENTATION_PRIMITIVES_V1;
  const text = FOOTER_TEXT[locale];
  const privacy = privacyFooterLink(locale);
  return <footer className="mt-24 border-t border-line bg-white">
    <div className="container-page">
      <div className="grid gap-8 py-10 lg:grid-cols-[minmax(12rem,1fr)_3fr]">
        <div>
          <LocalizedLink href="/" lang="en" className="inline-flex items-center gap-2 font-display text-xl font-semibold">
            <span aria-hidden className="relative size-7"><Image src="/icon.svg" alt="" sizes="28px" className="object-contain" /></span>
            {copy.text("chrome.brand")}
          </LocalizedLink>
          <p className="mt-2 text-sm text-ink-soft">{description ?? text.description}</p>
          <p className="mt-2 text-sm text-muted">{text.operator}</p>
          <RubberStamp className="mt-3 size-16 rotate-[10deg] text-moss" />
        </div>
        <nav aria-label={copy.text("chrome.footerNavigation")} className={`grid grid-cols-2 gap-x-5 gap-y-6 ${groups.length === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
          {groups.map((group) => <section key={group.label}>
            <h2 className="font-sans text-sm font-bold">{group.label}</h2>
            <ul className="mt-3 grid gap-2 text-sm font-normal text-ink-soft">
              {group.links.map((link) => <li key={link.href}><LocalizedLink href={link.href} className="hover:underline">{link.label}</LocalizedLink></li>)}
            </ul>
          </section>)}
        </nav>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line py-4 text-sm text-ink-soft">
        <p className="mr-auto">{copyright || "© NIHO kamakura"}</p>
        <LocalizedLink href={privacy.href} className="hover:underline">{privacy.label}</LocalizedLink>
        {language}
      </div>
      {preview ? <PreviewNote catalog={preview} locale={locale} /> : null}
    </div>
  </footer>;
}

/** Public chrome is code-owned. Both layouts pass only their language, available destinations and host session state. */
export function CodeSiteChrome({
  children, preview = null, copy = EN_STATIC_COPY_V1, languageSwitch, locale = "en", languageChoices,
  navigation = siteNavigation(locale), signedIn = false,
}: {
  children?: ReactNode; preview?: PreviewCatalog | null; copy?: StaticCopyAccessorV1; languageSwitch?: ReactNode;
  languageChoices?: ReactNode; locale?: SiteLocale; navigation?: SiteNavigation; signedIn?: boolean;
}) {
  return <PresentationRootV1 className="flex min-h-dvh flex-1 flex-col">
    <SiteHeader copy={copy} languageSwitch={languageSwitch} menuLanguage={languageChoices} navigation={navigation} signedIn={signedIn} />
    <main id="main" className="flex-1">{children}</main>
    <SiteFooter preview={preview} copy={copy} locale={locale} groups={navigation.footer} language={languageChoices} />
  </PresentationRootV1>;
}
