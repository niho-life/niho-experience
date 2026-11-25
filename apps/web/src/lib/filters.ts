import type { ExperienceSummaryForSite } from "./experience-types";
import type { ExperienceSiteTheme } from "@niho-experience/api-client";

/** Public listing query parameters only. Booking input never travels in the URL. */
export type SearchParams = Record<string, string | string[] | undefined>;

const MAX_QUERY_LENGTH = 80;
export const EXPERIENCE_SITE_THEMES: readonly ExperienceSiteTheme[] = ["FOOD", "CULTURE", "CRAFT", "OUTDOORS", "LOCAL_LIFE"];
export const EXPERIENCE_THEME_LABELS: Record<ExperienceSiteTheme, string> = {
  FOOD: "Food & drink",
  CULTURE: "Arts & culture",
  CRAFT: "Craft",
  OUTDOORS: "Outdoors",
  LOCAL_LIFE: "Local life",
};

/** Normalize a shareable, public catalog search without forwarding it to the API. */
export function normalizeExperienceQuery(value: string | string[] | undefined): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/gu, " ").slice(0, MAX_QUERY_LENGTH);
}

export function normalizeExperienceTheme(value: string | string[] | undefined): ExperienceSiteTheme | undefined {
  if (typeof value !== "string") return undefined;
  return EXPERIENCE_SITE_THEMES.find((theme) => theme === value);
}

export function normalizeExperienceDate(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
}

/** The list's search rule: every word of the query is somewhere in the text, in any order. An empty query matches. */
export function matchesExperienceQuery(searchable: string, query: string): boolean {
  const terms = normalizeExperienceQuery(query).toLocaleLowerCase("en-US").split(" ").filter(Boolean);
  const text = searchable.toLocaleLowerCase("en-US");
  return terms.every((term) => text.includes(term));
}

/** Search only the public summary fields already returned for the listing. */
export function filterExperienceSummaries(items: ExperienceSummaryForSite[], query: string): ExperienceSummaryForSite[] {
  if (!normalizeExperienceQuery(query)) return items;
  return items.filter((item) => matchesExperienceQuery([item.title, item.lead, item.provider.name, item.region.name].join(" "), query));
}
