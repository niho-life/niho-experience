# 検索公開の方針（画面側）

[#12](https://github.com/niho-life/niho-experience/issues/12) のうち、サイト基盤担当が実装した部分と、商品・集客担当（担当3）と決める部分をまとめる。公開ドメインは未定のため、URLは `SITE_URL` からの相対で考える。

## URL

| URL | 内容 | index | canonical |
| --- | --- | --- | --- |
| `/` | トップ | する | `/` |
| `/experiences` | 一覧 | する | `/experiences` |
| `/experiences?q=…&theme=…&date=…&guests=…` | 検索・絞り込みURL | しない（`noindex, follow`。テーマ・開催日のAPI絞り込みはv1.2有効時だけ使用） | `/experiences` |
| `/experiences/{slug}` | 体験詳細 | する | 自分自身 |
| `/host` | 提供者向けの紹介（ログイン前） | する | `/host` |
| `/host/*` | ホストの画面（ログイン後） | しない（`noindex` ＋ `no-store`、robots.txtでも除外） | — |
| `/experiences/{slug}/book` | 予約入力 | しない（`noindex` ＋ `no-store`、robots.txtでも除外） | — |
| `/booking/return` | 決済後 | しない（同上） | — |
| `/preview/*` | mock専用 | 本番には存在しない（404） | — |

- slugは英小文字・数字・ハイフン。変更する時は旧URLからのリダイレクトをAPI側に持つ（#7で要望済み）。
- 一覧はページ分割しない（数件のため）。増えた時に方針を追加する。
- 掲載をやめた体験はAPIが返さず404になる。販売停止中（掲載は継続）は「Bookings paused」を表示したままindexしてよい。
- 言語は英語のみ。他言語版ができるまで `hreflang` は出さない。`<html lang="en">`。

## 検索公開のスイッチ

- `SITE_INDEXING=allow` **かつ** `EXPERIENCE_API_MODE=http` の時だけindexを許可する。それ以外（プレビュー・合成データ）は全ページ `noindex, nofollow`、robots.txtは全体を拒否、sitemapは空。
- 値はリクエスト時に読むので、同じイメージのまま環境変数だけで切り替えられる。
- 本番で有効にするのは公開受入（#15）の後。

## 初期HTMLに入れるもの

Server Componentで描画し、JavaScriptなしで次が読める（E2Eの `seo.spec.ts` で確認）。

- 題名（h1）、要約、提供者名、所要時間、言語、料金（円・単位）、取消条件、販売者
- 一覧から各体験へのリンク、詳細から一覧へのパンくず
- `title`・`description`・canonical・Open Graph

## 構造化データ

- 体験詳細：`BreadcrumbList`、HTTP APIの実データの時だけ `TouristTrip`（題名・要約・URL・公開写真・言語・提供者）。予約受付中なら画面に表示する最安の大人料金と販売者を `Offer` に含める。
- SSR詳細応答に残席がないため、構造化データに `availability` を入れない。残席はブラウザから取得し、予約時に再確認する。サイト全体の予約停止中も `Offer` を出さない。
- トップ・一覧・提供者案内・詳細のcanonicalとOG URLを揃え、queryを引き継がない。詳細の正規URLはAPIが正本。未承認のOG画像は出さず、Twitterカードは画像不要の `summary` とする。
- 合成データ・仮素材の写真では出さない（プレビューの合成のレビューも出さない）。販売実績は実データがあっても、このサイトが表示していない限り出さない。
- レビュー：HTTP APIの実データで、**平均が画面に出ている（3 件以上）ときだけ** `aggregateRating`（`ratingValue`・`reviewCount`・1〜5）と、画面に出している新しい順の `review`（`reviewRating`・`author`＝表示名・`datePublished`・`reviewBody`）を `TouristTrip` に載せる。1〜2 件・0 件・読めなかったときは何も出さない。提供者の返信・よかった点・予約の識別子は載せない。NIHO が確認して公開した、予約者のレビューだけを対象にする（[seo-content-policy.md](growth/seo-content-policy.md)）。
- リッチリザルトやAIの回答に載ることは保証しない。

## 担当3と決めること

- 英語の題名・説明文・検索語（実商品の原稿確定時）
- 写真の掲載許諾と代替文、Open Graph用画像（実写真ができてから。仮素材は出さない）
- NIHO既存の企画ページとの重複時、どちらを正規URLにするか（連携A・#7）
- 公開後のSearch Console確認：sitemap送信、代表URLのURL検査、カバレッジの確認手順と担当者（データは公開Issueに貼らない）
