import "../../globals.css";
// 日本語の書体（NIHO Sans）は globals.css の html[lang="ja"] が持つ (#670)。日本語の Web フォントは読み込まない。
import "@niho/experience-presentation/v1/styles.css";
import type { Metadata, Viewport } from "next";
import { AttributionCapture } from "@/components/AttributionCapture";
import { CodeSiteChrome } from "@/components/SiteChrome";
import { LanguageButton } from "@/components/site/LanguageButton";
import { SiteLocaleProvider } from "@/components/SiteLocale";
import { JapaneseUnavailable } from "@/components/JapaneseUnavailable";
import { attributionEnabled } from "@/lib/attribution-enabled";
import { config, isPreview } from "@/lib/config";
import { getPreparedJapaneseStaticRelease } from "@/lib/localized-content";
import { groupInquiryOpen } from "@/lib/group-inquiry-links";
import { hostSignedIn } from "@/lib/host/signed-in";
import { loadJapaneseGuides } from "@/lib/ja-guides";
import { siteNavigation } from "@/lib/site-nav";
import { loadSiteCategories } from "@/lib/site-categories";

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
  const [guides, signedIn, categories] = await Promise.all([loadJapaneseGuides(), hostSignedIn(), loadSiteCategories("ja")]);
  const navigation = siteNavigation("ja", { guides: guides.length > 0, inquiry: groupInquiryOpen(), categories, signedIn });
  return <html lang="ja"><body className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-white">{data.copy.copy.text("chrome.skipToContent")}</a>
      <SiteLocaleProvider locale="ja" releaseId={data.copy.releaseId} values={data.copy.values}>
        <AttributionCapture enabled={attributionEnabled()} />
        <CodeSiteChrome locale="ja" copy={data.copy.copy} preview={isPreview ? config.mockCatalog : null}
          navigation={navigation} signedIn={signedIn}
          languageSwitch={<LanguageButton counterparts={data.counterparts} />}
          languageChoices={<LanguageButton counterparts={data.counterparts} variant="choices" />}>
          {children}
        </CodeSiteChrome>
      </SiteLocaleProvider>
    </body></html>;
}
