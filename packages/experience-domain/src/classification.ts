/*
 * 商品の分類 (#529): the words the Japanese site (/ja) sorts and filters experiences by. One category and one area per product,
 * and a few "だれと" and "こんな日に" values (separate conditions). Ids are the stable keys stored and put in URLs; the labels
 * are what people read. No hidden taxonomy: a value outside these lists is refused.
 */

export const EXPERIENCE_CATEGORIES = [
  { id: "walk", hand: "take a walk", label: "歩く", lead: "山道、切通し、路地。ガイドや住んでいる人と歩きます。" },
  { id: "food", hand: "cook & eat", label: "つくる・食べる", lead: "市場で買い、台所に立ち、同じ食卓を囲みます。" },
  { id: "craft", hand: "make by hand", label: "手を動かす", lead: "書く、彫る、繕う、染める。つくり手のそばで。" },
  { id: "zen", hand: "sit quietly", label: "禅と寺", lead: "坐る、点てる、写す。静かな時間の入口。" },
  { id: "time", hand: "dawn & dusk", label: "朝と夜", lead: "観光客が来る前と、帰ったあとの鎌倉。" },
  { id: "sea", hand: "by the sea", label: "海", lead: "材木座、逗子、葉山。海のそばで過ごします。" },
  { id: "people", hand: "meet someone", label: "人に会う", lead: "職人、店主、僧侶、農家。話を聞きに行きます。" },
  { id: "group", hand: "all together", label: "団体・チームで", lead: "会社のチーム、学校、仲間の集まりに。" },
] as const;

export const EXPERIENCE_AREAS = [
  { id: "kamakura", label: "鎌倉駅まわり" },
  { id: "kita", label: "北鎌倉" },
  { id: "hase", label: "長谷・由比ヶ浜" },
  { id: "zai", label: "材木座" },
  { id: "east", label: "二階堂・十二所" },
  { id: "kosh", label: "腰越" },
  { id: "ofuna", label: "大船・山のほう" },
  { id: "zushi", label: "逗子" },
  { id: "hayama", label: "葉山" },
] as const;

/** だれと (several may apply). */
export const EXPERIENCE_COMPANIONS = [
  { id: "solo", label: "ひとりで" },
  { id: "date", label: "ふたりで" },
  { id: "friends", label: "友人と" },
  { id: "family", label: "子どもと" },
] as const;

/** こんな日に (several may apply; a condition apart from だれと). */
export const EXPERIENCE_OCCASIONS = [
  { id: "rain", label: "雨の日に" },
  { id: "anniv", label: "特別な日に" },
] as const;

export type ExperienceCategoryId = (typeof EXPERIENCE_CATEGORIES)[number]["id"];
export type ExperienceAreaId = (typeof EXPERIENCE_AREAS)[number]["id"];
export type ExperienceCompanionId = (typeof EXPERIENCE_COMPANIONS)[number]["id"];
export type ExperienceOccasionId = (typeof EXPERIENCE_OCCASIONS)[number]["id"];

/** What is kept for one product. Every field may be empty: an unclassified product is only in 「すべて」. */
export interface ExperienceClassification {
  readonly category: ExperienceCategoryId | null;
  readonly area: ExperienceAreaId | null;
  readonly companions: readonly ExperienceCompanionId[];
  readonly occasions: readonly ExperienceOccasionId[];
}

export const EMPTY_EXPERIENCE_CLASSIFICATION: ExperienceClassification = Object.freeze({ category: null, area: null, companions: [], occasions: [] });

const ids = (list: readonly { readonly id: string }[]): ReadonlySet<string> => new Set(list.map((item) => item.id));
const CATEGORY_IDS = ids(EXPERIENCE_CATEGORIES);
const AREA_IDS = ids(EXPERIENCE_AREAS);
const COMPANION_IDS = ids(EXPERIENCE_COMPANIONS);
const OCCASION_IDS = ids(EXPERIENCE_OCCASIONS);

export const isExperienceCategoryId = (value: unknown): value is ExperienceCategoryId => typeof value === "string" && CATEGORY_IDS.has(value);
export const isExperienceAreaId = (value: unknown): value is ExperienceAreaId => typeof value === "string" && AREA_IDS.has(value);

function pick<T extends string>(value: unknown, allowed: ReadonlySet<string>, order: readonly { readonly id: string }[]): T[] | null {
  if (!Array.isArray(value)) return null;
  const set = new Set<unknown>(value);
  if (set.size !== value.length || value.some((item) => typeof item !== "string" || !allowed.has(item))) return null;
  // Always in the lists' order, so the same choice is the same value.
  return order.filter((item) => set.has(item.id)).map((item) => item.id as T);
}

/** The classification a request means, or null when any part is not one of the lists' ids. */
export function parseExperienceClassification(value: unknown): ExperienceClassification | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort().join(",");
  if (keys !== "area,category,companions,occasions") return null;
  const { category, area } = input;
  if (category !== null && !isExperienceCategoryId(category)) return null;
  if (area !== null && !isExperienceAreaId(area)) return null;
  const companions = pick<ExperienceCompanionId>(input.companions, COMPANION_IDS, EXPERIENCE_COMPANIONS);
  const occasions = pick<ExperienceOccasionId>(input.occasions, OCCASION_IDS, EXPERIENCE_OCCASIONS);
  if (companions === null || occasions === null) return null;
  return { category: category as ExperienceCategoryId | null, area: area as ExperienceAreaId | null, companions, occasions };
}

export const experienceCategoryLabel = (id: string | null): string | null => EXPERIENCE_CATEGORIES.find((item) => item.id === id)?.label ?? null;
export const experienceAreaLabel = (id: string | null): string | null => EXPERIENCE_AREAS.find((item) => item.id === id)?.label ?? null;
