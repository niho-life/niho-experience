/**
 * 日本語トップの編集内容（#563）：写真・見出し・おすすめの選び方を、コードのこの1か所で決める。
 * 写真は、権利の確認できた既存の素材（public/sample/CREDITS.md の `niho-*`）だけを使う。
 */

export const JA_HOME_TITLE = "鎌倉の人に、会いにいく。";
export const JA_HOME_HAND = "meet the town";
export const JA_HOME_LEAD = "山を歩くガイド、台所に立つ料理家、五十年彫りつづける職人。鎌倉の街の人と、その人の時間を予約できます。";

/** 検索結果に出る題と説明（日本語のトップ）。 */
export const JA_HOME_SEO_TITLE = `${JA_HOME_TITLE} | NIHO Experience`;
export const JA_HOME_SEO_DESCRIPTION = JA_HOME_LEAD;

export type HeroPhoto = Readonly<{ src: string; position: string }>;
/** いちばん上の写真：人が交わる場面を数枚、数秒ごとに入れ替える（オーナー 2026-11-13）。 */
export const JA_HOME_HERO_PHOTOS: readonly HeroPhoto[] = [
  { src: "/sample/photos/niho-cd-table-02.jpg", position: "62% 45%" },
  { src: "/sample/photos/niho-cd-table-01.jpg", position: "50% 42%" },
  { src: "/sample/photos/niho-cd-kitchen-together.jpg", position: "50% 30%" },
  { src: "/sample/photos/niho-dinner-1.jpg", position: "50% 40%" },
  { src: "/sample/photos/niho-dinner-5.jpg", position: "50% 30%" },
];
export const HERO_ROTATE_MS = 5000;

/**
 * トップに紹介する街の人：事務局が選んだスラッグ。街の人に載っていない・外した人なら、載っている先頭の人にする。
 * 載っている人が0人のときは、街の人のまとまり自体を出さない。
 */
export const JA_HOME_FEATURED_PERSON_SLUG: string | null = null;
export const JA_HOME_FACES_LIMIT = 7;
/** トップに並べる読みもの（新しい順の先頭から）。公開中の記事が無いときは、読みもののまとまりを出さない。 */
export const JA_HOME_GUIDES_LIMIT = 3;

export function pickFeaturedPerson<T extends { slug: string }>(people: readonly T[], slug: string | null = JA_HOME_FEATURED_PERSON_SLUG): T | null {
  return people.find((person) => person.slug === slug) ?? people[0] ?? null;
}

/**
 * おすすめの体験：事務局が選んだ slug（上から順）。載っていない・公開していない slug は飛ばし、上限まで足りないぶんは
 * 公開中の体験で埋める。ここが空なら公開中の体験の先頭から。見出しに日付の条件（「今週末に行ける」など）は付けない。
 */
export const JA_HOME_PICK_SLUGS: readonly string[] = [];
export const JA_HOME_PICK_LIMIT = 6;

export function pickHomeExperiences<T extends { slug: string }>(items: readonly T[], picks: readonly string[] = JA_HOME_PICK_SLUGS, limit = JA_HOME_PICK_LIMIT): T[] {
  const bySlug = new Map(items.map((item) => [item.slug, item] as const));
  const chosen: T[] = [];
  for (const slug of picks) {
    const item = bySlug.get(slug);
    if (item && !chosen.includes(item)) chosen.push(item);
  }
  for (const item of items) {
    if (chosen.length >= limit) break;
    if (!chosen.includes(item)) chosen.push(item);
  }
  return chosen.slice(0, limit);
}

/* ---- カテゴリー・さがす欄・どんな日に・特集（#529・#563） ---- */

/**
 * 特集：1つのテーマの紹介と、その一覧への入口。テーマはカテゴリー（#529）で、8つぶんの紹介文をここに持つ（事務局の画面ではなく
 * コードの定数）。出すのは、公開中の体験が `JA_HOME_FEATURE_MIN` 件以上あるカテゴリーのうち、体験がいちばん多いもの
 * （同じ数なら定義の順）。載せるカテゴリーを固定せず、いま体験があるテーマが出る。
 */
export type HomeFeature = {
  readonly categoryId: string;
  readonly hand: string;
  readonly title: readonly [string, string];
  readonly text: string;
  readonly cta: string;
  readonly photos: readonly { readonly src: string; readonly position: string }[];
};
const photo = (name: string, position = "50% 50%") => ({ src: `/sample/photos/${name}.jpg`, position });

export const JA_HOME_FEATURES: readonly HomeFeature[] = [
  { categoryId: "walk", hand: "take a walk", title: ["ガイドと歩く、", "鎌倉の山と切通し"], text: "鎌倉の山は低いけれど、道が古い。地図では分からない分かれ道や切通しを、歩きなれた人と一緒に歩きます。", cta: "歩く体験を見る", photos: [photo("temple-path"), photo("bamboo"), photo("daibutsu", "40% 50%")] },
  { categoryId: "food", hand: "cook & eat", title: ["台所に立って、", "同じ食卓を囲む"], text: "市場で食材を選び、地元の人の台所で一緒につくって、同じテーブルで食べます。レシピより、その人の手つきが残ります。", cta: "つくる・食べる体験を見る", photos: [photo("dinner-cooking-together"), photo("dinner-long-table"), photo("dinner-oden")] },
  { categoryId: "craft", hand: "make by hand", title: ["つくり手のそばで、", "手を動かす"], text: "書く、繕う、染める。つくり手の隣で道具を持つと、うまくできるかより、手を動かす時間そのものが残ります。", cta: "手を動かす体験を見る", photos: [photo("calligraphy-brush"), photo("kintsugi-plates"), photo("mending-hands")] },
  { categoryId: "zen", hand: "sit quietly", title: ["静かな時間を、", "禅と寺で過ごす"], text: "坐る、点てる、写す。答えを持ち帰らなくても、問いがひとつ増えれば十分です。寺の静けさの入口へ。", cta: "禅と寺の体験を見る", photos: [photo("zazen-hall"), photo("zen-garden-view"), photo("temple-path")] },
  { categoryId: "time", hand: "dawn & dusk", title: ["観光客が来る前と、", "帰ったあとの鎌倉"], text: "朝の海辺や、夕暮れの路地。同じ街が、時間をずらすと別の顔を見せます。", cta: "朝と夜の体験を見る", photos: [photo("enoden-crossing"), photo("shichirigahama-fuji"), photo("kamakura-crossing")] },
  { categoryId: "sea", hand: "by the sea", title: ["海のそばで、", "材木座から葉山まで"], text: "材木座、逗子、葉山。海のそばで過ごす時間を、その土地の人の案内で。", cta: "海の体験を見る", photos: [photo("shichirigahama-fuji"), photo("enoden-crossing"), photo("kamakura-crossing")] },
  { categoryId: "people", hand: "meet someone", title: ["職人、店主、僧侶。", "話を聞きに行く"], text: "その人の仕事場で、その人の話を聞く。会ってみたい人に、会いにいく体験です。", cta: "人に会う体験を見る", photos: [photo("niho-cd-table-01"), photo("calligraphy-large"), photo("niho-cd-table-02")] },
  { categoryId: "group", hand: "all together", title: ["会社のチーム、学校、", "仲間の集まりに"], text: "人数や目的に合わせて、体験を組みます。まずは相談から、内容と進め方をご案内します。", cta: "団体・チームの体験を見る", photos: [photo("dinner-long-table"), photo("niho-cd-table-01"), photo("dinner-table-overhead")] },
];

/** 特集を出す、そのカテゴリーの公開中の体験の最少の件数。1件のテーマでも、一覧の入口として成り立つので1件から出す。 */
export const JA_HOME_FEATURE_MIN = 1;

/** 出す特集：体験が `JA_HOME_FEATURE_MIN` 件以上あるカテゴリーのうち、いちばん多いもの（同数なら定義の順）。無ければ null。 */
export function pickHomeFeature(cards: readonly { readonly classification: { readonly category: string | null } }[], min = JA_HOME_FEATURE_MIN): HomeFeature | null {
  let best: HomeFeature | null = null;
  let bestCount = 0;
  for (const feature of JA_HOME_FEATURES) {
    const count = cards.filter((card) => card.classification.category === feature.categoryId).length;
    if (count >= min && count > bestCount) { best = feature; bestCount = count; }
  }
  return best;
}

/** どんな日に行きますか：絞り込み（だれと／こんな日に）への入口。該当する体験が1件以上あるものだけ出す。 */
export const JA_HOME_OCCASIONS = [
  { param: "with", id: "solo", hand: "just me", label: "ひとりで", photo: "/sample/photos/zazen-hall.jpg" },
  { param: "with", id: "date", hand: "for two", label: "ふたりで", photo: "/sample/photos/shichirigahama-fuji.jpg" },
  { param: "with", id: "friends", hand: "with friends", label: "友人と", photo: "/sample/photos/dinner-around-table.jpg" },
  { param: "with", id: "family", hand: "with kids", label: "子どもと", photo: "/sample/photos/dinner-cooking-together.jpg" },
  { param: "occasion", id: "rain", hand: "rainy day", label: "雨の日に", photo: "/sample/photos/calligraphy-brush.jpg" },
  { param: "occasion", id: "anniv", hand: "special day", label: "特別な日に", photo: "/sample/photos/dinner-long-table.jpg" },
] as const;
export type HomeOccasion = (typeof JA_HOME_OCCASIONS)[number];

type Classified = { readonly classification: { readonly category: string | null; readonly companions: readonly string[]; readonly occasions: readonly string[] } };

/** 該当する体験が1件以上あるカテゴリー（定義の順）。 */
export function categoriesWithExperiences<C extends { id: string }>(categories: readonly C[], cards: readonly Classified[]): C[] {
  return categories.filter((category) => cards.some((card) => card.classification.category === category.id));
}

/** 該当する体験が1件以上ある「どんな日に」（定義の順）。 */
export function occasionsWithExperiences(cards: readonly Classified[]): HomeOccasion[] {
  return JA_HOME_OCCASIONS.filter((item) => cards.some((card) => (item.param === "with" ? card.classification.companions : card.classification.occasions).includes(item.id)));
}

export const occasionHref = (item: HomeOccasion): string => `/ja/experiences?${item.param}=${item.id}`;
