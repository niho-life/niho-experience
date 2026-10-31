import type { Metadata } from "next";
import { PrivacyNotice } from "@/components/PrivacyNotice";
import { config } from "@/lib/config";
import { PRIVACY_PATH } from "@/lib/privacy-link";

// Indexable like the other public pages: the layout adds noindex while search publishing is off. English only, no Japanese pair.
export function generateMetadata(): Metadata {
  return {
    title: "Privacy",
    description: "What we keep when you book an experience or ask a host a question on this site, who handles it, and for how long.",
    alternates: { canonical: `${config.siteUrl}${PRIVACY_PATH}` },
  };
}

/** The traveler privacy notice (#285). NIHO's privacy policy is linked only while EXPERIENCE_PRIVACY_POLICY_URL is set. */
export default function PrivacyPage() {
  return <PrivacyNotice policyUrl={config.privacyPolicyUrl} />;
}
