/**
 * 旅行者の一周（src/journey.ts）の合成データ。仮契約の mock だけが使う。
 *
 * - 合成の体験（`(sample)`）の文言は架空。
 * - 参加の条件の文は、NIHO が組む文（niho-coliving/niho-app#19335 の `buildSpotCampaignPagePublicConditionItems`・英語）の出力。
 *   画面は文を組み立てないので、ホストが入力する項目の例を各体験の上に書き、そこから NIHO の組み立てで出る文をそのまま置く。
 *   `version` は NIHO と同じ算出（項目 `{ kind, headline, detail, consentText }` の JSON の SHA-256）で、test が再計算して一致を確かめる。
 * - pilot の体験は、fixture に既にある事実（pilot-experiences.ts の notSuitableFor・knowBeforeYouGo・languageNote・highlights）を
 *   条件の形に並べ直しただけで、新しい事実を足さない。オーナーが確認した原稿に置き換わるまでは推奨値。
 * - 条件の無い体験を残す（dinner など）。画面は「条件が空」でも崩れず、従来の Good to know の一覧へ戻ることを確かめる。
 */
import type { ExperienceConditions, ExperienceFaqItem, ExperienceReview, ExperienceReviewSummary, ExperienceReviewsResponse, JourneyDetailExtras } from "../journey.ts";

const CONDITIONS: Readonly<Record<string, ExperienceConditions>> = {
  // 承認制・同意の対象あり（年齢・体の負担・段差）。
  // ホストの入力：年齢 10 歳から＋大人と一緒／体の負担＝長く立つ（補足あり）／ホストの言語＝日本語・英語はかんたんな言葉／
  // 食べもの＝出る（ヴィーガン対応）／車いすは不可（段差）／雨でも開催
  "indigo-dyeing-with-an-artisan": {
    version: "7c9340a7f490d0dc41335c18725f27cf53c9c5ea5eb94997cd1c157c4672b703",
    items: [
      { kind: "AGE", headline: "Ages 10 and up", detail: "Children must join with an adult", consentText: "Ages 10 and up · Children must join with an adult" },
      { kind: "PHYSICAL", headline: "Standing for a long time", detail: "Working with your hands · about 2 hours, with short breaks", consentText: "Standing for a long time (Working with your hands · about 2 hours, with short breaks)" },
      { kind: "HOST_LANGUAGE", headline: "Hosted in Japanese and basic English", detail: "Step-by-step photo guide provided", consentText: null },
      { kind: "FOOD", headline: "Tea and a sweet after", detail: "Vegan option on request", consentText: null },
      { kind: "ACCESS", headline: "Not wheelchair accessible", detail: "Steps up to the studio", consentText: "Steps up to the studio" },
      { kind: "WEATHER", headline: "Rain or shine", detail: "Held indoors", consentText: null },
    ],
  },
  // 即時確定・取消なし。条件の一部だけ（段差は無い）。
  // ホストの入力：年齢 8 歳から（補足あり）／体の負担＝種類は選ばず補足だけ／ホストの言語＝英語／食べもの＝出る（対応食なし）／荒天は中止
  "seaside-cycling-and-market-breakfast": {
    version: "88f81488ba31bff2e338e296d4636696591c54b689d3fc3c2acfa52edb201292",
    items: [
      { kind: "AGE", headline: "Ages 8 and up", detail: "Everyone rides their own bicycle", consentText: "Ages 8 and up" },
      { kind: "PHYSICAL", headline: "Physical activity", detail: "Easy, mostly flat ride · helmets provided, bikes fitted before we start", consentText: "Physical activity (Easy, mostly flat ride · helmets provided, bikes fitted before we start)" },
      { kind: "HOST_LANGUAGE", headline: "Hosted in English", detail: null, consentText: null },
      { kind: "FOOD", headline: "Market breakfast included", detail: null, consentText: null },
      { kind: "WEATHER", headline: "May be cancelled in bad weather (full refund)", detail: "Light rain is fine", consentText: null },
    ],
  },
  // 予約を受けていない体験。条件はあるが同意の文が無い（言語と雨の日だけ）。ホストの入力：ホストの言語＝日本語・英語はかんたんな言葉／雨でも開催
  "evening-pottery-session": {
    version: "12f090e58a895f34f89af3ec27413e794b3ec110f77dc5154a2361b518e45827",
    items: [
      { kind: "HOST_LANGUAGE", headline: "Hosted in Japanese and basic English", detail: null, consentText: null },
      { kind: "WEATHER", headline: "Rain or shine", detail: "Held indoors", consentText: null },
    ],
  },
  // pilot：fixture にある事実だけ（12 歳未満不可・床に座る/椅子あり・英語の案内・階段と坂・小雨は決行/荒天は中止と全額返金）。
  // ホストの入力：年齢 12 歳から／体の負担＝床に座る（椅子の補足）／ホストの言語＝英語／車いすは不可（階段と坂）／荒天は中止（小雨は決行）
  "engakuji-zen-meditation": {
    version: "82963b1416024a229a7b3148b8dd0807c497f7fadd0e306695ab3a9f4d59f48b",
    items: [
      { kind: "AGE", headline: "Ages 12 and up", detail: null, consentText: "Ages 12 and up" },
      { kind: "PHYSICAL", headline: "Sitting on the floor", detail: "A chair is available if sitting on the floor is difficult", consentText: "Sitting on the floor (A chair is available if sitting on the floor is difficult)" },
      { kind: "HOST_LANGUAGE", headline: "Hosted in English", detail: null, consentText: null },
      { kind: "ACCESS", headline: "Not wheelchair accessible", detail: "Hilly grounds with stairs and slopes", consentText: "Hilly grounds with stairs and slopes" },
      { kind: "WEATHER", headline: "May be cancelled in bad weather (full refund)", detail: "Goes ahead in light rain", consentText: null },
    ],
  },
};

/**
 * scenario 用の条件。`checkout-conditions-added`：条件を持たない体験に、予約の途中で同意が要る条件が足された状態。
 * `checkout-conditions-outdated`：同意が要る条件の文が予約の途中で変わった状態（`changedConditions`）。
 */
export const ADDED_CONDITIONS: ExperienceConditions = {
  version: "7e4108334b398fde41cc94c177591b1ee7fd3c8e43e4a80cad26fdd1b5ea92c7",
  items: [{ kind: "AGE", headline: "Ages 6 and up", detail: "Younger children cannot join this session", consentText: "Ages 6 and up" }],
};

/** 同意の文を 1 つ書き換え、版を変える（mock のブラウザ側は SHA-256 を計算しないので、版は 1 文字だけ変える。scenario 専用）。 */
export function changedConditions(base: ExperienceConditions): ExperienceConditions {
  const index = base.items.findIndex((item) => item.consentText !== null);
  const version = `${base.version.startsWith("0") ? "1" : "0"}${base.version.slice(1)}`;
  return { version, items: base.items.map((item, at) => (at === index && item.consentText ? { ...item, consentText: `${item.consentText} · Updated by the host` } : item)) };
}

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

/**
 * よくある質問（#146・仮契約）。合成の体験だけに置く（pilot の FAQ はホストとオーナーの原稿が確定してから。AGENTS.md）。
 * 答えは合成の dinner の fixture（experiences.ts）にある事実に合わせ、足した事実（エプロン等）も架空。
 * 服装・言語・子ども・遅刻・雨・アレルギー・写真・持ち帰り・取消・支払いの 10 の話題を揃える。FAQ の無い体験も残す。
 */
const FAQ: Readonly<Record<string, readonly ExperienceFaqItem[]>> = {
  "home-cooked-dinner-with-locals": [
    { question: "What should I wear?", answer: "Comfortable everyday clothes. Shoes come off at the entrance, so wear socks you are happy to show. Aprons are provided." },
    { question: "What language is the dinner in?", answer: "English and Japanese. Yui (sample) explains each step in English, and the other guests and neighbours often switch between both." },
    { question: "Can I bring children?", answer: "Yes. Children aged 6 to 12 can join with an adult at the child price. The kitchen has knives and hot pans, so younger children cannot join this session." },
    { question: "What if I'm running late?", answer: "Cooking starts at 6:20 PM. If you are running late, come in when you arrive and join the step the group is on. Reply to your booking email if you will be more than 30 minutes late." },
    { question: "What happens if it rains?", answer: "The dinner is held indoors in the living room, so it goes ahead in any weather." },
    { question: "Can you cater for allergies or a vegetarian diet?", answer: "Vegetarian dishes are available on request: tell the host in the booking question. The kitchen also uses wheat, so a fully gluten-free meal cannot be promised." },
    { question: "Can I take photos?", answer: "Yes, of the food and the room. Please ask before you photograph other guests or neighbours." },
    { question: "Do I take anything home?", answer: "You take home a recipe card in English for the dishes you cooked." },
    { question: "What is the cancellation policy?", answer: "Free cancellation until 24 hours before the start. After that, the booking cannot be refunded." },
    { question: "How do I pay?", answer: "You pay online when you book, in Japanese yen with tax included, through Stripe's secure checkout. Nothing else is charged on the day." },
    { question: "Are drinks included?", answer: "Soft drinks are included. Alcohol is not included." },
    { question: "Do I need to know how to cook?", answer: "No. Chopping, plating and tasting are all part of it, and the host shows each step." },
    { question: "How do I find the meeting place?", answer: "It is about 10 minutes on foot from the nearest station (sample). Ring the bell at the wooden door." },
  ],
};

/** 予約前の質問を受け付けない体験（予約を受けていない体験）。 */
const QUESTIONS_CLOSED: ReadonlySet<string> = new Set(["evening-pottery-session"]);

export function journeyExtrasFor(slug: string): JourneyDetailExtras {
  const { summary, reviews } = reviewsResponseFor(slug, REVIEWS_ON_DETAIL);
  return { enabled: true, conditions: CONDITIONS[slug] ?? null, questionsOpen: !QUESTIONS_CLOSED.has(slug), reviews: { status: "ok", summary, items: reviews }, faq: [...(FAQ[slug] ?? [])] };
}
