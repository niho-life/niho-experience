# ガイド記事（/guides）の原稿と公開手順

作成日：2026-10-26。対象Issue：[#145 記事基盤](https://github.com/niho-life/niho-experience/issues/145)。記事の柱は [#147](https://github.com/niho-life/niho-experience/issues/147)〜[#151](https://github.com/niho-life/niho-experience/issues/151)。置き場所の判断は [ADR 0002](../adr/0002-guide-content.md)。

## 置き場所

| 状態 | 置き場所 | 表示 |
| --- | --- | --- |
| 下書き（未公開） | 非公開台帳 `NIHO/niho-experience-secret/guides/<slug>.md`（git 管理しない） | プレビュー（`EXPERIENCE_API_MODE=mock`）で `GUIDE_DRAFTS_DIR` にそのフォルダの絶対パスを渡したときだけ。上部に「Draft」の帯、`noindex`、sitemap に出さない |
| 公開 | このリポの `apps/web/content/guides/<slug>.md` | 本番を含むすべての環境。sitemap に更新日つきで出す |

未公開の原稿・ネットの仮写真・聞き取りの回答をこのリポに置かない（[AGENTS.md](../../AGENTS.md)、[copy-guidelines.md](copy-guidelines.md)）。e2e のテスト原稿は `apps/web/e2e/fixtures/guides/` に置き、合成の内容だけにする。

## 公開の手順

1. 下書きを非公開台帳で書く。確かめていない事実は `[CONFIRM: ...]` で残す（画面で黄色く出る）。
2. 提供者・寺などに確認して `[CONFIRM]` をなくす。確認日と相手は非公開台帳に残す。
3. 写真を許諾済みの実写に替え、`apps/web/public/guides/media/` に置く。`/sample/` の仮素材と外部 URL の写真は公開記事で使わない（[release-acceptance.md](../release-acceptance.md)）。
4. オーナーが承認したら、原稿を `apps/web/content/guides/` へ移す PR を作る。PR のレビューが編集の最終確認になる。`[CONFIRM` が残る原稿、`/sample/` や `https://` の写真を使う原稿は単体テストで落ちる。
5. 公開後に事実が変わったら、本文と `updated`（時刻・料金なら `factsChecked` も）を同じ PR で直す。

## 書式

ファイル名が slug になる（小文字の英数字とハイフン。例 `kamakura-after-4-pm.md`）。URL は `/guides/<slug>`。

### 先頭の項目

`---` で囲み、1 行に `key: value` を 1 つ。リストはカンマ区切り。

| 項目 | 必須 | 内容 |
| --- | --- | --- |
| `title` | ○ | 記事の題名（h1・`<title>`）。70 字以内 |
| `description` | ○ | 検索結果の説明と、題名の下の導入文。160 字以内 |
| `pillar` | ○ | 柱：`evening`（夕方〜夜）・`zazen`（座禅）・`crafts`（手仕事）・`planning`（計画）・`hosts`（ホスト） |
| `type` | | `pillar`（柱の記事）か `guide`（既定）。一覧で柱の記事を先に出す |
| `author` | ○ | 著者の実名（本人が選んだ表記） |
| `authorRole` | ○ | 著者の役割（例 `Community manager, NIHO kamakura`） |
| `published` | ○ | 公開日 `YYYY-MM-DD` |
| `updated` | ○ | 更新日 `YYYY-MM-DD`（公開日以降） |
| `factsChecked` | | 時刻・料金・曜日を確かめた日。記事の上に「Times and prices checked on …」と出す |
| `hero` | ○ | ヒーロー写真。`/` で始まるサイト内のパス（公開写真は `apps/web/public/guides/media/` に置き `/guides/media/engakuji-gate.jpg` のように書く）か、下書きに限り `https://` の URL |
| `heroAlt` | ○ | 写真の代替文 |
| `heroCredit` | | 写真の撮影者・出典（写真の下に小さく出す） |
| `experiences` | | 記事で勧める体験の slug（最大 3）。記事の最後に体験カードを出す。カタログに無い slug は出さない |
| `related` | | 関連記事の slug。読み込めた記事だけ出す |

### 本文

Markdown の一部だけを使う。HTML は書けない（`<` はそのまま文字になる）。

- 見出し：`## 見出し`（h2、目次に出る）、`### 小見出し`（h3）。本文に `#`（h1）は書かない。
- 段落：空行で区切る。続く行は 1 段落になる。
- 箇条書き：`- 項目`、番号つき：`1. 項目`。
- 引用（本人の言葉）：`> 文`。最後の行を `> — 名前` にすると話者になる。
- 強調：`**太字**`、`*斜体*`。
- リンク：`[文字](/experiences/kamakura-community-dinner)`、`[文字](#見出しのid)`、`[文字](https://...)`。それ以外の形はリンクにしない。
- 表：`| 見出し | 見出し |` の行、`| --- | --- |` の区切り、本文の行。各行の最初の列が行の見出しになる。狭い画面では表の中だけ横に動く。
- 写真：単独の行に `![代替文](/path.jpg "キャプション")`。キャプションは任意。パスの決まりはヒーロー写真と同じ。
- 体験カード（本文の途中）：単独の行に `:::experience kamakura-community-dinner`。
- 囲み：`:::note` から `:::` まで（確認日・注意書き）。
- よくある質問：`:::faq` から `:::` まで。中は `### 質問` と短い答え。FAQ の構造化データは出さない（Google のリッチリザルト対象外。表示との一致だけ守る）。
- 確認待ち：`[CONFIRM: 確かめること]`。下書きの画面で黄色く出る。公開原稿に残すとテストで落ちる。

### 例

```markdown
---
title: Kamakura After 4 PM: What to Do When the Temples Close
description: Most temples close by 4:30 pm. Here is how to spend a Kamakura evening, from the beach to dinner and the last train.
pillar: evening
type: pillar
author: Takuya
authorRole: Founder, NIHO kamakura
published: 2026-11-10
updated: 2026-11-10
factsChecked: 2026-11-08
hero: /guides/media/yuigahama-dusk.jpg
heroAlt: Yuigahama beach at dusk
experiences: kamakura-community-dinner, kamakura-coffee-roasting
related: zazen-in-kamakura
---

Kamakura empties out after the temples close. ...

## Watch the sun go down at the beach

...

:::faq
### Is Kamakura safe at night?
...
:::
```

## 画面に出るもの

- 記事：パンくず（Home › Guides › 題名）、柱の名前、題名、導入文、著者と役割、公開日・更新日、写真、目次（h2 が 3 つ以上）、本文、体験カード、よくある質問、関連記事。
- `<head>`：title、description、canonical、`Article` と `BreadcrumbList` の JSON-LD（著者・公開日・更新日・写真）。共有画像は承認された写真ができるまで出さない（体験ページと同じ）。
- 一覧 `/guides`：柱ごとに記事のカード。記事が 1 本も無ければ 404（空の一覧を見せない）。
- 体験ページ：`experiences` にその体験を挙げた記事を「Read before you go」として最大 3 本。記事が無い体験では出さない。
- 日本語版：記事の日本語版はまだ無い。hreflang は `en` と `x-default` だけ（[#139](https://github.com/niho-life/niho-experience/issues/139) の方式。日本語版を作るときは [#154](https://github.com/niho-life/niho-experience/issues/154) で `ja` を足す）。

## プレビューで下書きを見る

```bash
EXPERIENCE_API_MODE=mock MOCK_CATALOG=pilot GUIDE_DRAFTS_DIR=/絶対パス/niho-experience-secret/guides npm run dev
```

`/guides` に下書きが「Draft」の印つきで並ぶ。原稿を保存して再読み込みすれば反映される。`GUIDE_DRAFTS_DIR` は `EXPERIENCE_API_MODE=mock` のときだけ読む（本番・stg の http モードでは無視する）。
