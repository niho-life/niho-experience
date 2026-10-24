import { CONDITION_KINDS, withConditionNotes } from "./conditions";
import type { HostEnglishSource, HostExperienceContent, HostOfferText, HostPageText, HostPageTextField, HostTimelineText, ListingStatus } from "./types";

/*
 * 日本語で書いて英語の下書きを確かめる (#110, Epic #103 の 2・8), apart from the screen so it can be
 * tested. A page written in Japanese keeps the Japanese apart from its English; NIHO drafts the
 * English (a server action) and the host checks it, corrects it and confirms it. The draft never
 * overwrites what is confirmed by itself, and only the English last confirmed goes to review and to
 * the experience site. The English is in one of four states, with the same idea as a message's
 * reply (messages.ts replyDraftState): English made from older Japanese is stale until it is made
 * again, or corrected and confirmed.
 *
 * 写真・時刻・料金・定員 and the conditions' choices are shared: both tabs show and change the same.
 * The words (title, lead, …, the offers' names and questions) are written once per language.
 */

/** The page's words, in the public order. */
export const PAGE_TEXT_FIELDS = [
  "title",
  "lead",
  "dayLanguage",
  "highlights",
  "description",
  "included",
  "notIncluded",
  "notSuitableFor",
  "conditions",
  "timeline",
  "meeting",
  "knowBeforeYouGo",
  "offers",
] as const satisfies readonly HostPageTextField[];

/** The tabs of a page written in Japanese: 日本語で書く / 英語（公開）. A page written in English has only its English. */
export type EditorTab = "ja" | "en";

/** 未作成 / 下書き / 確定済み / 古い. */
export type PageEnglishStatus = "none" | "draft" | "confirmed" | "stale";

export interface PageEnglishState {
  status: PageEnglishStatus;
  /** The fields whose Japanese changed since the English was made or confirmed (日本語を変えました), in the public order. */
  changed: HostPageTextField[];
  /** The fields whose English the host corrected. */
  edited: readonly HostPageTextField[];
}

/** 英語の下書きを作る failed (NIHO or the network): what was written stays. */
export const PAGE_ENGLISH_FAILED_TEXT = "英語の下書きを作れませんでした。もう一度試すか、英語を直接書いてください";
/** 英語の下書きを作る before NIHO's API can draft a page's English (http mode). */
export const PAGE_ENGLISH_UNAVAILABLE_TEXT = "英語の下書きを作る機能は準備中です。英語を直接書いてください。";

/** A page written in English (or never in Japanese): nothing drafted, confirmed or corrected. */
export const NO_ENGLISH_SOURCE: HostEnglishSource = { draftedFrom: null, confirmedFrom: null, edited: [] };

const EMPTY_STEP: HostTimelineText = { title: "", text: "" };
const EMPTY_OFFER: HostOfferText = { name: "", questions: [] };

/** Japanese not written yet: the page's words, all empty. */
export const EMPTY_PAGE_TEXT: HostPageText = {
  title: "",
  lead: "",
  dayLanguage: "",
  highlights: [],
  description: "",
  included: [],
  notIncluded: [],
  notSuitableFor: [],
  conditions: {},
  timeline: {},
  meeting: { area: "", entrance: "" },
  knowBeforeYouGo: [],
  offers: {},
};

type Structure = Pick<HostExperienceContent, "timeline" | "offers" | "conditions">;

/** The English the page has now, as words. */
export function englishText(content: Pick<HostExperienceContent, HostPageTextField>): HostPageText {
  const { title, lead, dayLanguage, highlights, description, included, notIncluded, notSuitableFor, knowBeforeYouGo } = content;
  return {
    title,
    lead,
    dayLanguage,
    highlights,
    description,
    included,
    notIncluded,
    notSuitableFor,
    conditions: Object.fromEntries(CONDITION_KINDS.flatMap((kind) => (content.conditions[kind] ? [[kind, content.conditions[kind].note]] : []))),
    timeline: Object.fromEntries(content.timeline.map((step) => [step.id, { title: step.title, text: step.text }])),
    meeting: { area: content.meeting.area, entrance: content.meeting.entrance },
    knowBeforeYouGo,
    offers: Object.fromEntries(content.offers.map((offer) => [offer.id, { name: offer.name, questions: offer.questions }])),
  };
}

/** The same words with each string changed by `map` (the preview's English draft). */
export function mapPageText(text: HostPageText, map: (value: string) => string): HostPageText {
  const list = (values: readonly string[]) => values.map(map);
  const entries = <T, U>(record: Readonly<Record<string, T>>, each: (value: T) => U) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, each(value)]));
  return {
    title: map(text.title),
    lead: map(text.lead),
    dayLanguage: map(text.dayLanguage),
    highlights: list(text.highlights),
    description: map(text.description),
    included: list(text.included),
    notIncluded: list(text.notIncluded),
    notSuitableFor: list(text.notSuitableFor),
    conditions: entries(text.conditions, (note: string | undefined) => map(note ?? "")),
    timeline: entries(text.timeline, (step) => ({ title: map(step.title), text: map(step.text) })),
    meeting: { area: map(text.meeting.area), entrance: map(text.meeting.entrance) },
    knowBeforeYouGo: list(text.knowBeforeYouGo),
    offers: entries(text.offers, (offer) => ({ name: map(offer.name), questions: list(offer.questions) })),
  };
}

const words = (values: readonly string[]) => values.map((value) => value.trim()).filter(Boolean);

/**
 * One field's words as compared: trimmed, blank list rows left out (a row just added is no change
 * yet), and the steps, offers and conditions the page has now, in its order. A step, an offer or a
 * condition without words counts as empty.
 */
function fieldWords(structure: Structure, field: HostPageTextField, text: HostPageText): unknown {
  switch (field) {
    case "title":
    case "lead":
    case "dayLanguage":
    case "description":
      return text[field].trim();
    case "highlights":
    case "included":
    case "notIncluded":
    case "notSuitableFor":
    case "knowBeforeYouGo":
      return words(text[field]);
    case "conditions":
      return CONDITION_KINDS.filter((kind) => structure.conditions[kind]).map((kind) => (text.conditions[kind] ?? "").trim());
    case "timeline":
      return structure.timeline.map((step) => {
        const stepText = text.timeline[step.id] ?? EMPTY_STEP;
        return [stepText.title.trim(), stepText.text.trim()];
      });
    case "meeting":
      return [text.meeting.area.trim(), text.meeting.entrance.trim()];
    case "offers":
      return structure.offers.map((offer) => {
        const offerText = text.offers[offer.id] ?? EMPTY_OFFER;
        return [offerText.name.trim(), words(offerText.questions)];
      });
  }
}

function hasWords(value: unknown): boolean {
  if (typeof value === "string") return value !== "";
  return Array.isArray(value) && value.some(hasWords);
}

const sameWords = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Whether a field has any words in `text` (in the page's steps, offers and conditions). */
export function fieldHasWords(structure: Structure, field: HostPageTextField, text: HostPageText): boolean {
  return hasWords(fieldWords(structure, field, text));
}

/** Whether a page's words have anything in them (the Japanese to draft the English from). */
export function textHasWords(text: HostPageText): boolean {
  let found = false;
  mapPageText(text, (value) => {
    found ||= value.trim() !== "";
    return value;
  });
  return found;
}

type EnglishInput = Structure & Pick<HostExperienceContent, "writingLanguage" | "japanese" | "englishSource">;

/**
 * 日本語を変えました: the fields whose Japanese differs from the Japanese the English was last made
 * from (or confirmed against). A field without Japanese is not one: its English stays as it is.
 */
export function changedFields(content: EnglishInput): HostPageTextField[] {
  const { japanese, englishSource } = content;
  const basis = englishSource.draftedFrom ?? englishSource.confirmedFrom;
  if (!japanese || !basis) return [];
  return PAGE_TEXT_FIELDS.filter((field) => {
    const now = fieldWords(content, field, japanese);
    return hasWords(now) && !sameWords(now, fieldWords(content, field, basis));
  });
}

/** The English's state for a page written in Japanese; null for a page written in English. */
export function pageEnglishState(content: EnglishInput): PageEnglishState | null {
  if (content.writingLanguage !== "ja") return null;
  const { draftedFrom, confirmedFrom, edited } = content.englishSource;
  const changed = changedFields(content);
  let status: PageEnglishStatus;
  if (changed.length) status = "stale";
  else if (!draftedFrom && !confirmedFrom && edited.length === 0) status = "none";
  else if (confirmedFrom && !draftedFrom && edited.length === 0) status = "confirmed";
  else status = "draft";
  return { status, changed, edited };
}

/** 掲載までに必要's 英語の確定: a page written in Japanese is listed only with its English confirmed and not stale. */
export function needsEnglishConfirmed(content: EnglishInput): boolean {
  const state = pageEnglishState(content);
  return state !== null && state.status !== "confirmed";
}

/**
 * 公開中の英語は前に確定したままです: a live page written in Japanese whose English is not confirmed
 * (the Japanese changed, or the English was drafted or corrected since). Saving does not publish it.
 */
export function publicEnglishBehind(content: EnglishInput, listingStatus: ListingStatus): boolean {
  return listingStatus === "live" && needsEnglishConfirmed(content);
}

/** 英語を確定: the English as it is now is the one to review and publish, checked against the Japanese as it is now. */
export function confirmEnglish(content: HostExperienceContent): HostExperienceContent {
  if (content.writingLanguage !== "ja" || !content.japanese) return content;
  return { ...content, englishSource: { draftedFrom: null, confirmedFrom: content.japanese, edited: [] } };
}

/**
 * 英語を作り直す overwrites the English of every field that has Japanese: the fields among them the
 * host corrected are asked about first (直した英語 N か所を…置き換えます).
 */
export function editsToReplace(content: EnglishInput): HostPageTextField[] {
  const japanese = content.japanese;
  if (!japanese) return [];
  return PAGE_TEXT_FIELDS.filter((field) => content.englishSource.edited.includes(field) && fieldHasWords(content, field, japanese));
}

const drafted = (sent: string, english: string | undefined, current: string) => (sent.trim() && english !== undefined ? english : current);
const draftedList = (sent: readonly string[], english: readonly string[] | undefined, current: readonly string[]) => (words(sent).length && english ? english : current);

/**
 * NIHO's English draft into the page: each field (each step, offer and condition) with Japanese in
 * what was `sent` takes NIHO's English; a field without Japanese keeps its English. The page may
 * have changed while NIHO drafted: the draft goes into the steps and offers it has now, and
 * Japanese changed meanwhile shows as 日本語を変えました at once.
 */
export function applyEnglishDraft(content: HostExperienceContent, sent: HostPageText, english: HostPageText): HostExperienceContent {
  if (content.writingLanguage !== "ja") return content;
  const overwritten = new Set(PAGE_TEXT_FIELDS.filter((field) => fieldHasWords(content, field, sent)));
  return {
    ...content,
    title: drafted(sent.title, english.title, content.title),
    lead: drafted(sent.lead, english.lead, content.lead),
    dayLanguage: drafted(sent.dayLanguage, english.dayLanguage, content.dayLanguage),
    highlights: draftedList(sent.highlights, english.highlights, content.highlights),
    description: drafted(sent.description, english.description, content.description),
    included: draftedList(sent.included, english.included, content.included),
    notIncluded: draftedList(sent.notIncluded, english.notIncluded, content.notIncluded),
    notSuitableFor: draftedList(sent.notSuitableFor, english.notSuitableFor, content.notSuitableFor),
    conditions: withConditionNotes(content.conditions, (kind) => drafted(sent.conditions[kind] ?? "", english.conditions[kind], content.conditions[kind]?.note ?? "")),
    timeline: content.timeline.map((step) => {
      const ja = sent.timeline[step.id] ?? EMPTY_STEP;
      const en = english.timeline[step.id];
      return { ...step, title: drafted(ja.title, en?.title, step.title), text: drafted(ja.text, en?.text, step.text) };
    }),
    meeting: { ...content.meeting, area: drafted(sent.meeting.area, english.meeting.area, content.meeting.area), entrance: drafted(sent.meeting.entrance, english.meeting.entrance, content.meeting.entrance) },
    knowBeforeYouGo: draftedList(sent.knowBeforeYouGo, english.knowBeforeYouGo, content.knowBeforeYouGo),
    offers: content.offers.map((offer) => {
      const ja = sent.offers[offer.id] ?? EMPTY_OFFER;
      const en = english.offers[offer.id];
      return { ...offer, name: drafted(ja.name, en?.name, offer.name), questions: draftedList(ja.questions, en?.questions, offer.questions) };
    }),
    englishSource: { draftedFrom: sent, confirmedFrom: content.englishSource.confirmedFrom, edited: content.englishSource.edited.filter((field) => !overwritten.has(field)) },
  };
}

/** The page as a tab shows it: the shared parts, and the words in the tab's language. */
export function contentInTab(content: HostExperienceContent, tab: EditorTab): HostExperienceContent {
  if (content.writingLanguage !== "ja" || tab === "en") return content;
  const ja = content.japanese ?? EMPTY_PAGE_TEXT;
  return {
    ...content,
    title: ja.title,
    lead: ja.lead,
    dayLanguage: ja.dayLanguage,
    highlights: ja.highlights,
    description: ja.description,
    included: ja.included,
    notIncluded: ja.notIncluded,
    notSuitableFor: ja.notSuitableFor,
    conditions: withConditionNotes(content.conditions, (kind) => ja.conditions[kind] ?? ""),
    timeline: content.timeline.map((step) => ({ ...step, ...(ja.timeline[step.id] ?? EMPTY_STEP) })),
    meeting: { ...content.meeting, ...ja.meeting },
    knowBeforeYouGo: ja.knowBeforeYouGo,
    offers: content.offers.map((offer) => ({ ...offer, ...(ja.offers[offer.id] ?? EMPTY_OFFER) })),
  };
}

/** The Japanese of the steps, offers and conditions the page has now (removed ones go with them). */
function prunedJapanese(text: HostPageText, structure: Structure): HostPageText {
  const steps = new Set(structure.timeline.map((step) => step.id));
  const offers = new Set(structure.offers.map((offer) => offer.id));
  return {
    ...text,
    timeline: Object.fromEntries(Object.entries(text.timeline).filter(([id]) => steps.has(id))),
    offers: Object.fromEntries(Object.entries(text.offers).filter(([id]) => offers.has(id))),
    conditions: Object.fromEntries(CONDITION_KINDS.flatMap((kind) => (structure.conditions[kind] && text.conditions[kind] !== undefined ? [[kind, text.conditions[kind]]] : []))),
  };
}

/** A change made on the 日本語で書く tab: the words go to the Japanese, the shared parts to the page. */
function changeInJapanese(content: HostExperienceContent, patch: Partial<HostExperienceContent>): HostExperienceContent {
  let ja: HostPageText = content.japanese ?? EMPTY_PAGE_TEXT;
  const next: HostExperienceContent = { ...content };
  for (const field of ["title", "lead", "dayLanguage", "description"] as const) {
    const value = patch[field];
    if (value !== undefined) ja = { ...ja, [field]: value };
  }
  for (const field of ["highlights", "included", "notIncluded", "notSuitableFor", "knowBeforeYouGo"] as const) {
    const value = patch[field];
    if (value !== undefined) ja = { ...ja, [field]: value };
  }
  if (patch.photos) next.photos = patch.photos;
  if (patch.timeline) {
    const english = new Map(content.timeline.map((step) => [step.id, step]));
    next.timeline = patch.timeline.map((step) => {
      const en = english.get(step.id);
      return { id: step.id, time: step.time, title: en?.title ?? "", text: en?.text ?? "" };
    });
    ja = { ...ja, timeline: Object.fromEntries(patch.timeline.map((step) => [step.id, { title: step.title, text: step.text }])) };
  }
  if (patch.meeting) {
    next.meeting = { ...content.meeting, exteriorPhotoUrl: patch.meeting.exteriorPhotoUrl };
    ja = { ...ja, meeting: { area: patch.meeting.area, entrance: patch.meeting.entrance } };
  }
  if (patch.offers) {
    const english = new Map(content.offers.map((offer) => [offer.id, offer]));
    next.offers = patch.offers.map((offer) => {
      const en = english.get(offer.id);
      return { ...offer, name: en?.name ?? "", questions: en?.questions ?? [] };
    });
    ja = { ...ja, offers: Object.fromEntries(patch.offers.map((offer) => [offer.id, { name: offer.name, questions: offer.questions }])) };
  }
  if (patch.conditions) {
    const conditions = patch.conditions;
    next.conditions = withConditionNotes(conditions, (kind) => content.conditions[kind]?.note ?? "");
    ja = { ...ja, conditions: Object.fromEntries(CONDITION_KINDS.flatMap((kind) => (conditions[kind] ? [[kind, conditions[kind].note]] : []))) };
  }
  return { ...next, japanese: prunedJapanese(ja, next) };
}

/**
 * A change made on a tab, back into the page. On 英語（公開）of a page written in Japanese, a field
 * whose English changed is one the host corrected (直す): a confirmed English becomes a draft again.
 * Adding or removing a step or an offer is not a correction; writing words into it is.
 */
export function changeInTab(content: HostExperienceContent, tab: EditorTab, patch: Partial<HostExperienceContent>): HostExperienceContent {
  if (content.writingLanguage !== "ja") return { ...content, ...patch };
  if (tab === "ja") return changeInJapanese(content, patch);
  const next: HostExperienceContent = { ...content, ...patch };
  const before = englishText(content);
  const after = englishText(next);
  const corrected = PAGE_TEXT_FIELDS.filter((field) => !sameWords(fieldWords(next, field, before), fieldWords(next, field, after)));
  const edited = PAGE_TEXT_FIELDS.filter((field) => content.englishSource.edited.includes(field) || corrected.includes(field));
  return {
    ...next,
    japanese: content.japanese ? prunedJapanese(content.japanese, next) : null,
    englishSource: corrected.length ? { ...content.englishSource, edited } : content.englishSource,
  };
}

/**
 * 書く言語 › 日本語: the English the page has now becomes the confirmed English, and the Japanese
 * starts empty (or, written in Japanese before, comes back as it was). A field without Japanese is
 * not stale: its English stays until Japanese is written for it.
 */
export function writeInJapanese(content: HostExperienceContent): HostExperienceContent {
  if (content.writingLanguage === "ja") return content;
  const japanese = prunedJapanese(content.japanese ?? EMPTY_PAGE_TEXT, content);
  return { ...content, writingLanguage: "ja", japanese, englishSource: { draftedFrom: null, confirmedFrom: japanese, edited: [] } };
}

/** 書く言語 › English (asked first): the host writes the English directly again. The Japanese stays for a return to 日本語. */
export function writeInEnglish(content: HostExperienceContent): HostExperienceContent {
  return content.writingLanguage === "en" ? content : { ...content, writingLanguage: "en" };
}
