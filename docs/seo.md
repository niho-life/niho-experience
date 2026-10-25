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
| `/help` | 予約のヘルプ（NIHOのヘルプと問い合わせ先への案内） | しない（`noindex, follow`。理由は下の「`/help` の扱い」） | — |
| `/host/*` | ホストの画面（ログイン後） | しない（`noindex` ＋ `no-store`、robots.txtでも除外） | — |
| `/experiences/{slug}/book` | 予約入力 | しない（`noindex` ＋ `no-store`、robots.txtでも除外） | — |
| `/booking/return` | 決済後 | しない（同上） | — |
| `/ja/experiences/{slug}/book`・`/ja/booking/return` | 日本語版の予約入力・決済後 | しない（同上） | — |
| `/admin` | 事務局の予約支援 | しない（`noindex, nofollow` ＋ `no-store`、robots.txtでも除外） | — |
| `/indexnow-key.txt` | IndexNow の鍵（下の「IndexNow」） | 検索公開中だけ返す。それ以外は404 | — |
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

## クローラーと AI 検索（robots.txt）

[#141](https://github.com/niho-life/niho-experience/issues/141)。実装は `apps/web/src/lib/robots-policy.ts`、検査は同じ場所の `robots-policy.test.ts`（各クローラーが公開ページを読め、予約・決済後・`/preview/`・`/host/`・`/admin` を読めないこと）と `e2e/seo.spec.ts`（プレビューでは全体拒否で、鍵ファイルも無いこと）。

| 区分 | User-Agent | 扱い |
| --- | --- | --- |
| 検索・AI 検索 | `Googlebot`、`Bingbot`、`OAI-SearchBot`、`ChatGPT-User`、`Claude-SearchBot`、`Claude-User`、`PerplexityBot`、`Perplexity-User`、`Applebot` | 名指しで許可（予約などは除外） |
| 学習用 | `GPTBot`、`Google-Extended`、`ClaudeBot`、`anthropic-ai`、`Applebot-Extended`、`CCBot` | **オーナー判断待ち**。今は `*` と同じ扱い（許可）。拒否する場合は `TRAINING_CRAWLER_POLICY` を `"disallow"` にする |
| その他 | `*` | 許可（予約などは除外） |

- 検索に出るために読ませる相手を名指しにしたのは、`*` の扱いを将来変えても検索・AI 検索の許可が巻き添えで消えないようにするため。名指しのグループを持つクローラーは `*` を読まないので、除外するパスは各グループに同じものを書く。
- ChatGPT 検索は Bing の索引も使う（二次情報）。`OAI-SearchBot` を拒否すると ChatGPT 検索の回答に出なくなる（OpenAI の公開文書）。Anthropic の検索用は `Claude-SearchBot` で、`ClaudeBot` は学習用（Anthropic の公開文書）。Issue 本文の「ClaudeBot は検索用」は、この区分に直した。
- 学習用を拒否しても検索結果・AI 検索の回答への表示には影響しない。許可すると、モデルが鎌倉の体験や NIHO を知っている状態になりうる。どちらを取るかはオーナーが決め、決定日をこの表に書く。
- `*-User` は利用者が AI に頼んだ時にページを取りに来るもの。robots.txt に従わない場合があると OpenAI・Perplexity は書いているので、守りたいページは robots.txt でなく `noindex`・`no-store`・認証で守る（今の作り）。
- `llms.txt` は作らない。Google は不要と明記しており、Ahrefs の調査では置かれたファイルの 97% に AI からの取得が無かった。

## IndexNow

公開ページの追加・更新を Bing など IndexNow 参加の検索エンジンへ知らせる（Google は参加していない）。効果の直接の証拠は無いので最小の作りにする。

- 鍵は `apps/web/src/lib/indexnow.ts` の `INDEXNOW_KEY`。誰でも `/indexnow-key.txt` から読める前提の値で秘密ではないため、コードに置く（Secret Manager に入れない）。替える時はこの値を変えて配備する。
- `/indexnow-key.txt` は検索公開中（`SITE_INDEXING=allow` かつ実 API）だけ鍵を返し、それ以外は404。
- 送信は手動：検索公開の開始時、体験やページを公開・更新した時に `node scripts/indexnow-submit.mjs` を実行する。`--dry-run` で送る中身の確認、`--since YYYY-MM-DD` で sitemap の `lastmod` がその日以降の URL だけ、引数に URL を並べるとその URL だけを送る。鍵ファイルが404なら送らずに終わる。
- 自動化（公開・更新のたびに送る）は、効果が見えてから NIHO 側の公開処理と合わせて考える。

## 登録先（Search Console・Bing Webmaster Tools）

- Search Console：ドメインプロパティ `experience.niho.life` を 2026-10-26 に追加した。親の `niho.life` のドメインプロパティを DNS で確認済みのため、所有権は自動で確認された。担当者を足す時は最小権限（閲覧だけなら「制限付き」）。
- Bing Webmaster Tools：Search Console からの取り込みで登録する（オーナーのアカウントで行う）。
- 検索公開（#15）の後に行うこと：両方で sitemap（`/sitemap.xml`）を送信、トップ・一覧・体験詳細 1 件の URL 検査、`node scripts/indexnow-submit.mjs` の実行。予約・`/host/*`・`/admin` が索引に無いことを確認する。
- 月次で見るもの：Search Console の「生成 AI 機能」レポートと、Bing の AI Performance レポート（計測の Issue で扱う）。数値は公開 Issue に貼らない。

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

## 担当3と決めること

- 英語の題名・説明文・検索語（実商品の原稿確定時）
- 写真の掲載許諾と代替文、Open Graph用画像（実写真ができてから。仮素材は出さない）
- NIHO既存の企画ページとの重複時、どちらを正規URLにするか（連携A・#7）
- 公開後のSearch Console確認：手順は上の「登録先」。担当者（データは公開Issueに貼らない）
