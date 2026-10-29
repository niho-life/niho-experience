import "../../globals.css";
import "./editor.css";
import type { Metadata, Viewport } from "next";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: { default: "記事 | NIHO Experience", template: "%s | NIHO Experience" },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { themeColor: "#ffffff", width: "device-width", initialScale: 1 };

export default function EditorLayout({ children }: { children: React.ReactNode }) {
  return <html lang="ja"><body className="min-h-dvh bg-canvas"><a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-white">本文へ移動</a>{children}</body></html>;
}
