import "../globals.css";
import "@niho/experience-presentation/v1/styles.css";
import type { Metadata, Viewport } from "next";
import { AnalyticsSetup } from "@/components/Analytics";
import { AttributionCapture } from "@/components/AttributionCapture";
import { analyticsModeForRuntime } from "@/lib/analytics";
import { CodeSiteChrome } from "@/components/SiteChrome";
import { config, isPreview } from "@/lib/config";
import { SITE_DESCRIPTION } from "@/lib/public-metadata";
import { SiteLocaleProvider } from "@/components/SiteLocale";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { getJapaneseStaticCounterparts } from "@/lib/localized-content";
import { availableGuides } from "@/lib/guide-registry";
import { EN_STATIC_COPY_V1 } from "@niho/experience-presentation/v1";

// Every page reads environment settings (indexing, API mode, host sign-up) at
// request time, so the same build can run as preview or production.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(config.siteUrl),
    title: { default: "Meet the people of Kamakura | NIHO Experience", template: "%s | NIHO Experience" },
    description: SITE_DESCRIPTION,
    robots: config.indexingAllowed ? undefined : { index: false, follow: false },
    openGraph: { siteName: "NIHO Experience", type: "website", locale: "en_US" },
    twitter: { card: "summary" },
  };
}

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const analyticsMode = analyticsModeForRuntime(config.apiMode, config.siteUrl, config.umamiWebsiteId);
  let counterparts: Readonly<Record<string, string>> = {};
  try { counterparts = await getJapaneseStaticCounterparts(); } catch { /* no approved JA release: expose no link */ }

  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-white">
          Skip to content
        </a>
        <SiteLocaleProvider locale="en">
          <AnalyticsSetup mode={analyticsMode} websiteId={config.umamiWebsiteId} />
          <AttributionCapture enabled={config.publicApiVersion === "1.2"} />
          <CodeSiteChrome preview={isPreview ? config.mockCatalog : null} copy={EN_STATIC_COPY_V1} languageSwitch={Object.keys(counterparts).length ? <LanguageSwitch counterparts={counterparts} /> : undefined} footerLinks={availableGuides().length ? [{ href: "/guides", label: "Guides" }] : undefined}>
            {children}
          </CodeSiteChrome>
        </SiteLocaleProvider>
      </body>
    </html>
  );
}
