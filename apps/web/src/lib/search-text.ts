import { pluralize } from "./format";
import { dayOption } from "./date-filter";

/**
 * The search bar's words (#698), one component for both languages (#658): everything the shared bar does not read from the
 * interface copy. Japanese is written for Japanese readers, not translated: 「キーワード」 where English says "What".
 */
type SearchLocale = "en" | "ja";

const TEXT = {
  en: {
    what: "What", when: "When", guests: "Guests", anyDay: "Any day", anyGuests: "Any",
    search: "Search", find: "Find an experience", anyGroup: "Any group", clearAll: "Clear all", clear: "Clear",
    previousMonth: "Previous month", nextMonth: "Next month", legendOn: "Something on", legendOff: "Nothing on",
    dayOn: "something on", dayOff: "nothing on", close: "Close", fewer: "Fewer guests", more: "More guests",
    chooseDay: "Choose a day (Japan time)", chooseGuests: "How many guests?", sheetTitle: "Find an experience",
  },
  ja: {
    what: "キーワード", when: "日にち", guests: "人数", anyDay: "いつでも", anyGuests: "指定なし",
    search: "さがす", find: "体験をさがす", anyGroup: "人数指定なし", clearAll: "すべてクリア", clear: "クリア",
    previousMonth: "前の月", nextMonth: "次の月", legendOn: "開催のある日", legendOff: "開催なし",
    dayOn: "開催あり", dayOff: "開催なし", close: "閉じる", fewer: "人数を減らす", more: "人数を増やす",
    chooseDay: "日にちを選ぶ（日本時間）", chooseGuests: "何名で参加しますか", sheetTitle: "体験をさがす",
  },
} as const;

export const searchText = (locale: SearchLocale) => TEXT[locale];

export const guestsLabel = (guests: number, locale: SearchLocale): string => (locale === "ja" ? `${guests}名` : pluralize(guests, "guest"));

/** "Sat 5 Dec" / 「12月5日（土）」: a chosen day. */
export function chosenDayLabel(date: string, locale: SearchLocale): string {
  return dayOption(date, locale).label.replace(/曜）$/, "）");
}

/** The phone pill's second line: 「いつでも · 人数指定なし」 / "Any day · Any group", or the chosen day and party. */
export function searchSummary(date: string | null, guests: number | null, locale: SearchLocale): string {
  const words = TEXT[locale];
  return `${date ? chosenDayLabel(date, locale) : words.anyDay} · ${guests === null ? words.anyGroup : guestsLabel(guests, locale)}`;
}

export const showCountLabel = (count: number, locale: SearchLocale): string => (locale === "ja" ? `${count}件の体験を見る` : `Show ${pluralize(count, "experience")}`);
