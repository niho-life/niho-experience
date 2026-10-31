# ADR 0002：ガイド記事の原稿の置き場所

- 状態：superseded（2026-10-30 のオーナー判断で記事の正本は editor.niho.life。experience は発信先。下の「2026-10-30」を正とし、移行が終わるまで静的経路を既定値・mock preview 用に、database 経路を受入済みの切戻し先として残す）
- 日付：2026-10-26
- 関連：[#145 ガイド記事の仕組み](https://github.com/niho-life/niho-experience/issues/145)、[#59 日本語版](https://github.com/niho-life/niho-experience/issues/59)、[#139 index 化前の技術面](https://github.com/niho-life/niho-experience/issues/139)、[#251 記事の正本を editor.niho.life へ](https://github.com/niho-life/niho-experience/issues/251)

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
- 下書きは git 管理しない非公開台帳に Markdown（先頭に項目）で置き、mock のプレビューで `GUIDE_DRAFTS_DIR` を渡したときだけ同じ `Guide` 型に読み替えて表示する（2026-10-26 追記。本番・stg の http モードでは読まない。[guides.md](../content/guides.md)「下書きをプレビューで見る」）。
- mock のプレビューだけ、合成のサンプル記事（`samples/`）を登録する。実 API の配備で公開記事が 0 本の間は、`/guides` と `/guides/{slug}` は 404、sitemap・フッターに記事は出ない。

## 結果

- 公開の手順は「原稿をモジュールにする → PR（CI で検査）→ レビュー → マージ → デプロイ」。更新も同じで、`updatedAt` を変える（[docs/content/guides.md](../content/guides.md)）。
- 記事の公開・更新に NIHO 側の作業は要らない。体験の正本・予約・価格には触れない（体験は slug で参照し、カタログに無いものは表示しない）。
- 書き手が増える・更新が頻繁になる・非エンジニアが直接公開したくなった時点で、NIHO 側の CMS（選別された公開 API）へ移す案を再検討する。そのときも型（`Guide`）と描画（パーサー・ページ）は再利用できる。

## 2026-10-29：Guide CMS への移行

[#189](https://github.com/niho-life/niho-experience/issues/189) で、上記の再検討条件を満たしたため公開正本を experience DB の sealed guide publication へ移せるようにした。切替は server-only の `EXPERIENCE_GUIDE_PUBLIC_SOURCE=database`（http mode限定）で行い、既定値は引き続き `static` とする。コードを配備しただけでは公開表示を変えない。

- database mode は `GuideRepository.listPublicArticles` / `getPublicArticleBySlug` だけを読み、静的記事やmock sampleをunionしない。DB障害を静的記事へfallbackさせない。`PUBLIC` だけを一覧・home・体験導線・footer・sitemapへ出し、`UNLISTED` は直URLだけを `noindex` で出す。
- Admin管理のcategory slug・英語label・表示順をpublication snapshotから表示し、既存の5 pillarへ変換しない。静的経路は従来どおり5 pillarを使う。
- `publishedAtUtc` は現在publicationの作成時刻、最古のsealed publication時刻を初回公開日とする。ページとArticle JSON-LDは初回公開日と現在版の更新日を分ける。
- 既存の安全なMarkdown→React描画を共用する。coverと本文figureはpublication snapshotに含まれ、assetが現在も`READY`のときだけ同一originのJPEG routeから配信する。Web掲載確認はOG/SNS利用許諾ではないため、DB写真をOG imageや`Article.image`へ出さない。
- 静的なunlisted editorial preview（#147/#184）とmock draft previewはstatic modeに残す。database modeの公開集合には混ぜない。

database modeの有効化条件・staging受入・切戻しは [Guide CMS](../guide-cms.md)、[実行環境](../experience-runtime.md)、[本番配備](../production-deploy.md) を正とする。

## 2026-10-30：正本を editor.niho.life へ、experience は発信先（#251）

オーナー判断（2026-10-30）。方針と設計の正本は niho-editor の `docs/architecture/editor-niho-life.md` と `docs/architecture/editor-niho-life-design.md`。上の「2026-10-29」で experience DB に置いた記事の正本と、experience の `/editor` は、この判断で役目を終える。

### 決定

- **記事の正本は editor.niho.life**：下書き・版・本文・写真と掲載許諾・公開前の検査・公開と公開停止の操作は editor が持つ。発信先は記事ごとに書き手が選び、experience に載るのは experience を発信先に選んだ英語の記事だけ。
- **experience は発信先**：公開版を editor の公開 API から読み、`/guides`・`/guides/{slug}`・トップの Kamakura Journal・体験詳細の関連記事・sitemap・Article JSON-LD・canonical・hreflang を自分のドメインで SSR する。検索エンジンが評価するのは公開 URL なので、SEO の狙いは変えない。
- **受け取るときに再確認する**：英語であること、Markdown の部分集合、https の許可 origin の写真、関連体験が今も掲載中で記事連携が有効であること。editor の表示や API の `related` を認可の根拠にしない。編集上の条件（リード・カバー・カテゴリなど）は experience が宣言し（`/api/public/guides/publication-requirements`）、editor の公開前の検査が使う。
- **プレビューの見え方の正本は experience**：editor が発行する短命のトークンで下書きを読み、`/guides/preview` で通常の記事と同じ部品で `noindex`・`no-store` に描画する。
- **編集画面は experience に置かない**：`/editor/*`（画面・API・下書き・写真の保管・公開前の検査）は #254 で撤去する。書き手の入口は公開サイトのフッター「For writers」と、ホストの画面の「記事を書く」で、どちらも editor.niho.life へのリンクだけを置く（`GUIDE_EDITOR_SITE_ORIGIN` を設定した環境だけ表示）。
- **記事連携の正本は NIHO の役割の層**：招待・承諾・取消は NIHO 側へ移す（#255）。experience は公開版の関連体験を、現在の権限と掲載状態で表示のたびに再判定する。
- **公開元は常に一つ**：`EXPERIENCE_GUIDE_PUBLIC_SOURCE` の `static`／`database`／`editor` から一つだけを選び、union しない。同じ slug の二重表示と二重の正本を作らない。

### 切り替えの条件

- editor の公開（設計 §14 の段階 3）が本番で使えること。公開 API の契約は niho-editor の v1（`docs/security/editor-publish-api-v1.md`）で確定し、experience の読み取りはこれに合わせた（[Guide CMS](../guide-cms.md#editorniholife-の公開-api-を読む252-253editor-v1-契約)）。残る差（カテゴリの扱いなど）のオーナー判断も切替の前に済ませる。それまでは `static` を既定値のままにし、`editor` は合成 fixture でだけ動かす（`npm -w @niho-experience/web run test:e2e:guide-editor`）。
- 切替は専用の配備変更で行い、切戻しは `database`（受入済みの場合）か `static` の新しい revision。手順は [Guide CMS](../guide-cms.md#切替切戻し) を正とする。

### 結果

- 記事の公開・更新・停止は editor で完結し、experience の再ビルドも PR も要らない（公開版は次の読み取りで反映）。
- 移行が終わると、「原稿をモジュールにする → PR」の手順（上の「決定」）と experience DB の Guide CMS の編集・公開の経路は使わなくなる。それまでに静的経路・database 経路で出した記事は editor へ移してから公開元を切り替え、同じ slug を二重に出さない。静的経路は mock preview の合成サンプルのために残る。database 経路と `/editor` を消す時期は #254 で決める。
- experience 側の記事の型（`Guide`）、安全な Markdown→React の描画、SEO の部品はそのまま使う。

### 未決

- `/editor` を撤去するまでの間、experience の `/editor` を公開に使うか（`EDITOR_CONSOLE_ENABLED` は OFF のまま）。
- 日本語の記事を experience の `/ja/guides` に出すか（#59）。
