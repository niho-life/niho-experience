/**
 * 日本語トップの編集内容（#563）：写真・見出し・おすすめの選び方を、コードのこの1か所で決める。
 * 写真は、権利の確認できた既存の素材（public/sample/CREDITS.md の `niho-*`）だけを使う。
 */

/** いちばん上の文。いまある体験に合わせている（体験が増えたら差し替える）。 */
export const JA_HOME_LEAD = "書家と筆をとる。寺で坐る。地元の台所で一緒につくって食べる。鎌倉の街の人と、その人の時間を予約できます。";

/** 検索結果に出る題と説明（日本語のトップ）。 */
export const JA_HOME_SEO_TITLE = "鎌倉の人に、会いにいく。 | NIHO Travel";
export const JA_HOME_SEO_DESCRIPTION = JA_HOME_LEAD;

/**
 * トップに紹介する街の人：事務局が選んだスラッグ。街の人に載っていない・外した人なら、載っている先頭の人にする。
 * 載っている人が0人のときは、街の人のまとまり自体を出さない。
 */
export const JA_HOME_FEATURED_PERSON_SLUG: string | null = null;
export const JA_HOME_FACES_LIMIT = 7;

export function pickFeaturedPerson<T extends { slug: string }>(people: readonly T[], slug: string | null = JA_HOME_FEATURED_PERSON_SLUG): T | null {
  return people.find((person) => person.slug === slug) ?? people[0] ?? null;
}
