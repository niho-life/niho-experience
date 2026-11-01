import type { StatusLabel } from "@/host/status";

/*
 * 英語（自動訳） of a page written in Japanese (#89 / #110, NIHO 接続版): NIHO's own English of the saved Japanese, read from the
 * preview (`GET …/pages/{pageId}/preview`, `page.content.*En`). It is read only: the host contract has no English input, no
 * "make it again" and no "confirm", so what the host can do is write the Japanese and read what NIHO made. An item is null
 * until NIHO has made it, and again when its Japanese changed after (only an English fresh against the Japanese is returned).
 * The mock editor's draft / confirm flow (page-english.ts) is a rehearsal of #110 that http mode does not have.
 */

/** A text and its NIHO English: `en` is null when NIHO has not made it (or made it from older Japanese). */
export interface LivePair { ja: string; en: string | null }
export interface LiveEnglishStep { time: string; title: LivePair; text: LivePair }

export interface LiveEnglish {
  /** The language the page is written in: only a Japanese page has an English to read. */
  language: "EN" | "JA";
  title: LivePair;
  lead: LivePair;
  dayLanguage: LivePair;
  highlights: LivePair[];
  description: LivePair;
  included: LivePair[];
  notIncluded: LivePair[];
  notSuitableFor: LivePair[];
  timeline: LiveEnglishStep[];
  knowBeforeYouGo: LivePair[];
}

/** The fields the English tab lists, in the public order. */
export type LiveEnglishField = "title" | "lead" | "dayLanguage" | "highlights" | "description" | "included" | "notIncluded" | "notSuitableFor" | "timeline" | "knowBeforeYouGo";

export type LiveEnglishStatus = "none" | "partial" | "complete";
export const LIVE_ENGLISH_STATUS: Record<LiveEnglishStatus, StatusLabel> = {
  none: { label: "未作成", tone: "draft" },
  partial: { label: "一部のみ", tone: "wait" },
  complete: { label: "そろっています", tone: "ok" },
};

const isString = (value: unknown): value is string => typeof value === "string";
const isText = (value: unknown): value is string | null => value === null || isString(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const textList = (value: unknown, check: (item: unknown) => boolean): value is unknown[] => Array.isArray(value) && value.every(check);

function pairs(ja: unknown, en: unknown): LivePair[] | null {
  if (!textList(ja, isString) || !textList(en, isText) || en.length !== ja.length) return null;
  return ja.map((text, at) => ({ ja: text as string, en: (en[at] as string | null) ?? null }));
}

/** The English of a preview response (from the BFF), or null when it is not that shape. */
export function readLiveEnglish(value: unknown): LiveEnglish | null {
  if (!isObject(value) || !isObject(value.page)) return null;
  const { page } = value;
  const content = page.content;
  if ((page.language !== "EN" && page.language !== "JA") || !isString(page.title) || !isText(page.titleEn) || !isObject(content)) return null;
  const facts = content.facts;
  if (!isString(content.lead) || !isText(content.leadEn) || !isString(content.description) || !isText(content.descriptionEn) || !isObject(facts) || !isString(facts.language) || !isText(facts.languageEn)) return null;
  const highlights = pairs(content.highlights, content.highlightsEn);
  const included = pairs(content.included, content.includedEn);
  const notIncluded = pairs(content.notIncluded, content.notIncludedEn);
  const notSuitableFor = pairs(content.notSuitableFor, content.notSuitableForEn);
  const knowBeforeYouGo = pairs(content.knowBeforeYouGo, content.knowBeforeYouGoEn);
  if (!highlights || !included || !notIncluded || !notSuitableFor || !knowBeforeYouGo || !Array.isArray(content.timeline)) return null;
  const timeline: LiveEnglishStep[] = [];
  for (const step of content.timeline) {
    if (!isObject(step) || !isString(step.time) || !isString(step.title) || !isText(step.titleEn) || !isString(step.text) || !isText(step.textEn)) return null;
    timeline.push({ time: step.time, title: { ja: step.title, en: step.titleEn }, text: { ja: step.text, en: step.textEn } });
  }
  return {
    language: page.language,
    title: { ja: page.title, en: page.titleEn },
    lead: { ja: content.lead, en: content.leadEn },
    dayLanguage: { ja: facts.language, en: facts.languageEn },
    highlights, description: { ja: content.description, en: content.descriptionEn }, included, notIncluded, notSuitableFor, timeline, knowBeforeYouGo,
  };
}

/** Whether the Japanese has words that NIHO should have put into English (blank is nothing to translate). */
const wanted = (pair: LivePair) => pair.ja.trim() !== "";
const made = (pair: LivePair) => !wanted(pair) || (pair.en !== null && pair.en.trim() !== "");

/** The pairs of a field (a timeline step has two: its title and its line). */
export function pairsOf(english: LiveEnglish, field: LiveEnglishField): LivePair[] {
  switch (field) {
    case "title":
    case "lead":
    case "dayLanguage":
    case "description":
      return [english[field]];
    case "timeline":
      return english.timeline.flatMap((step) => [step.title, step.text]);
    default:
      return english[field];
  }
}

export const LIVE_ENGLISH_FIELDS: readonly LiveEnglishField[] = ["title", "lead", "dayLanguage", "highlights", "description", "included", "notIncluded", "notSuitableFor", "timeline", "knowBeforeYouGo"];

/** The fields with Japanese that still lack NIHO's English, and the state they add up to. */
export function liveEnglishState(english: LiveEnglish | null): { status: LiveEnglishStatus; missing: LiveEnglishField[] } {
  if (!english || english.language !== "JA") return { status: "none", missing: [] };
  const withJapanese = LIVE_ENGLISH_FIELDS.filter((field) => pairsOf(english, field).some(wanted));
  const missing = withJapanese.filter((field) => !pairsOf(english, field).every(made));
  const anyEnglish = LIVE_ENGLISH_FIELDS.some((field) => pairsOf(english, field).some((pair) => wanted(pair) && made(pair)));
  if (!withJapanese.length || !anyEnglish) return { status: "none", missing: withJapanese };
  return { status: missing.length ? "partial" : "complete", missing };
}
