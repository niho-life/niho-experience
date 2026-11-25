/**
 * 日本語トップの編集内容（#563）：写真・見出し・おすすめの選び方を、コードのこの1か所で決める。
 * 写真は、権利の確認できた既存の素材（public/sample/CREDITS.md の `niho-*`）だけを使う。
 */

export const JA_HOME_TITLE = "鎌倉の人に、会いにいく。";
/** いちばん上の文。いまある体験に合わせている（体験が増えたら差し替える）。 */
export const JA_HOME_LEAD = "書家と筆をとる。寺で坐る。地元の台所で一緒につくって食べる。鎌倉の街の人と、その人の時間を予約できます。";

/** 検索結果に出る題と説明（日本語のトップ）。 */
export const JA_HOME_SEO_TITLE = `${JA_HOME_TITLE} | NIHO Travel`;
export const JA_HOME_SEO_DESCRIPTION = JA_HOME_LEAD;

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
