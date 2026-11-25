import type { Metadata } from "next";
import { AboutPage } from "@/components/pages/AboutPage";
import { JA_ABOUT_CONTENT, JA_ABOUT_DESCRIPTION, JA_ABOUT_TITLE } from "@/lib/ja-about";

export const metadata: Metadata = { title: JA_ABOUT_TITLE, description: JA_ABOUT_DESCRIPTION };

export default function JapaneseAboutPage() {
  return <AboutPage content={JA_ABOUT_CONTENT} />;
}
