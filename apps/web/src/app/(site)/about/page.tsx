import type { Metadata } from "next";
import { AboutPage } from "@/components/pages/AboutPage";
import { config } from "@/lib/config";
import { englishAlternates } from "@/lib/locale-metadata";
import { publicMetadata } from "@/lib/public-metadata";

const TITLE = "About NIHO Travel";
const DESCRIPTION = "NIHO Travel is made by NIHO, the town's living room two minutes from Kamakura Station: small experiences hosted by people who live in Kamakura.";

// Indexable like the other public pages (the layout adds noindex while search publishing is off). Paired with /ja/about (`SITE_OWNED_PAIRS`).
export async function generateMetadata(): Promise<Metadata> {
  // The title already carries the site name, so the layout's "| NIHO Travel" template is not added.
  return { ...publicMetadata(TITLE, DESCRIPTION, `${config.siteUrl}/about`), title: { absolute: TITLE }, alternates: await englishAlternates("/about", true) };
}

export default function Page() {
  return <AboutPage />;
}
