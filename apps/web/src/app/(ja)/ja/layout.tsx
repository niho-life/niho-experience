import "../../globals.css";
import "@niho/experience-presentation/v1/styles.css";
// 見出しの書体 (#612): 丸ゴシックの 700 だけ（unicode-range で分割。使う字を含む分だけ読み込まれる）。上のスタイルのあとに読む。
// 500 は入れない: 1つの太さにそろえて、トップの初回に読み込む日本語フォントを抑える（PR #612 の測定）。
import "@fontsource/zen-maru-gothic/700.css";
import "./ja-type.css";
import type { Metadata, Viewport } from "next";
import { AttributionCapture } from "@/components/AttributionCapture";
import { JapaneseSiteChrome } from "@/components/site/JapaneseSiteChrome";
import { SiteLocaleProvider } from "@/components/SiteLocale";
import { JapaneseUnavailable } from "@/components/JapaneseUnavailable";
import { attributionEnabled } from "@/lib/attribution-enabled";
import { config } from "@/lib/config";
import { getPreparedJapaneseStaticRelease } from "@/lib/localized-content";
import { groupInquiryOpen } from "@/lib/group-inquiry-links";
import { hostSignedIn } from "@/lib/host/signed-in";
import { loadJapaneseGuides } from "@/lib/ja-guides";

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
        <AttributionCapture enabled={attributionEnabled()} />
        <JapaneseSiteChrome counterparts={data.counterparts} hostSignedIn={await hostSignedIn()} inquiryOpen={groupInquiryOpen()} guidesOpen={(await loadJapaneseGuides()).length > 0}>{children}</JapaneseSiteChrome>
      </SiteLocaleProvider>
    </body></html>;
}
