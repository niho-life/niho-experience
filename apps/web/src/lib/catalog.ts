import "server-only";
import type { ExperienceApiClient } from "@niho-experience/api-client";
import type { ExperienceDetailForSite, ExperienceSummaryForSite } from "./experience-types";
import { config } from "./config";
import { getPublicationDetail } from "./experience/publication-site";

/**
 * Reads the public detail of every listed experience in parallel, for card data the
 * summary does not carry (hosts, weekdays, capacity). HTTP reads use the Experience
 * publication store. A failed read is left out of the map so
 * the caller can still render that card from its summary.
 */
export async function loadDetails(api: ExperienceApiClient, summaries: ExperienceSummaryForSite[], useV11 = false, locale: "en" | "ja" = "en", releaseId?: string): Promise<Map<string, ExperienceDetailForSite>> {
  const results = await Promise.all(
    summaries.map(async (summary) => {
      try {
        if (config.apiMode === "http") return await getPublicationDetail(summary.slug, locale);
        if (locale === "ja") {
          const result = await api.getJapaneseExperience(summary.slug);
          return result.ok && result.data.releaseId === releaseId ? result.data.experience : null;
        }
        const result = useV11 ? await api.getExperienceV11(summary.slug) : await api.getExperience(summary.slug);
        return result.ok ? result.data.experience : null;
      } catch {
        return null;
      }
    }),
  );
  const details = new Map<string, ExperienceDetailForSite>();
  for (const detail of results) if (detail) details.set(detail.slug, detail);
  return details;
}
