import { EXPERIENCE_CONDITION_KINDS, type ExperienceConditionKind } from "@niho-experience/api-client";
import type { HostAccess, HostDiet, HostEnglishLevel, HostFoodServed, HostParticipationConditions, HostRainPlan, HostSeating, HostWalking } from "./types";

/*
 * 参加の条件 (#110)'s words for the host, apart from the screen so they can be tested: the kinds in
 * the traveler side's order, each choice's Japanese, the row's one-line summary, and the dialog's
 * typed values back as a condition. The values are English identifiers; NIHO writes the English
 * the experience site shows from them, so nothing here builds English.
 */

/** The kinds, in the order the panel lists them (the traveler side's). */
export const CONDITION_KINDS: readonly ExperienceConditionKind[] = EXPERIENCE_CONDITION_KINDS;

export const CONDITION_LABELS: Record<ExperienceConditionKind, string> = {
  AGE: "年齢",
  PHYSICAL: "体の負担",
  HOST_LANGUAGE: "ホストの言語",
  FOOD: "食べもの",
  ACCESS: "段差・車いす",
  WEATHER: "雨の日",
};

/** No condition set: every kind 未設定. */
export const NO_CONDITIONS: HostParticipationConditions = { AGE: null, PHYSICAL: null, HOST_LANGUAGE: null, FOOD: null, ACCESS: null, WEATHER: null };

/** What a row says for a kind that is not set. */
export const CONDITION_UNSET = "未設定";

export interface ConditionOption<T extends string> {
  value: T;
  label: string;
}

export const SEATING_OPTIONS: readonly ConditionOption<HostSeating>[] = [
  { value: "NONE", label: "なし" },
  { value: "CHAIR", label: "いす" },
  { value: "FLOOR", label: "床に座る" },
];

export const WALKING_OPTIONS: readonly ConditionOption<HostWalking>[] = [
  { value: "LITTLE", label: "ほとんど歩かない" },
  { value: "SOME", label: "少し歩く" },
  { value: "LOTS", label: "よく歩く" },
];

export const ENGLISH_LEVEL_OPTIONS: readonly ConditionOption<HostEnglishLevel>[] = [
  { value: "FLUENT", label: "流暢" },
  { value: "CONVERSATIONAL", label: "日常会話" },
  { value: "BASIC", label: "かんたん" },
  { value: "NONE", label: "話さない" },
];

export const FOOD_SERVED_OPTIONS: readonly ConditionOption<HostFoodServed>[] = [
  { value: "MEAL", label: "食事" },
  { value: "SNACK", label: "軽食" },
  { value: "DRINKS", label: "飲み物だけ" },
  { value: "NONE", label: "出ない" },
];

export const DIET_OPTIONS: readonly ConditionOption<HostDiet>[] = [
  { value: "VEGETARIAN", label: "ベジタリアン" },
  { value: "VEGAN", label: "ヴィーガン" },
  { value: "HALAL", label: "ハラール" },
  { value: "GLUTEN_FREE", label: "グルテンフリー" },
  { value: "ALLERGY_ASK", label: "アレルギーは相談" },
];

export const ACCESS_OPTIONS: readonly ConditionOption<HostAccess>[] = [
  { value: "STEP_FREE", label: "段差なし・車いす可" },
  { value: "SOME_STEPS", label: "一部段差あり（相談）" },
  { value: "STEPS", label: "段差あり・車いす不可" },
];

export const RAIN_OPTIONS: readonly ConditionOption<HostRainPlan>[] = [
  { value: "INDOOR", label: "雨でも開催（屋内）" },
  { value: "LIGHT_RAIN", label: "小雨なら開催" },
  { value: "CANCELLED", label: "雨天は中止（全額返金）" },
];

/** A note may be as long as the detail line NIHO shows under a condition (journey.ts EXPERIENCE_CONDITION_LIMITS). */
export const CONDITION_NOTE_LIMIT = 160;

function labelOf<T extends string>(options: readonly ConditionOption<T>[], value: T): string {
  return options.find((option) => option.value === value)?.label ?? "";
}

const SEATED: Record<HostSeating, string> = { NONE: "座る時間なし", CHAIR: "いすに座る", FLOOR: "床に座る" };
const ENGLISH_SPOKEN: Record<HostEnglishLevel, string> = { FLUENT: "流暢な英語", CONVERSATIONAL: "日常会話の英語", BASIC: "かんたんな英語", NONE: "英語は話さない" };
const SERVED: Record<HostFoodServed, string> = { MEAL: "食事あり", SNACK: "軽食あり", DRINKS: "飲み物だけ", NONE: "食べものは出ません" };

/**
 * A row's line: the choices in short Japanese ("10 歳以上 · 子どもは大人と一緒"), or 未設定. The
 * note is not in it: the row shows it on its own line, in the tab's language.
 */
export function conditionSummary(conditions: HostParticipationConditions, kind: ExperienceConditionKind): string {
  let parts: (string | null)[];
  switch (kind) {
    case "AGE": {
      const value = conditions.AGE;
      if (!value) return CONDITION_UNSET;
      parts = [value.minimumAge === null ? "年齢の指定なし" : `${value.minimumAge} 歳以上`, value.withAdult ? "子どもは大人と一緒" : null];
      break;
    }
    case "PHYSICAL": {
      const value = conditions.PHYSICAL;
      if (!value) return CONDITION_UNSET;
      const minutes = value.seating !== "NONE" && value.seatedMinutes ? `（約 ${value.seatedMinutes} 分）` : "";
      parts = [`${SEATED[value.seating]}${minutes}`, labelOf(WALKING_OPTIONS, value.walking)];
      break;
    }
    case "HOST_LANGUAGE": {
      const value = conditions.HOST_LANGUAGE;
      if (!value) return CONDITION_UNSET;
      parts = [value.japanese ? "日本語" : null, ENGLISH_SPOKEN[value.english], value.englishGuide ? "英語の案内資料あり" : null];
      break;
    }
    case "FOOD": {
      const value = conditions.FOOD;
      if (!value) return CONDITION_UNSET;
      const diets = DIET_OPTIONS.filter((option) => option.value !== "ALLERGY_ASK" && value.diets.includes(option.value)).map((option) => option.label);
      parts = [SERVED[value.served], diets.length ? `${diets.join("・")}に対応` : null, value.diets.includes("ALLERGY_ASK") ? "アレルギーは相談" : null];
      break;
    }
    case "ACCESS": {
      const value = conditions.ACCESS;
      if (!value) return CONDITION_UNSET;
      parts = [labelOf(ACCESS_OPTIONS, value.access)];
      break;
    }
    case "WEATHER": {
      const value = conditions.WEATHER;
      if (!value) return CONDITION_UNSET;
      parts = [labelOf(RAIN_OPTIONS, value.rain)];
      break;
    }
  }
  return parts.filter(Boolean).join(" · ");
}

/** A kind as the dialog edits it: every kind's choices (only the kind's own are used), numbers as typed, a choice not made yet as null. */
export interface ConditionDraft {
  minimumAge: string;
  withAdult: boolean;
  seating: HostSeating | null;
  seatedMinutes: string;
  walking: HostWalking | null;
  japanese: boolean;
  english: HostEnglishLevel | null;
  englishGuide: boolean;
  served: HostFoodServed | null;
  diets: HostDiet[];
  access: HostAccess | null;
  rain: HostRainPlan | null;
  /** In the language of the tab the dialog was opened from. */
  note: string;
}

const typed = (value: number | null) => (value === null ? "" : String(value));

/** The dialog's starting values: the kind as it is set, or nothing chosen yet (日本語を話す starts checked). */
export function conditionDraft(conditions: HostParticipationConditions, kind: ExperienceConditionKind): ConditionDraft {
  const draft: ConditionDraft = { minimumAge: "", withAdult: false, seating: null, seatedMinutes: "", walking: null, japanese: true, english: null, englishGuide: false, served: null, diets: [], access: null, rain: null, note: "" };
  switch (kind) {
    case "AGE":
      return conditions.AGE ? { ...draft, minimumAge: typed(conditions.AGE.minimumAge), withAdult: conditions.AGE.withAdult, note: conditions.AGE.note } : draft;
    case "PHYSICAL": {
      const value = conditions.PHYSICAL;
      return value ? { ...draft, seating: value.seating, seatedMinutes: typed(value.seatedMinutes), walking: value.walking, note: value.note } : draft;
    }
    case "HOST_LANGUAGE": {
      const value = conditions.HOST_LANGUAGE;
      return value ? { ...draft, japanese: value.japanese, english: value.english, englishGuide: value.englishGuide, note: value.note } : draft;
    }
    case "FOOD":
      return conditions.FOOD ? { ...draft, served: conditions.FOOD.served, diets: [...conditions.FOOD.diets], note: conditions.FOOD.note } : draft;
    case "ACCESS":
      return conditions.ACCESS ? { ...draft, access: conditions.ACCESS.access, note: conditions.ACCESS.note } : draft;
    case "WEATHER":
      return conditions.WEATHER ? { ...draft, rain: conditions.WEATHER.rain, note: conditions.WEATHER.note } : draft;
  }
}

function wholeOrNull(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * The dialog's 保存: the conditions with this kind set from what was typed, or null while a choice
 * the kind needs is not made. Blank numbers stay unset; the diets keep the list's order.
 */
export function withConditionFromDraft(conditions: HostParticipationConditions, kind: ExperienceConditionKind, draft: ConditionDraft): HostParticipationConditions | null {
  const note = draft.note.trim();
  switch (kind) {
    case "AGE":
      return { ...conditions, AGE: { minimumAge: wholeOrNull(draft.minimumAge), withAdult: draft.withAdult, note } };
    case "PHYSICAL": {
      const { seating, walking } = draft;
      if (!seating || !walking) return null;
      return { ...conditions, PHYSICAL: { seating, seatedMinutes: seating === "NONE" ? null : wholeOrNull(draft.seatedMinutes), walking, note } };
    }
    case "HOST_LANGUAGE":
      return draft.english ? { ...conditions, HOST_LANGUAGE: { japanese: draft.japanese, english: draft.english, englishGuide: draft.englishGuide, note } } : null;
    case "FOOD":
      return draft.served ? { ...conditions, FOOD: { served: draft.served, diets: DIET_OPTIONS.map((option) => option.value).filter((diet) => draft.diets.includes(diet)), note } } : null;
    case "ACCESS":
      return draft.access ? { ...conditions, ACCESS: { access: draft.access, note } } : null;
    case "WEATHER":
      return draft.rain ? { ...conditions, WEATHER: { rain: draft.rain, note } } : null;
  }
}

/** 未設定に戻す. */
export function withoutCondition(conditions: HostParticipationConditions, kind: ExperienceConditionKind): HostParticipationConditions {
  return { ...conditions, [kind]: null };
}

/** The kinds that are set, in the panel's order. */
export function setConditionKinds(conditions: HostParticipationConditions): ExperienceConditionKind[] {
  return CONDITION_KINDS.filter((kind) => conditions[kind] !== null);
}

/** A kind's note, whichever kind it is; empty when the kind is not set. */
export function conditionNote(conditions: HostParticipationConditions, kind: ExperienceConditionKind): string {
  return conditions[kind]?.note ?? "";
}

/** The same conditions with each set kind's note replaced (`notes(kind)`). */
export function withConditionNotes(conditions: HostParticipationConditions, notes: (kind: ExperienceConditionKind) => string): HostParticipationConditions {
  const next = { ...conditions } as { -readonly [K in ExperienceConditionKind]: HostParticipationConditions[K] };
  for (const kind of CONDITION_KINDS) {
    const value = conditions[kind];
    if (value) (next as Record<ExperienceConditionKind, unknown>)[kind] = { ...value, note: notes(kind) };
  }
  return next;
}
