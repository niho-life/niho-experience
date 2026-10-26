# ガイド記事の書き方と公開手順

対象：[#145](https://github.com/niho-life/niho-experience/issues/145)。置き場所を決めた理由は [ADR 0002](../adr/0002-guide-content.md)、検索まわり（構造化データ・sitemap・hreflang）は [seo.md](../seo.md) の「ガイド記事」。

## 置き場所

- 公開する記事だけを `apps/web/src/content/guides/{slug}.ts` に置く（1記事1ファイル）。**下書き・未公開の原稿はコミットしない**（公開リポ）。下書きは非公開台帳で書き（[下書きをプレビューで見る](#下書きをプレビューで見る)）、公開の PR で初めて入れる。
- `apps/web/src/content/guides/index.ts` の `PUBLISHED_GUIDES` に足すと、次のデプロイで公開される。
- `samples/` はプレビュー（mock）専用の合成の記事。実 API の配備には出ない。サンプルを本物の記事の雛形として写すときは、`(sample)` の表記と冒頭の注記を必ず消す。

## 項目（`types.ts` の `Guide`）

| 項目 | 内容 | 決まり |
| --- | --- | --- |
| `slug` | URL `/guides/{slug}` | 英小文字・数字・ハイフン。公開後は変えない |
| `title` | h1・`<title>`・`Article.headline` | 110 字まで |
| `description` | meta description と、題名の下のリード | 160 字まで |
| `author` | `{ name, role }` | 実名と役割（例：`Editor, NIHO Experience`） |
| `publishedAt`・`updatedAt` | 公開日・更新日（`YYYY-MM-DD`） | 画面に出す。内容を直したら `updatedAt` を変える（sitemap の `lastModified`） |
| `hero` | `{ src, alt, width, height, licensed }`（任意） | `src` は `public/` 配下のパスか https。`licensed: true` は共有（OG 画像・構造化データ）まで許諾がある写真だけ。仮素材は `false` |
| `video` | `{ youtubeId, caption }`（任意） | 公開済み動画の 11 文字 ID と確認済みの説明。`hero` をポスターに使う。媒体別同意を得てから追加する（[動画の公開手順](videos.md)） |
| `relatedExperienceSlugs` | 記事の最後で予約へ誘う体験 | 2〜3 件。カタログに無い slug は画面で飛ばす |
| `relatedGuideSlugs` | 関連記事 | 0〜3 件。公開済みの記事だけを指す |
| `faq` | `{ question, answer }[]` | 質問は見出し（h3）、答えは短く。20 問まで。FAQ の構造化データは出さない |
| `body` | 本文（下の書き方） | |
| `translations.ja` | 日本語版（題名・説明・本文・FAQ） | 構造だけ。`/ja/guides` ができるまで画面にも hreflang にも出ない（#59） |

## 本文の書き方

使えるのは次だけ。ほかの書き方は CI（`npm test` の `guides.test.ts`）で行番号つきのエラーになる。

```text
## 見出し（h2）
### 小見出し（h3）

段落。改行しても同じ段落としてつながる。空行で段落を分ける。

- 箇条書き（1 行に 1 項目。入れ子にしない）
- **太字** と *斜体*

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
publishedAt: 2026-10-26
updatedAt: 2026-10-26
hero: /sample/photos/zazen-hall.jpg
heroAlt: A quiet temple hall laid out for seated meditation
heroWidth: 1600
heroHeight: 1067
heroLicensed: false
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
| `author`・`authorRole` | `author.name`・`author.role` | |
| `publishedAt`・`updatedAt` | 同じ | `YYYY-MM-DD` |
| `hero`・`heroAlt`・`heroWidth`・`heroHeight`・`heroLicensed` | `hero` の `src`・`alt`・`width`・`height`・`licensed` | 任意。書くなら `heroLicensed` 以外はそろえる。`heroLicensed` の既定は `false` |
| `relatedExperiences`・`relatedGuides` | `relatedExperienceSlugs`・`relatedGuideSlugs` | カンマ区切り。数の決まりは公開記事と同じ |
| `:::faq` 〜 `:::` | `faq` | 1 つだけ。`### 質問` の次の段落が答え |

公開するときは、下書きを `apps/web/src/content/guides/{slug}.ts` のモジュールに写し（項目は上の表のとおり、本文は `body`、`:::faq` は `faq`）、`[CONFIRM]` と `/sample/` の写真を無くしてから次の手順で PR にする。

## 公開の手順

1. 原稿を確定する（事実確認・写真の許諾。[copy-guidelines.md](copy-guidelines.md)、[photo-requirements.md](photo-requirements.md)）。検索語は [seo-content-policy.md](../growth/seo-content-policy.md) に従い、量産・言い換えだけの記事は作らない。
2. `apps/web/src/content/guides/{slug}.ts` を作り、`PUBLISHED_GUIDES` に足す。写真は `apps/web/public/guides/` に置くか https の URL を使う。
3. `npm test`（記事の検査）と `npm run build` を通す。プレビュー（`npm run dev`）で `/guides/{slug}` の見え方を確かめる。
4. PR を出してレビューを受け、マージ後のデプロイで公開される。最初の 1 本を公開すると、`/guides`・sitemap・フッターのリンクも出る。
5. 公開後は Search Console の URL 検査で確かめる（[seo.md](../seo.md)「担当3と決めること」）。

更新は同じ PR の流れで、本文を直して `updatedAt` を変える。記事をやめるときは `PUBLISHED_GUIDES` から外す（URL は 404 になる。別の記事へ移すなら転送を足す）。
