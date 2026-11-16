"use client";

import { ANALYTICS_PREFERENCES_EVENT } from "@/lib/ga4-consent";

export function AnalyticsPrivacyControl() {
  return (
    <button
      type="button"
      className="font-bold text-moss underline underline-offset-4"
      onClick={() => window.dispatchEvent(new Event(ANALYTICS_PREFERENCES_EVENT))}
    >
      Change analytics settings
    </button>
  );
}
