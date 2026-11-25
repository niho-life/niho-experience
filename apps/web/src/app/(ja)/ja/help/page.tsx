import type { Metadata } from "next";
import { HelpViewV1 } from "@niho/experience-presentation/v1";
import { HELP_QUESTIONS_JA, HelpFaq } from "@/components/HelpFaq";
import { JapaneseUnavailable } from "@/components/JapaneseUnavailable";
import { config } from "@/lib/config";
import { safeNihoHelpUrl } from "@/lib/safe-url";
import { getJapaneseCopy } from "@/lib/localized-content";
import { japaneseStaticMetadata } from "@/lib/locale-metadata";

const supportEmail = "info@niho.life";
const emailHref = `mailto:${supportEmail}?subject=NIHO%20Travel`;

export async function generateMetadata(): Promise<Metadata> {
  try { return await japaneseStaticMetadata("help"); }
  catch { return { title: "Japanese help unavailable", robots: { index: false, follow: false } }; }
}

export default async function JapaneseHelpPage() {
  let data;
  try {
    data = { copy: await getJapaneseCopy() };
  } catch { return <JapaneseUnavailable />; }
  const helpUrl = safeNihoHelpUrl(config.nihoBookingHelpUrl, config.nihoWebOrigin);
  return <>
    <HelpViewV1 copy={data.copy.copy} model={{ primaryHref: helpUrl ?? emailHref, primaryLabelKey: helpUrl ? "help.niho" : "help.email", emailHref, emailLabel: supportEmail }} />
    <HelpFaq questions={HELP_QUESTIONS_JA} title="よくある質問" />
  </>;
}
