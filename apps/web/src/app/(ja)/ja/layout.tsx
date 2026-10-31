import "../../globals.css";
import "@niho/experience-presentation/v1/styles.css";
import type { Metadata, Viewport } from "next";
import { CodeSiteChrome } from "@/components/SiteChrome";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { SiteLocaleProvider } from "@/components/SiteLocale";
import { JapaneseUnavailable } from "@/components/JapaneseUnavailable";
import { config } from "@/lib/config";
import { getPreparedJapaneseStaticRelease } from "@/lib/localized-content";
import { privacyFooterLink } from "@/lib/privacy-link";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  let released = false;
  try { await getPreparedJapaneseStaticRelease(); released = true; } catch { /* fail closed */ }
  return {
    metadataBase: new URL(config.siteUrl),
    title: { default: "NIHO Experience", template: "%s | NIHO Experience" },
    robots: released && config.indexingAllowed ? undefined : { index: false, follow: false },
    openGraph: { siteName: "NIHO Experience", type: "website", locale: "ja_JP" },
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
  return <html lang="ja"><body className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-white">{data.copy.copy.text("chrome.skipToContent")}</a>
      <SiteLocaleProvider locale="ja" releaseId={data.copy.releaseId} values={data.copy.values}>
        <CodeSiteChrome copy={data.copy.copy} locale="ja" languageSwitch={<LanguageSwitch counterparts={data.counterparts} />} footerLinks={[privacyFooterLink("ja")]}>{children}</CodeSiteChrome>
      </SiteLocaleProvider>
    </body></html>;
}
