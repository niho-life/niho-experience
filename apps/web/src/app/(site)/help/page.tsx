import type { Metadata } from "next";
import { EN_STATIC_COPY_V1, HelpViewV1 } from "@niho/experience-presentation/v1";
import { config } from "@/lib/config";
import { safeNihoHelpUrl } from "@/lib/safe-url";
import { HelpFaq } from "@/components/HelpFaq";
import { englishAlternates } from "@/lib/locale-metadata";

export async function generateMetadata(): Promise<Metadata> {
  return { title: "Booking help", robots: { index: false, follow: true }, alternates: await englishAlternates("/help", false) };
}

/** NIHO's existing public support address. No booking or customer data is put in the email link. */
const supportEmail = "info@niho.life";
const emailHref = `mailto:${supportEmail}?subject=NIHO%20Travel`;

export default async function HelpPage() {
  const helpUrl = safeNihoHelpUrl(config.nihoBookingHelpUrl, config.nihoWebOrigin);
  return <>
    <HelpViewV1 copy={EN_STATIC_COPY_V1} model={{ primaryHref: helpUrl ?? emailHref, primaryLabelKey: helpUrl ? "help.niho" : "help.email", emailHref, emailLabel: supportEmail }} />
    <HelpFaq />
  </>;
}
