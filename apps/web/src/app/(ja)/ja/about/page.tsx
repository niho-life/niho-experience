import type { Metadata } from "next";
import { AboutPage } from "@/components/pages/AboutPage";
import { JA_ABOUT_CONTENT, JA_ABOUT_DESCRIPTION, JA_ABOUT_TITLE } from "@/lib/ja-about";
import { japaneseSiteOwnedAlternates } from "@/lib/locale-metadata";

// 英語の /about と組（言語のボタン・hreflang・sitemap。`SITE_OWNED_PAIRS`）。
export async function generateMetadata(): Promise<Metadata> {
  return { title: JA_ABOUT_TITLE, description: JA_ABOUT_DESCRIPTION, alternates: await japaneseSiteOwnedAlternates("/ja/about") };
}

export default function JapaneseAboutPage() {
  return <AboutPage content={JA_ABOUT_CONTENT} />;
}
