# ADR 0002：ガイド記事の原稿の置き場所

- 状態：採用
- 日付：2026-10-26
- 関連：[#145 ガイド記事の仕組み](https://github.com/niho-life/niho-experience/issues/145)、[#59 日本語版](https://github.com/niho-life/niho-experience/issues/59)、[#139 index 化前の技術面](https://github.com/niho-life/niho-experience/issues/139)

## 背景

- 戦略の柱（夕方〜夜、座禅、手仕事、計画の拠点、Meet the Hosts）は記事で取るが、サイトには体験ページと静的ページしかなく、記事を出す経路が無い。
- [architecture.md](../architecture.md) は、公開SSR・SEOをこのリポに、提供者・体験の原稿・写真・商品の正本をNIHO共通基盤に割り当てている。
- ガイド記事は提供者の原稿ではなく、NIHO Experience 自身の編集原稿（著者・更新日を出す読み物）である。体験の正本・掲載審査・権限の仕組みを必要としない。
- 当面の本数は少なく（数本〜十数本）、書き手も限られる。汎用CMSを立てるほどの更新頻度・人数はない（architecture.md「初日から汎用CMS…を完成させる必要はない」）。

## 比べた案

| 案 | 長所 | 注意点 | 判断 |
| --- | --- | --- | --- |
| **リポ内の TypeScript モジュール（1記事1ファイル）** | 型で項目の漏れを止められる。本文の検査を unit test で CI に載せられる。ビルドに同梱され、実行時のファイル読み込み・外部依存が無い | 公開は PR とデプロイが要る。書き手は Git を使う（または編集担当に渡す） | **採用** |
| リポ内の Markdown/MDX ＋ YAML 前付け | 書き手に馴染みがある | MDX は任意の JSX を書ける（安全な描画の境界が崩れる）。前付けの型検査・実行時の fs 読み込みが要る。依存が増える | 不採用 |
| NIHO 側の CMS（共通基盤の API） | 非エンジニアが画面から公開できる | NIHO 側に新しい原稿の型・権限・審査・API が要り、連携担当の作業が増える。記事は NIHO の正本である必要がない | 今は不採用。本数・書き手が増えたら再検討 |

## 決定

- 公開済みのガイドは `apps/web/src/content/guides/` に **1記事1つの TypeScript モジュール**で置き、`index.ts` の `PUBLISHED_GUIDES` に足す。**未公開の原稿（下書き）はコミットしない**（公開リポのため。下書きは別の場所で書き、公開の PR で初めて入れる）。
- 項目は型で決める（`types.ts`）：`slug`、`title`、`description`、`author`（実名・役割）、`publishedAt`・`updatedAt`（`YYYY-MM-DD`）、任意の `hero`（`licensed` で共有可否）、`relatedExperienceSlugs`（2〜3）、`relatedGuideSlugs`、`faq`、`body`、`translations.ja`（構造だけ。`/ja/guides` は #59 まで無い）。
- 本文は小さな Markdown のサブセット（見出し `##`・`###`、段落、`-` と `1.` の箇条書き、`**太字**`・`*斜体*`・`[文](リンク)`）。リポ内のパーサー（`apps/web/src/lib/guide-markdown.ts`）が React 要素の木にし、生の HTML・`dangerouslySetInnerHTML` は使わない。リンクはサイト内のパスか https だけ。対応外の書き方は例外にし、unit test（`guides.test.ts`）が登録済みの全記事を検査するので、壊れた記事は CI で落ちる。
- mock のプレビューだけ、合成のサンプル記事（`samples/`）を登録する。実 API の配備で公開記事が 0 本の間は、`/guides` と `/guides/{slug}` は 404、sitemap・フッターに記事は出ない。

## 結果

- 公開の手順は「原稿をモジュールにする → PR（CI で検査）→ レビュー → マージ → デプロイ」。更新も同じで、`updatedAt` を変える（[docs/content/guides.md](../content/guides.md)）。
- 記事の公開・更新に NIHO 側の作業は要らない。体験の正本・予約・価格には触れない（体験は slug で参照し、カタログに無いものは表示しない）。
- 書き手が増える・更新が頻繁になる・非エンジニアが直接公開したくなった時点で、NIHO 側の CMS（選別された公開 API）へ移す案を再検討する。そのときも型（`Guide`）と描画（パーサー・ページ）は再利用できる。
