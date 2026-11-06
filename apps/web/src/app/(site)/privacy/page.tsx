import type { Metadata } from "next";
import { PrivacyNotice } from "@/components/PrivacyNotice";
import { config } from "@/lib/config";
import { getPublicSiteAnalyticsSettings } from "@/lib/public-site-analytics";
import { PRIVACY_PATH } from "@/lib/privacy-link";

// Indexable like the other public pages: the layout adds noindex while search publishing is off. English only, no Japanese pair.
export function generateMetadata(): Metadata {
  return {
    title: "Privacy",
    description: "What we keep when you book an experience or ask a host a question on this site, or book through a partner site, who handles it, and for how long.",
    alternates: { canonical: `${config.siteUrl}${PRIVACY_PATH}` },
  };
}

/** The traveler privacy notice (#285). NIHO's privacy policy is linked only while EXPERIENCE_PRIVACY_POLICY_URL is set. */
export default async function PrivacyPage() {
  // The visit-count section is shown only while the GA4 tag can load (a measurement ID from NIHO's public settings): it describes what the code does.
  const settings = await getPublicSiteAnalyticsSettings();
  return <PrivacyNotice policyUrl={config.privacyPolicyUrl} analytics={Boolean(settings?.ga4MeasurementId)} />;
}
