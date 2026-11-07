# ガイド記事の書き方と公開手順

2026-11-08: 新規記事はExperienceの`/write`から現行ホストログインで作成し、Experience DBへ公開する。書込みは記事提供者のactive OWNERだけ。非OWNER writerは#481、旧editor経路の撤去は#480で扱う。


対象：[#145](https://github.com/niho-life/niho-experience/issues/145)。置き場所を決めた理由は [ADR 0002](../adr/0002-guide-content.md)、検索まわり（構造化データ・sitemap・hreflang）は [seo.md](../seo.md) の「ガイド記事」。

> 2026-11-07 のオーナー判断どおり正本は Experience DB（[ADR 0002](../adr/0002-guide-content.md)）。リポ内の本物の静的記事は公開経路から外した。`kamakura-after-4-pm.ts` は非公開ops移行の入力としてだけ残し、`PUBLISHED_GUIDES`へ戻さない。

## 置き場所

- 本物の記事・下書き・公開版はExperience DBに置く。公開リポへ未公開原稿、実provider/OWNER ID、DB URL、object keyを置かない。
- `PUBLISHED_GUIDES` は空を維持する。http/staticへ切り戻しても一覧・直URL・トップ・sitemapへ本物または合成sampleを出さない。
- `UNLISTED` はURLを知る人だけが直接読め、常に`noindex, nofollow`。一覧・トップ・フッター・sitemap・関連記事には出さない。トップの静的記事特別扱いはない。
- `samples/` はプレビュー（mock）専用の合成の記事。実 API の配備には出ない。サンプルを本物の記事の雛形として写すときは、`(sample)` の表記と冒頭の注記を必ず消す。

## 項目（`types.ts` の `Guide`）

| 項目 | 内容 | 決まり |
| --- | --- | --- |
| `slug` | URL `/guides/{slug}` | 英小文字・数字・ハイフン。公開後は変えない |
| `title` | h1・`<title>`・`Article.headline` | 110 字まで |
| `description` | meta description と、題名の下のリード | 160 字まで |
| `pillar` | `evenings` / `zazen` / `hands-on` / `planning` / `hosts` | 公開記事は必須。`/guides` はこの順で記事がある柱だけ出す |
| `author` | `{ name, role, bio }` | 実名・役割・短い著者紹介。公開記事は `bio` 必須 |
| `publishedAt`・`updatedAt` | 公開日・更新日（`YYYY-MM-DD`） | 画面に出す。内容を直したら `updatedAt` を変える（sitemap の `lastModified`） |
| `checkedAt` | 事実確認日（`YYYY-MM-DD`、任意） | 一覧カードではあれば `Checked`、なければ `Updated` を表示 |
| `readMinutes` | 読了分数（1〜60、任意） | 省略時は本文等から自動算出 |
| `hero` | `{ src, alt, width, height, licensed, caption? }`（任意） | `src` は `public/` 配下のパスか https。`licensed: true` は共有（OG 画像・構造化データ）まで許諾がある写真だけ。`caption` は写真直下の説明・クレジット |
| `video` | `{ youtubeId, caption }`（任意） | 公開済み動画の 11 文字 ID と確認済みの説明。`hero` をポスターに使う。媒体別同意を得てから追加する（[動画の公開手順](videos.md)） |
| `relatedExperienceSlugs` | 本文途中の主 CTA と、その後の関連体験 | 2〜3 件。カタログに無い slug は画面で飛ばす |
| `relatedGuideSlugs` | 関連記事 | 0〜3 件。公開済みの記事だけを指す |
| `faq` | `{ question, answer }[]` | `details/summary` 内の質問は h3、答えは短く。20 問まで。FAQ の構造化データは出さない |
| `body` | 本文（下の書き方） | |
| `translations.ja` | 日本語版（題名・説明・本文・FAQ） | 構造だけ。`/ja/guides` ができるまで画面にも hreflang にも出ない（#59） |

## 本文の書き方

使えるのは次だけ。ほかの書き方は CI（`npm test` の `guides.test.ts`）で行番号つきのエラーになる。

```text
## 見出し（h2）
### 小見出し（h3）

段落。改行しても同じ段落としてつながる。空行で段落を分ける。

- 箇条書き（1 行に 1 項目。入れ子にしない）
- **太字** と *斜体*（両方なら `***太字かつ斜体***`）

1. 番号つき（1. 2. 3. の順に書く）
2. [サイト内へのリンク](/experiences/kamakura-calligraphy)
3. [外部へのリンク](https://example.com/page)

![写真の代替文](/guides/engakuji-gate.jpg "写真の下に出す説明（任意）")

| 比べること | 公開の座禅会 | 案内つきの朝 |
| --- | --- | --- |
| 言葉 | 主に日本語 | 英語 |

:::note
**囲み**：確認日や注意書き。中には段落と箇条書きを書ける。
:::

まだ確かめていない事実は [CONFIRM: 円覚寺に曜日を確認] のように書く。
```

- 題名が唯一の h1 なので、本文に `#` は使わない。
- リンクはサイト内のパス（`/` で始める）か `https://` だけ。`http:`・`mailto:`・相対パスは使えない。
- 写真：単独の行に書く。パスはリンクと同じ決まり（`public/` 配下のパスか `https://`）。代替文は必須。
- 表：見出しの行、`| --- |` の区切りの行、本文の行。各行の最初の列が行の見出しになる。左上の角だけは空にしてよい（比べる表のとき）。狭い画面では表の中だけ横に動く。
- 囲み：`:::note` の行から `:::` の行まで。中に見出し・写真・表・囲みは入れない。
- `[CONFIRM: …]`：下書きの画面で「To confirm」の黄色い印になる。**公開記事に残すと CI で落ちる。**
- FAQ の答えにも、太字・斜体・リンク・`[CONFIRM: …]` を書ける。
- 使えないもの：生の HTML、引用、コード、横線、`_斜体_`、`&amp;` のような文字参照、参照形式のリンク。記号そのものを書きたいときは `\*`・`\[`・`\_` のように前に `\` を置く。
- 公開記事では `/sample/` の仮写真（本文・`hero` とも）を使えない（CI で落ちる）。

## 下書きをプレビューで見る

下書きはこのリポに入れず、非公開台帳（`NIHO/niho-experience-secret/guides/`、git 管理しない）に `{slug}.md` で置く。mock のプレビューで `GUIDE_DRAFTS_DIR` にそのフォルダの絶対パスを渡すと、`/guides` に「Draft」の印つきで並ぶ。

```bash
EXPERIENCE_API_MODE=mock MOCK_CATALOG=pilot GUIDE_DRAFTS_DIR=/絶対パス/niho-experience-secret/guides npm run dev
```

- `GUIDE_DRAFTS_DIR` は `EXPERIENCE_API_MODE=mock` のときだけ読む（本番・stg の http モードでは無視する）。下書きは毎回読み直すので、保存して再読み込みすれば反映される。
- 下書きの記事には「Draft」の帯が出て、`noindex`、sitemap に出ない。同じ slug の公開記事があれば下書きが代わりに出る（公開記事の直しを確かめるため）。
- 項目が足りないなど読めない下書きは、`/guides` の上に理由が出る（プレビューだけ）。

下書きのファイルは、先頭の `---` の間に 1 行 1 項目で `Guide` の項目を書き、その後に本文を書く。

```markdown
---
title: Zazen in Kamakura: Public Sessions vs a Guided Morning at Engaku-ji
description: 160 字までの説明
author: Takuya
authorRole: NIHO kamakura
authorBio: Kamakura host and local guide.
pillar: zazen
publishedAt: 2026-10-26
updatedAt: 2026-10-26
checkedAt: 2026-10-26
readMinutes: 7
hero: /sample/photos/zazen-hall.jpg
heroAlt: A quiet temple hall laid out for seated meditation
heroWidth: 1600
heroHeight: 1067
heroLicensed: false
heroCaption: Preview photo only; replace it before publishing.
relatedExperiences: engakuji-zen-meditation, kamakura-calligraphy
relatedGuides: kamakura-day-trip-from-tokyo, hands-on-kamakura
---

本文（上の書き方）

:::faq
### 質問（FAQ の question）
答え（FAQ の answer。1 段落）
:::
```

| 下書きの項目 | `Guide` の項目 | 決まり |
| --- | --- | --- |
| ファイル名 | `slug` | `{slug}.md` |
| `title`・`description` | 同じ | 公開記事と同じ字数 |
| `pillar` | `pillar` | 5種類のいずれか。既存下書きでは省略可で、その場合は誤分類せず preview-only の「Drafts awaiting a pillar」に出す。公開前に必ず加える |
| `author`・`authorRole`・`authorBio` | `author.name`・`author.role`・`author.bio` | `authorBio` は既存下書きでは省略可、公開時は必須 |
| `publishedAt`・`updatedAt` | 同じ | `YYYY-MM-DD` |
| `checkedAt`・`readMinutes` | 同じ | 任意。日付と1〜60の整数 |
| `hero`・`heroAlt`・`heroWidth`・`heroHeight`・`heroLicensed`・`heroCaption` | `hero` の `src`・`alt`・`width`・`height`・`licensed`・`caption` | 任意。書くなら `heroLicensed`・`heroCaption` 以外はそろえる。`heroLicensed` の既定は `false` |
| `relatedExperiences`・`relatedGuides` | `relatedExperienceSlugs`・`relatedGuideSlugs` | カンマ区切り。数の決まりは公開記事と同じ |
| `:::faq` 〜 `:::` | `faq` | 1 つだけ。`### 質問` の次の段落が答え |

このファイル形式はmockで原稿構造を試す用途だけで、本物の記事を静的モジュールへ写して公開しない。本番原稿は`/write`で保存し、カテゴリ、author、本文の`##`、`[CONFIRM]`除去、非公開写真の権利を公開前検査で確定する。

## 画面での使われ方

- `/guides` はDBカテゴリ順に`PUBLIC`カードを並べ、0本のカテゴリは出さない。mockだけは合成sampleの柱順を使う。カードの日付は`checkedOn`または公開版日時を使う。
- 記事の目次と番号は本文の `##` から作る。同じ見出しが複数あってもリンク先IDは重複させない。本文は構文木からReact要素へ描画し、HTML文字列を注入しない。
- 本文途中の体験案内は `relatedExperienceSlugs` の先頭から、公開カタログに現在ある最初の1件を選ぶ。価格・所要時間・日程は公開API由来のカード表示値を使い、記事へ固定値を写さない。カタログ取得失敗・未掲載では出さない。
- トップのKamakura JournalはDBの`PUBLIC` catalog順で最大10本。`UNLISTED`は特別掲載しない。体験一覧末尾の`Plan your day`は掲載済みガイドが1本以上で最大3枚を出す。DB障害時はどちらの記事枠も隠し、体験・予約入口は維持する。

## 公開の手順

1. active OWNERとして現行ホストログインから`/write`を開き、原稿、カテゴリ、事実確認日、写真の現在のWeb掲載権利を確認する。
2. 下書きを保存して再訪し、非公開画像がprivate/no-storeで見えることを確認する。公開時にcurrent OWNER、英語本文、カテゴリ、写真権利が再検査される。
3. `UNLISTED`なら直URLの200/noindexと一覧・トップ・sitemap除外、`PUBLIC`なら一覧・トップ・sitemapを次requestで確認する。関連体験は実際に公開中のものだけ表示される。
4. 更新は新しいimmutable publicationを作る。停止・membership失効・写真取消が次requestに反映されることを確認する。写真取消後の旧snapshotは監査用に残すが画像は404。
5. DB/画像障害とCloudflare bypassの受入、rollbackは[Guide CMS](../guide-cms.md#database-flagを開く前のゲート)に従う。書込み開始後はstaticへ戻さず、DB互換の既知revisionへ戻す。
