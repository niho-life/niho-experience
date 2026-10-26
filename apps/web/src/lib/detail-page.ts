import type { Occurrence } from "@niho-experience/api-client";
import { nextBookableDays } from "./date-filter";

export const DETAIL_NEXT_DATE_COUNT = 4;

type FromTokyoLineValues = Readonly<{ region: string; station?: string; walkMinutes?: number }>;

/**
 * Page-owned copy. This deliberately stays outside the static-copy v1 registry:
 * adding a required registry key would invalidate already-published Japanese releases.
 */
export const DETAIL_PAGE_COPY = {
  en: {
    "detail.fromTokyoLine": ({ region, station, walkMinutes }: FromTokyoLineValues) =>
      `${region} · 1 hour from Tokyo${station && walkMinutes ? ` · ${walkMinutes}-minute walk from ${station}` : ""}`,
  },
  ja: {
    "detail.fromTokyoLine": ({ region, station, walkMinutes }: FromTokyoLineValues) =>
      `${region}・東京から1時間${station && walkMinutes ? `・${station}から徒歩${walkMinutes}分` : ""}`,
  },
} as const;

type PublicAccess = Readonly<{ station: string; walkMinutes: number }>;

/**
 * Extract only an explicitly named station and an explicit walking duration.
 * Generic phrases such as "the nearest station" intentionally do not match.
 */
export function publicStationAccess(accessNote: string | null | undefined, locale: "en" | "ja"): PublicAccess | null {
  if (!accessNote) return null;
  if (locale === "ja") {
    const match = /([\p{L}\p{N}ー・-]{1,30}駅)(?:[^、。]{0,12})?から徒歩\s*(\d{1,2})\s*分/u.exec(accessNote);
    const walkMinutes = match ? Number(match[2]) : 0;
    return match && walkMinutes > 0 ? { station: match[1]!, walkMinutes } : null;
  }
  const match = /(?:about\s+|approximately\s+)?(\d{1,2})(?:-|\s+)minutes?\s+(?:walk|on foot)\s+from\s+(?:the\s+)?([\p{Lu}][\p{L}\p{N}'’.-]*(?:[ -][\p{Lu}][\p{L}\p{N}'’.-]*)*\s+Station)\b/iu.exec(accessNote);
  const walkMinutes = match ? Number(match[1]) : 0;
  const station = match?.[2];
  if (!station || /^nearest station$/i.test(station) || walkMinutes <= 0) return null;
  return { station, walkMinutes };
}

export function detailFromTokyoLine(regionName: string, accessNote: string | null | undefined, locale: "en" | "ja"): string {
  const access = publicStationAccess(accessNote, locale);
  return DETAIL_PAGE_COPY[locale]["detail.fromTokyoLine"]({ region: regionName, ...(access ?? {}) });
}

/** A contextual heading from the public meeting station and offered start times. */
export function detailGuideHeading(regionName: string, accessNote: string | null | undefined, startTimes: readonly string[]): string {
  const station = publicStationAccess(accessNote, "en")?.station;
  const place = station?.replace(/ Station$/, "") || regionName;
  const hours = startTimes.map((time) => Number(time.slice(0, 2))).filter((hour) => Number.isInteger(hour) && hour >= 0 && hour < 24);
  const timeOfDay = hours.length && hours.every((hour) => hour < 12) ? "morning" : hours.length && hours.every((hour) => hour >= 17) ? "evening" : "day";
  return `Plan your ${timeOfDay} in ${place}`;
}

/** The first bookable occurrence on each of the next four JST dates. */
export function detailNextDates(occurrences: readonly Occurrence[]): Occurrence[] {
  return nextBookableDays(occurrences, DETAIL_NEXT_DATE_COUNT);
}
