import type { AskHostTopic, ExperienceConditionKind, ExperienceConditions } from "@niho-experience/api-client";
import type { HandIconName } from "@/components/HandIcon";
import { dayOption, jstToday } from "./date-filter";
import { formatClock } from "./schedule";

/**
 * Display helpers for the guest journey (Epic #103): participation conditions, questions to the host, the free-cancellation
 * deadline. Pure and English-first (the Japanese routes show none of these yet). The data itself comes from `journey.ts`.
 */

const CONDITION_ICONS: Readonly<Record<ExperienceConditionKind, HandIconName>> = {
  AGE: "people",
  PHYSICAL: "clock",
  HOST_LANGUAGE: "chat",
  FOOD: "bowl",
  ACCESS: "house",
  WEATHER: "umbrella",
};

/** Rows for "Good to know". The text is NIHO's; the screen only picks the hand-drawn icon for each kind. */
export function conditionRows(conditions: ExperienceConditions | null): { icon: HandIconName; headline: string; detail?: string }[] {
  if (!conditions) return [];
  return conditions.items.map((item) => ({ icon: CONDITION_ICONS[item.kind], headline: item.headline, ...(item.detail ? { detail: item.detail } : {}) }));
}

export const ASK_HOST_TOPIC_LABELS: Readonly<Record<AskHostTopic, string>> = {
  CHILDREN: "Children",
  FOOD: "Food & allergies",
  ACCESS: "Access",
  LANGUAGE: "Language",
  OTHER: "Other",
};

/** "Shiryu" / "Shiryu & Yui" stay as they are; a long list falls back to a generic noun. */
export function askHostTarget(hostNames: string): string {
  const name = hostNames.trim();
  return name && name.length <= 28 ? name : "the host";
}

/** "Thu 12 Nov, 7:00 AM Japan time" for an instant. Always Japan time, whatever the browser's zone. */
export function japanTime(date: Date): string {
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return `${dayOption(jstToday(date)).label}, ${formatClock(clock)} Japan time`;
}

export type FreeCancellation = { state: "until"; label: string } | { state: "ended" };

/**
 * The end of free cancellation: `hoursBefore` hours before the start (the contract's FREE_UNTIL_24H / 48H). `null` when
 * the option is non-refundable or the start is unknown. A date already inside the window has no free cancellation left.
 */
export function freeCancellationDeadline(startAt: string, hoursBefore: number | null, now: Date): FreeCancellation | null {
  if (hoursBefore === null) return null;
  const start = Date.parse(startAt);
  if (!Number.isFinite(start)) return null;
  const deadline = new Date(start - hoursBefore * 3_600_000);
  return deadline.getTime() <= now.getTime() ? { state: "ended" } : { state: "until", label: japanTime(deadline) };
}

/** Messages for the fields that only exist with the journey additions. Plain English; the page never shows an error code. */
export const JOURNEY_PROBLEMS = {
  phone: "Please check your mobile number, or leave it empty.",
  conditions: "Please confirm that everyone in your group is OK with the points under “Before you book”.",
  conditionsChanged: "The points under “Before you book” changed. Reload the experience to review them.",
  conditionsAdded: "This experience has points to confirm before you book. Reload the experience to review them.",
} as const;
