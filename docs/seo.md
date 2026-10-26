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
| `/guides` | ガイド記事の一覧（公開記事が 1 本以上あるときだけ。無ければ 404） | する | `/guides` |
| `/guides/{slug}` | ガイド記事（下の「ガイド記事」） | する | 自分自身 |
| `/help` | 予約のヘルプ（NIHOのヘルプと問い合わせ先への案内） | しない（`noindex, follow`。理由は下の「`/help` の扱い」） | — |
| `/host/*` | ホストの画面（ログイン後） | しない（`noindex` ＋ `no-store`、robots.txtでも除外） | — |
| `/experiences/{slug}/book` | 予約入力 | しない（`noindex` ＋ `no-store`、robots.txtでも除外） | — |
| `/booking/return` | 決済後 | しない（同上） | — |
| `/preview/*` | mock専用 | 本番には存在しない（404） | — |

- slugは英小文字・数字・ハイフン。変更する時は旧URLからのリダイレクトをAPI側に持つ（#7で要望済み）。
- 一覧はページ分割しない（数件のため）。増えた時に方針を追加する。
- 掲載をやめた体験はAPIが返さず404になる。販売停止中（掲載は継続）は「Bookings paused」を表示したままindexしてよい。
- 言語は英語が既定（`<html lang="en">`）。`hreflang` はトップ・一覧・`/host`・体験詳細が自分自身（`en`）と `x-default` を出す。承認済みの日本語版が実在するページだけ `ja` を足す（日本語版の詳細は `en`・`ja`・`x-default` を相互に出す）。実在しない言語版は書かない。
- 一覧の `title`・`description` は共有文言（`catalogue.metaTitle` / `catalogue.metaDescription`）から取る。[seo-content-policy.md](growth/seo-content-policy.md) で決めた文言と同じ。

## `/help` の扱い

index しない（`noindex, follow`）。ページの中身は、NIHOのヘルプと問い合わせ先、確認メールの探し方への案内だけで、取消条件・アカウントの要否のような回答になる事実は載せていない。それらは各体験の詳細（index する）が持つ。回答になる本文（よくある質問）を `/help` に足した時に index へ切り替え、`robots` の指定を外し、sitemapに加え、`englishAlternates("/help")` を使う。

## 初期HTMLの `<head>`

`title`・`description`・canonical・`robots`・`hreflang` は、JavaScriptを実行しないクローラーのために、最初のHTMLの `<head>` に入れる。Next は既定でメタデータを本文の後に流す（streaming metadata。一覧は `loading.tsx` があり、devサーバーで再現する）ので、`next.config.ts` の `htmlLimitedBots` に Googlebot・GPTBot・OAI-SearchBot・ChatGPT-User・ClaudeBot・PerplexityBot などを足し、これらにはメタデータを待ってから返す。

- この設定は Next の既定の一覧を置き換える。既定の一覧も同じ正規表現に含めている（追加する時は `HTML_LIMITED_BOTS` に足す）。
- 通常のブラウザは従来どおり流す。
- 確認：`e2e/seo.spec.ts` が、各クローラーのUAで `/`・`/experiences`・`/experiences?theme=craft`・体験詳細・`/host` を取得し、5つの値が `</head>` より前にあることを検査する。
- 本番ビルド（`npm run build && npm start`）では、通常のUAでもモックの応答が速いため後送りは起きなかった（2026-10-26、モック遅延400msも同じ）。実APIでは応答が遅れるので、この設定で保証する。

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

- トップ：`Organization`（名称・URLだけ。ロゴは承認済み素材が出てから）と `WebSite`。
- 体験詳細（英語・日本語とも同じ条件）：`BreadcrumbList`、HTTP APIの実データの時だけ `TouristTrip` と `Product`。どちらも題名・要約・URL・公開写真を持ち、`TouristTrip` は言語・提供者、`Product` は提供者を `brand` に持つ。`TouristTrip` はGoogleのリッチリザルトの対象外なので、星や料金の表示を狙うのは `Product`。予約受付中なら画面に表示する最安の大人料金と販売者を `Offer` に含める。日本語版は自分のURL（`/ja/experiences/{slug}`）と `inLanguage: ja` で出し、レビューは日本語版に表示していないので出さない。
- SSR詳細応答に残席がないため、構造化データに `availability` を入れない。残席はブラウザから取得し、予約時に再確認する。サイト全体の予約停止中も `Offer` を出さない。
- トップ・一覧・提供者案内・詳細のcanonicalとOG URLを揃え、queryを引き継がない。詳細の正規URLはAPIが正本。未承認のOG画像は出さず、Twitterカードは画像不要の `summary` とする。
- 合成データ・仮素材の写真では出さない（プレビューでは `TouristTrip`・`Product` を出さず、合成のレビューも出さない）。販売実績は実データがあっても、このサイトが表示していない限り出さない。
- レビュー：HTTP APIの実データで、**平均が画面に出ている（3 件以上）ときだけ** `aggregateRating`（`ratingValue`・`reviewCount`・1〜5）と、画面に出している新しい順の `review`（`reviewRating`・`author`＝表示名・`datePublished`・`reviewBody`）を `TouristTrip` と `Product` の両方に同じ値で載せる。1〜2 件・0 件・読めなかったときは何も出さない。提供者の返信・よかった点・予約の識別子は載せない。NIHO が確認して公開した、予約者のレビューだけを対象にする（[seo-content-policy.md](growth/seo-content-policy.md)）。
- リッチリザルトやAIの回答に載ることは保証しない。

## ガイド記事

[#145](https://github.com/niho-life/niho-experience/issues/145)。原稿の置き場所は [ADR 0002](adr/0002-guide-content.md)、書き方と公開手順は [content/guides.md](content/guides.md)。

- **データ**：公開済みの記事だけを `apps/web/src/content/guides/` に 1 記事 1 モジュールで置き、`index.ts` の `PUBLISHED_GUIDES` に足す。項目は `slug`・`title`（110 字まで）・`description`（160 字まで）・`author { name, role }`・`publishedAt`・`updatedAt`（`YYYY-MM-DD`）・任意の `hero { src, alt, width, height, licensed }`・`relatedExperienceSlugs`（2〜3）・`relatedGuideSlugs`・`faq`・`body`・`translations.ja`（構造だけ）。本文はリポ内のパーサーで読む Markdown のサブセットで、生の HTML を出さない。対応外の書き方・安全でないリンクは unit test（`guides.test.ts`）で落ちる。
- **表示**：Server Component で、h1・著者（名前と役割）・公開日と更新日（画面の文字）・ヒーロー画像・本文・FAQ（h2 と質問ごとの h3）・予約できる体験のカード（2〜3 件。カタログに無いものは飛ばし、カタログが読めなければ節ごと出さない）・関連記事を最初の HTML に入れる。体験の詳細（英語版）には、その体験を `relatedExperienceSlugs` に持つ記事への枠（"Guides for your visit"）を出し、無ければ出さない。
- **公開の範囲**：実 API（`EXPERIENCE_API_MODE=http`）では公開記事だけ。0 本の間は `/guides`・`/guides/{slug}` が 404、sitemap に載せず、フッターのリンクも出さない。mock のプレビューだけ合成のサンプル記事（`samples/`・題名と著者に `(sample)`）を足す。`robots` はほかの公開ページと同じ（検索公開のスイッチが off なら `noindex, nofollow`）。
- **メタデータ**：`title`・`description`・自己参照の canonical・Open Graph（`type: article`・`publishedTime`・`modifiedTime`）を `<head>` に入れる（`htmlLimitedBots` の対象。`e2e/guides.spec.ts` が Googlebot・GPTBot の UA で確かめる）。OG 画像は `hero.licensed` が true のときだけ。Twitter カードは `summary`。
- **構造化データ**：`Article`（`headline`・`description`・`url`・`mainEntityOfPage`・`inLanguage: en`・`author`＝`Person`〔`name`・`jobTitle`〕・`datePublished`・`dateModified`・`publisher`＝トップの `Organization` と同じ `@id`・名称・URL。`image` は `hero.licensed` のときだけ）と `BreadcrumbList`（Home › Guides › 題名）。一覧は `BreadcrumbList`（Home › Guides）だけ。FAQ の構造化データ（`FAQPage`）は出さない（Google のリッチリザルトの対象外。画面の FAQ と一致させるだけ）。`Article` は画面にある事実だけなので、プレビューのサンプル記事にも出す（プレビューは `noindex`）。
- **sitemap**：公開記事があるときだけ `/guides`（最新の `updatedAt`）と各記事（`lastModified` = `updatedAt`）を足す。プレビューと検索公開 off の sitemap は従来どおり空。
- **hreflang**：`en` と `x-default`（自分自身）。`ja` は、その記事に `translations.ja` があり**かつ**日本語の記事のページが実在するときだけ足す（`locale-metadata.ts` と同じ考え方）。`/ja/guides` はまだ無い（#59）ので、今はどの記事にも `ja` を出さない。

## 担当3と決めること

- 英語の題名・説明文・検索語（実商品の原稿確定時）
- 写真の掲載許諾と代替文、Open Graph用画像（実写真ができてから。仮素材は出さない）
- NIHO既存の企画ページとの重複時、どちらを正規URLにするか（連携A・#7）
- 公開後のSearch Console確認：sitemap送信、代表URLのURL検査、カバレッジの確認手順と担当者（データは公開Issueに貼らない）
