import "../../globals.css";
// 日本語の書体（NIHO Sans）は globals.css の html[lang="ja"] が持つ (#615)。日本語の Web フォントは読み込まない。
import "@niho/experience-presentation/v1/styles.css";
import type { Metadata, Viewport } from "next";
import { AttributionCapture } from "@/components/AttributionCapture";
import { CodeSiteChrome, JAPANESE_SITE_DESCRIPTION, SiteHeader } from "@/components/SiteChrome";
import { LanguageButton } from "@/components/site/LanguageButton";
import { SiteLocaleProvider } from "@/components/SiteLocale";
import { JapaneseUnavailable } from "@/components/JapaneseUnavailable";
import { attributionEnabled } from "@/lib/attribution-enabled";
import { config, isPreview } from "@/lib/config";
import { getPreparedJapaneseStaticRelease } from "@/lib/localized-content";
import { groupInquiryOpen } from "@/lib/group-inquiry-links";
import { hostSignedIn } from "@/lib/host/signed-in";
import { loadJapaneseGuides } from "@/lib/ja-guides";
import { siteNav } from "@/lib/site-nav";
import { EXPERIENCE_CATEGORIES } from "@niho-experience/experience-domain";
import { categoryLabel } from "@/lib/experience-categories";
import { HandIcon } from "@/components/HandIcon";
import Link from "next/link";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  let released = false;
  try { await getPreparedJapaneseStaticRelease(); released = true; } catch { /* fail closed */ }
  return {
    metadataBase: new URL(config.siteUrl),
    title: { default: "NIHO Travel", template: "%s | NIHO Travel" },
    robots: released && config.indexingAllowed ? undefined : { index: false, follow: false },
    openGraph: { siteName: "NIHO Travel", type: "website", locale: "ja_JP" },
    twitter: { card: "summary" },
  };
}

export const viewport: Viewport = { themeColor: "#ffffff", width: "device-width", initialScale: 1 };

export default async function JapaneseRootLayout({ children }: { children: React.ReactNode }) {
  let data;
  try {
    data = await getPreparedJapaneseStaticRelease();
  } catch {
    return <html lang="ja"><body><main id="main"><JapaneseUnavailable /></main></body></html>;
  }
  const inquiryOpen = groupInquiryOpen();
  const guidesOpen = (await loadJapaneseGuides()).length > 0;
  const signedIn = await hostSignedIn();
  const header = <SiteHeader
    navLabel="メイン"
    menuLabel="メニュー"
    entries={siteNav("ja", { guides: guidesOpen, inquiry: inquiryOpen })}
    languageSwitch={<LanguageButton counterparts={data.counterparts} />}
    menuLanguage={<LanguageButton counterparts={data.counterparts} variant="text" />}
    foot={signedIn ? { href: "/host/home", label: "ホスト画面" } : { href: "/ja/host", label: "ホストになる" }}
    rowEnd={signedIn ? <Link href="/host/home" prefetch={false} className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 whitespace-nowrap hover:bg-sand md:px-3"><span aria-hidden className="grid size-7 place-items-center rounded-full bg-leaf-pale"><HandIcon name="house" className="size-4 text-moss" /></span><span>ホスト画面</span></Link> : null}
  />;
  const footerLinks = [
    { href: "/ja/about", label: "NIHOについて" },
    ...(guidesOpen ? [{ href: "/ja/guides", label: "読みもの" }] : []),
    ...(inquiryOpen ? [{ href: "/ja/inquiry", label: "ご相談" }, { href: "/ja/business", label: "企業・学校の方へ" }] : []),
    { href: "/host/auth/sign-in", label: "ホストログイン" },
  ];
  const categories = EXPERIENCE_CATEGORIES.map(({ id }) => ({ href: `/ja/experiences?category=${id}`, label: categoryLabel(id, "ja") }));
  return <html lang="ja"><body className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-white">{data.copy.copy.text("chrome.skipToContent")}</a>
      <SiteLocaleProvider locale="ja" releaseId={data.copy.releaseId} values={data.copy.values}>
        <AttributionCapture enabled={attributionEnabled()} />
        <CodeSiteChrome locale="ja" copy={data.copy.copy} header={header} preview={isPreview ? config.mockCatalog : null}
          footerBrandLabel="NIHO Travel 鎌倉" footerDescription={JAPANESE_SITE_DESCRIPTION} footerLinks={footerLinks}
          footerFixedLinks={[
            { href: "/ja/experiences", label: data.copy.copy.text("chrome.footerExperiences") },
            { href: "/ja/host", label: data.copy.copy.text("chrome.footerHost") },
            { href: "/ja/help", label: data.copy.copy.text("chrome.footerBookingHelp") },
          ]}
          footerCategoryLinks={categories} categoryNavigationLabel="カテゴリー" footerNavigationLabel={data.copy.copy.text("chrome.footerNavigation")}
          footerExtras={[<LanguageButton key="language" counterparts={data.counterparts} variant="text" />, <Link key="privacy" href="/privacy" className="hover:underline">プライバシー</Link>]}>
          {children}
        </CodeSiteChrome>
      </SiteLocaleProvider>
    </body></html>;
}
