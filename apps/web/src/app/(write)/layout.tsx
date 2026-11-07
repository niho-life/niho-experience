import "../globals.css";
import "./write.css";
import "@niho/experience-presentation/v1/styles.css";
import type { Metadata, Viewport } from "next";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: { default: "記事を書く | NIHO Experience", template: "%s | NIHO Experience" },
  referrer: "no-referrer",
  robots: { index: false, follow: false, noarchive: true, nocache: true },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#ffffff" };

/** Isolated private writer shell. It intentionally has no analytics and no HostSessionKeeper. */
export default function WriteLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-dvh bg-canvas text-ink">
        <a href="#main" className="sr-only focus:not-sr-only">本文へ移動</a>
        {children}
      </body>
    </html>
  );
}
