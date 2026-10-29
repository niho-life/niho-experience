import "../../globals.css";
// Same stylesheet as the traveler root: it carries the @font-face rules for
// Fraunces / Nunito (the presentation rules themselves are scoped to .nexp-v1).
import "@niho/experience-presentation/v1/styles.css";
import Script from "next/script";
import type { Metadata, Viewport } from "next";
import { HostPwaRegistrar } from "@/components/host/HostPwaRegistrar";
import { config } from "@/lib/config";
import { HOST_APP_ICONS, HOST_APP_SHORT_NAME, HOST_APP_THEME_COLOR } from "@/lib/host/pwa";
import { HOST_MANIFEST_PATH } from "@/lib/host/routes";

// The host console (#86) has its own root: Japanese, no analytics, no site chrome,
// never indexed. Moving between it and the traveler site reloads the whole page.
export const dynamic = "force-dynamic";

/**
 * Read per request: HOST_PWA_ENABLED (#177) adds the app's manifest and icons here, and only here,
 * so traveler pages never link them. The icons replace the site's file-based ones (app/icon.svg
 * keeps the browser tab's). No viewportFit: the console's top edge stays as it is.
 */
export async function generateMetadata(): Promise<Metadata> {
  const base: Metadata = {
    title: { default: "ホスト | NIHO Experience", template: "%s | NIHO Experience ホスト" },
    robots: { index: false, follow: false },
  };
  if (!config.hostPwaEnabled) return base;
  return {
    ...base,
    manifest: HOST_MANIFEST_PATH,
    appleWebApp: { capable: true, title: HOST_APP_SHORT_NAME, statusBarStyle: "default" },
    icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }], apple: [{ url: HOST_APP_ICONS.apple, sizes: "180x180", type: "image/png" }] },
  };
}

export const viewport: Viewport = {
  themeColor: HOST_APP_THEME_COLOR,
  width: "device-width",
  initialScale: 1,
};

export default function HostRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(()=>{const p=location.pathname;if(!/^\\/host\\/invitations\\/[0-9a-f-]{36}$/i.test(p))return;const h=location.hash;try{if(h.length>1&&h.length<=129)Object.defineProperty(window,"__nihoOperatorInvitationSecret",{value:h.slice(1),writable:true,configurable:true});}finally{if(h)history.replaceState(history.state,"",p+location.search);}})();` }} />
      </head>
      <body className="flex min-h-dvh flex-col bg-canvas">
        <Script src="/host-history-guard.js" strategy="beforeInteractive" />
        <HostPwaRegistrar enabled={config.hostPwaEnabled} />
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-white">
          本文へ移動
        </a>
        {children}
      </body>
    </html>
  );
}
