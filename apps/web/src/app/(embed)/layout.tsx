import "../globals.css";
// The site's fonts (Nunito, Fraunces) are declared here, as in every other root layout: the widget reads like the booking page.
import "@niho/experience-presentation/v1/styles.css";
import type { Metadata, Viewport } from "next";

// The booking widget other sites frame (#638, docs/embed.md). Its own root: no site header or footer, no analytics
// (Umami, GA4), no AttributionCapture and no skip link, and it paints no background, so the host's page shows through.
// Moving between it and the site reloads the whole page.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Book | NIHO Travel",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function EmbedRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-transparent">{children}</body>
    </html>
  );
}
