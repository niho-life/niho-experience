import type { HostMeetingDefaults } from "./types";

/*
 * 集合場所 (#89): the provider's default (設定 › 既定の集合案内) and an experience's own (体験の編集 ›
 * 集合場所) have NIHO's one shape. Only `overview` is public; the rest reaches guests whose booking is
 * confirmed. NIHO trims the spaces around each value and keeps an unset one as "".
 */

export const MEETING_POINT_FIELDS = ["overview", "address", "accessNote", "mapUrl", "entranceNote"] as const satisfies readonly (keyof HostMeetingDefaults)[];

/** NIHO's limits (the contract), counted after the spaces are trimmed. */
export const MEETING_POINT_LIMITS: Record<keyof HostMeetingDefaults, number> = { overview: 200, address: 500, accessNote: 2000, mapUrl: 2048, entranceNote: 2000 };

export const EMPTY_MEETING_POINT: HostMeetingDefaults = { overview: "", address: "", accessNote: "", mapUrl: "", entranceNote: "" };

/** Empty, or an https URL without a user name or password (the contract's `mapUrl`). */
export function meetingMapUrlValid(value: string): boolean {
  if (value === "") return true;
  if (!/^https:\/\/.+/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/** The values as NIHO keeps them (trimmed), or null when one is missing, too long or the map URL is not https. */
export function normalizeMeetingPoint(value: unknown): HostMeetingDefaults | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== MEETING_POINT_FIELDS.length) return null;
  const result = { ...EMPTY_MEETING_POINT };
  for (const field of MEETING_POINT_FIELDS) {
    const item = (value as Record<string, unknown>)[field];
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (trimmed.length > MEETING_POINT_LIMITS[field]) return null;
    result[field] = trimmed;
  }
  return meetingMapUrlValid(result.mapUrl) ? result : null;
}

/** The same place once trimmed (a space typed at the end is not a change). */
export function sameMeetingPoint(left: HostMeetingDefaults, right: HostMeetingDefaults): boolean {
  return MEETING_POINT_FIELDS.every((field) => left[field].trim() === right[field].trim());
}
