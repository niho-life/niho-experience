/**
 * 旅行者の一周（src/journey.ts）の合成データ。仮契約の mock だけが使う。
 *
 * - 合成の体験（`(sample)`）の文言は架空。
 * - pilot の体験は、fixture に既にある事実（pilot-experiences.ts の notSuitableFor・knowBeforeYouGo・languageNote・highlights）を
 *   条件の形に並べ直しただけで、新しい事実を足さない。オーナーが確認した原稿に置き換わるまでは推奨値。
 * - 条件の無い体験を残す（dinner など）。画面は「条件が空」でも崩れず、従来の Good to know の一覧へ戻ることを確かめる。
 */
import type { ExperienceConditions, ExperienceReview, ExperienceReviewSummary, ExperienceReviewsResponse, JourneyDetailExtras } from "../journey.ts";

const VERSION = "2026-10-22";

const CONDITIONS: Readonly<Record<string, ExperienceConditions>> = {
  // 承認制・同意の対象あり（年齢と段差）
  "indigo-dyeing-with-an-artisan": {
    version: VERSION,
    items: [
      { kind: "AGE", headline: "Ages 10 and up", detail: "Children must join with an adult", consentText: "Ages 10 and up" },
      { kind: "PHYSICAL", headline: "Standing and working with your hands", detail: "About 2 hours, with short breaks", consentText: null },
      { kind: "HOST_LANGUAGE", headline: "Hosted in Japanese and basic English", detail: "Step-by-step photo guide provided", consentText: null },
      { kind: "FOOD", headline: "Tea and a sweet after", detail: "Vegan option on request", consentText: null },
      { kind: "ACCESS", headline: "Not wheelchair accessible", detail: "Steps up to the studio", consentText: "Steps up to the studio" },
      { kind: "WEATHER", headline: "Rain or shine", detail: "Held indoors", consentText: null },
    ],
  },
  // 即時確定・取消なし。条件の一部だけ（食べもの・段差は無い）
  "seaside-cycling-and-market-breakfast": {
    version: VERSION,
    items: [
      { kind: "AGE", headline: "Ages 8 and up", detail: "Everyone rides their own bicycle", consentText: "Everyone can ride a bicycle confidently" },
      { kind: "PHYSICAL", headline: "Easy, mostly flat ride", detail: "Helmets provided, bikes fitted before we start", consentText: null },
      { kind: "HOST_LANGUAGE", headline: "Hosted in English", detail: null, consentText: null },
      { kind: "FOOD", headline: "Market breakfast included", detail: "Ask before booking if you avoid seafood", consentText: null },
      { kind: "WEATHER", headline: "Light rain is fine", detail: "Stops in heavy rain or strong wind", consentText: "The ride may stop in heavy rain or strong wind" },
    ],
  },
  // 予約を受けていない体験（同意の対象なし）
  "evening-pottery-session": {
    version: VERSION,
    items: [
      { kind: "AGE", headline: "Ages 12 and up", detail: null, consentText: null },
      { kind: "HOST_LANGUAGE", headline: "Japanese with English support", detail: null, consentText: null },
    ],
  },
  // pilot：fixture にある事実だけ（子どもは 12 歳未満不可・階段と坂・小雨は決行・椅子あり・英語の案内）
  "engakuji-zen-meditation": {
    version: VERSION,
    items: [
      { kind: "AGE", headline: "Ages 12 and up", detail: null, consentText: "Ages 12 and up" },
      { kind: "PHYSICAL", headline: "Seated meditation", detail: "A chair is available if sitting on the floor is difficult", consentText: null },
      { kind: "HOST_LANGUAGE", headline: "English-speaking guide", detail: null, consentText: null },
      { kind: "ACCESS", headline: "Hilly grounds with stairs and slopes", detail: "Not suitable if you can't manage stairs and slopes", consentText: "Hilly grounds with stairs and slopes" },
      { kind: "WEATHER", headline: "Goes ahead in light rain", detail: "Cancelled with a refund or another date in a heavy rain, storm or emergency warning", consentText: null },
    ],
  },
};

/**
 * レビュー（#19314）。合成の体験だけに置く（pilot は実在のホストなので、レビュー・実績は入れない：AGENTS.md）。
 * 名前に `(sample)` を付け、プレビューで実物と誤認させない。12 件（平均を出す）・1 件・2 件（件数と本文だけ）・0 件（dinner）を揃える。
 */
function review(id: string, displayName: string, originLabel: string, publishedAt: string, rating: ExperienceReview["rating"], body: string, tags: string[], reply: ExperienceReview["reply"] = null): ExperienceReview {
  return { id, rating, body, tags, displayName: `${displayName} (sample)`, originLabel, publishedAt, fromBooking: true, reply };
}

const REVIEWS: Readonly<Record<string, readonly ExperienceReview[]>> = {
  "indigo-dyeing-with-an-artisan": [
    review("rv-indigo-01", "Emma", "United Kingdom", "2026-10-14T03:00:00.000Z", 5, "The quiet of the studio in the morning was unforgettable. Aiko explained every step slowly and the photo guide helped a lot.", ["Beautiful results", "Friendly host"], { hostName: "Aiko (sample)", body: "Thank you for dyeing with us, Emma. Please come again when the days are cooler." }),
    review("rv-indigo-02", "Mei-ling", "Taiwan", "2026-10-09T03:00:00.000Z", 5, "A short walk from the station. I was nervous about dyeing cloth for the first time, but the steps were easy to follow.", ["Good for beginners", "Easy to find"]),
    review("rv-indigo-03", "Lucas", "France", "2026-10-02T03:00:00.000Z", 5, "My scarf came out deeper than I expected. We learned why indigo changes colour in the air.", ["Beautiful results"]),
    review("rv-indigo-04", "Sofia", "Brazil", "2026-09-28T03:00:00.000Z", 4, "A lovely morning. The studio is small, so book early if you come as a group.", ["Friendly host"]),
    review("rv-indigo-05", "Oliver", "Australia", "2026-09-21T03:00:00.000Z", 5, "Aiko was patient with my children, and the tea afterwards was a nice touch.", ["Friendly host", "Good for beginners"]),
    review("rv-indigo-06", "Hana", "Singapore", "2026-09-17T03:00:00.000Z", 5, "Simple, hands-on and relaxed. I took home a small cloth that I use every day.", ["Beautiful results"]),
    review("rv-indigo-07", "Mateo", "Spain", "2026-09-12T03:00:00.000Z", 5, "Clear English instructions with the guide sheet. Highly recommended.", ["Good for beginners"]),
    review("rv-indigo-08", "Anna", "Germany", "2026-09-08T03:00:00.000Z", 5, "A real craft, taught kindly. Worth the morning.", ["Friendly host", "Beautiful results"]),
    review("rv-indigo-09", "Chloe", "Canada", "2026-09-03T03:00:00.000Z", 5, "Easy to find and well organised.", ["Easy to find"]),
    review("rv-indigo-10", "Daniel", "United States", "2026-08-29T03:00:00.000Z", 5, "I booked on short notice and Aiko still made room for us.", ["Friendly host"]),
    review("rv-indigo-11", "Yuna", "South Korea", "2026-08-24T03:00:00.000Z", 5, "The colours of the finished cloth are lovely.", ["Beautiful results"]),
    review("rv-indigo-12", "Ben", "Ireland", "2026-08-19T03:00:00.000Z", 5, "A calm start to a day in Kamakura.", ["Good for beginners"]),
  ],
  "seaside-cycling-and-market-breakfast": [
    review("rv-cycling-01", "Noah", "Netherlands", "2026-10-05T03:00:00.000Z", 5, "An easy, flat ride and a great breakfast at the market.", ["Friendly host"]),
  ],
  "evening-pottery-session": [
    review("rv-pottery-01", "Isabel", "Mexico", "2026-09-30T03:00:00.000Z", 4, "A relaxed evening with plenty of help. The English support was enough for me.", ["Good for beginners"]),
    review("rv-pottery-02", "Tom", "United Kingdom", "2026-09-18T03:00:00.000Z", 5, "Fun and calm. I would come again.", ["Calm atmosphere"]),
  ],
};

function summarize(reviews: readonly ExperienceReview[]): ExperienceReviewSummary {
  if (reviews.length === 0) return { count: 0, average: null, tags: [] };
  const mean = reviews.reduce((total, item) => total + item.rating, 0) / reviews.length;
  const counts = new Map<string, number>();
  for (const item of reviews) for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const tags = [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { count: reviews.length, average: Math.round(mean * 10) / 10, tags };
}

/** 新しい順に `limit` 件と、全件の集計。`GET …/reviews?limit=` の mock の応答。 */
export function reviewsResponseFor(slug: string, limit: number): ExperienceReviewsResponse {
  const all = [...(REVIEWS[slug] ?? [])].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return { summary: summarize(all), reviews: all.slice(0, Math.max(0, limit)) };
}

/** 詳細の SSR が読む件数（"Show all N reviews" でそれ以上を読む）。 */
export const REVIEWS_ON_DETAIL = 3;

/** 予約前の質問を受け付けない体験（予約を受けていない体験）。 */
const QUESTIONS_CLOSED: ReadonlySet<string> = new Set(["evening-pottery-session"]);

export function journeyExtrasFor(slug: string): JourneyDetailExtras {
  const { summary, reviews } = reviewsResponseFor(slug, REVIEWS_ON_DETAIL);
  return { enabled: true, conditions: CONDITIONS[slug] ?? null, questionsOpen: !QUESTIONS_CLOSED.has(slug), reviews: { status: "ok", summary, items: reviews } };
}
