# SEOの情報設計案（URL・title・canonical・構造化データ）

最終更新：2026-10-19（担当3）。対象：[#12](https://github.com/niho-life/niho-experience/issues/12)の検索・原稿・情報設計の部分。
実装（SSR、sitemap、robots、メタタグ、構造化データ）は担当1。正式ドメインと正規URLの統一はオーナーが決める。ここに書く値はすべて案。

## 現状（2026-10-19に各ページのHTMLで確認）

| ページ | 検索公開 | canonical | 本文の初期HTML | 構造化データ |
| --- | --- | --- | --- | --- |
| [NIHOapp企画ページ](https://niho.life/living/nihokamakura/pages/community-dinner-with-locals) | `noindex, follow` | 自己参照 | あり | Product＋Offer、開催日ごとのEvent |
| [公式サイトのディナーのページ](https://kamakura.niho.life/kamakura-community-dinner) | `robots: all`、sitemapに掲載 | 指定なし | なし（JavaScriptで描画） | なし |
| niho-experience | 未公開 | — | — | — |

同じ体験の英語の紹介が2か所にあり、検索公開されているのは本文が後から描画されるページだけ、という状態。

## 正規URLの方針

**方針案：niho-experienceの体験ページを、体験ごとに唯一の検索公開ページにする。**

| ページ | 扱いの案 |
| --- | --- |
| niho-experienceの体験ページ | index、自己参照canonical、sitemapに掲載 |
| NIHOapp企画ページ | 現状どおりnoindex。もしくはcanonicalをniho-experienceへ向ける。どちらにするかは担当2・オーナーと決める |
| 公式サイトのページ | 原稿の全文を重複して載せず、短い紹介と予約ページへのリンクにする。変更はオーナーの判断 |

本番公開の前に、公開ドメインと既存NIHOの商品ページの正規URLを統一する（[architecture.md](../architecture.md)）。

## URL

| 種類 | URL案 | 検索公開 |
| --- | --- | --- |
| トップ | `/` | する |
| 体験一覧 | `/experiences` | する |
| 体験詳細 | `/experiences/{slug}` 例：`/experiences/kamakura-community-dinner` | する |
| 絞り込み・検索 | `/experiences?theme=...&date=...` | しない（`noindex, follow`、canonicalは `/experiences`、sitemapに載せない） |
| 予約入力・Checkoutからの戻り・予約確認 | 担当1・2が決める | `noindex`をHTMLまたは`X-Robots-Tag`で返し、sitemapやページからリンクしない。noindexを検索エンジンが読めるようrobots.txtでは拒否しない。`no-store`にし、tokenをURLに入れない（[#10](https://github.com/niho-life/niho-experience/issues/10)）。予約情報へのアクセスはNIHO側で認証・認可する。robots.txtやnoindexはアクセス制御の代わりにしない |
| プレビュー | 本番と別のホスト | しない。認証で閉じ、`X-Robots-Tag: noindex` も付ける |
| 提供者 | v1では体験詳細の中に置き、単独ページを作らない | — |

- slugは英小文字とハイフン。地域と体験の名詞を入れ、日付や価格を入れない。一度公開したslugは変えない。変える場合は301で転送する。
- 日付を選ぶカレンダーはボタンで実装し、日付ごとのURLへのリンクを作らない（巡回できる組み合わせを無限に増やさない）。
- 体験が一時的に満席・販売停止のときは200で表示し、「No dates available」と次の行動を示す。販売を終了した体験は、近い内容の体験がある場合だけ301、ない場合は410を返す。

## title・description・OG

| 項目 | 案 |
| --- | --- |
| title | `{体験の表示名} \| {サイト名}`。60字以内。例：Kamakura Community Dinner with Locals \| （サイト名は未定） |
| meta description | 原稿のleadを短くし、所要時間・人数・言語を足す。155字以内。価格はAPIの値と同期できる場合だけ入れる |
| og:image | メイン写真から1200×630で切り抜く。権利の確認済みのもの |
| og:url | canonicalと同じ |
| `html lang` | `en` |

## 構造化データ

表示している内容と一致するデータだけを出す。v1の段階的な案：

1. **最初**：`Organization`（＋`WebSite`、トップのみ。名称とURLだけでロゴは承認済み素材が出てから）、`BreadcrumbList`
2. **API契約と表示の実装後**：体験詳細に `Product` と `Offer` を出すか、開催日ごとの `Event` を出すかを、Googleのガイドラインを確認したうえで担当1と決める。価格・在庫・日時は画面と同じAPIの値を使う。実際に開催が決まっていない日を「毎日開催」として大量に出さない
3. **レビュー（`AggregateRating`・`Review`）**（2026-10-22 更新・[#104](https://github.com/niho-life/niho-experience/issues/104)）：実際のレビューを集める仕組みの方針が決まったので、次の条件がすべて揃うときだけ出す。
   - 対象は、NIHOで予約した人だけが書き、NIHOが確認してから公開したレビュー（owner決定 2026-10-22）。OTAや拠点への評価、提供者が自分で書いたもの、予約を経由しないものは転用しない。
   - 実データ（HTTP API）のときだけ。プレビューの合成のレビューは出さない。
   - **画面に出している内容と一致させる**：平均は3件から画面に出すので、`aggregateRating` と `review` も3件以上のときだけ。1〜2件・0件・読めなかったときは何も出さない。出す `review` は画面の新しい順の件だけ。
   - 提供者の返信・よかった点の集計・予約や利用者の識別子は載せない。表示名は「名＋国・地域」だけ。
   - `TouristTrip` に `aggregateRating` と `review` を足し、同じ値を `Product` にも載せる（[#139](https://github.com/niho-life/niho-experience/issues/139)。`TouristTrip` はGoogleのリッチリザルトの対象外で、星が出るのは `Product`）。星が必ず出るとは限らない。表示と一致する構造化データとして置く。
   - 「0件」の `New` や「読めなかった」状態を、評価としては出さない。

## 言語版とhreflang

英語版は自分自身（`en`）と `x-default` のhreflangを出す。日本語版が公開されたページだけ、各言語版に自己参照canonicalと相互のhreflang（`en`・`ja`・`x-default`）を付ける（[#139](https://github.com/niho-life/niho-experience/issues/139)。日本語版（#59）の準備として先に出す側に寄せた）。実在しない言語版をhreflangに書かない。

### 日本語版の題名と検索語（案・[#154](https://github.com/niho-life/niho-experience/issues/154)）

日本語の「鎌倉 体験」は英語の「kamakura experience」より2桁多く検索され、上位は集約サイトと媒体記事で、運営者本人の詳細ページが無い（[seo-growth-strategy.md](seo-growth-strategy.md)）。日本語版は英語の原稿を人が確認した翻訳が揃ってから公開する（[copy-guidelines.md](../content/copy-guidelines.md)、[#59](https://github.com/niho-life/niho-experience/issues/59)）。日本語の題名・説明文はNIHOの公開文書が正本で、画面側では作らない。次は翻訳と確認をする人が使う目安。

| ページ | 狙う語（Keyword Planner・全地域） | 題名・本文で守ること |
| --- | --- | --- |
| `/ja/experiences` | 鎌倉 体験（1,000〜1万）、鎌倉 ワークショップ（100〜1,000） | 題名に「鎌倉」と「体験」を入れる。提供者本人が書いた詳細と、少人数・英語対応であることを説明文に |
| `/ja/experiences/kamakura-community-dinner` | 鎌倉 夜（100〜1,000）、鎌倉 夜 ごはん | 寺社が閉まる17時以降の過ごし方として書く。少人数・予約制 |
| `/ja/experiences/kamakura-coffee-roasting` | 鎌倉 焙煎 体験（未取得） | 焙煎した豆を持ち帰れること |
| `/ja/experiences/engakuji-zen-meditation` | 鎌倉 座禅（100〜1,000）、座禅 体験 初心者 | 検索は「座禅」、寺は「坐禅」と書くので、本文で両方を自然に使う。円覚寺・建長寺に無料の坐禅会があることを書き、違い（英語の案内・少人数・予約制）を正直に。無料会の現況は寺に確認してから書く |
| `/ja/experiences/kamakura-ceramic-mending` | 鎌倉 金継ぎ（100〜1,000）＋「体験」 | 漆ではなく接着剤で継ぐことを冒頭に書く（[product-ledger.md](../content/product-ledger.md)）。「本漆」「伝統的な金継ぎ」と書かない。英語の kintsugi-inspired に当たる日本語は翻訳の確認で決める |
| `/ja/experiences/kamakura-calligraphy` | 鎌倉 書道（10〜100）＋「体験」 | 選んだ言葉を書いて持ち帰れること |

- 日本語の記事（「鎌倉 座禅 体験 初心者」「鎌倉 夜 ごはん 地元の人と」など）は、記事の基盤（[#145](https://github.com/niho-life/niho-experience/issues/145)）と英語の記事（[#147](https://github.com/niho-life/niho-experience/issues/147)・[#148](https://github.com/niho-life/niho-experience/issues/148)）の後に、同じ論理ページの日本語版として作る。
- 日本語版の順位は日本の検索環境で見る（[funnel-measurement.md](funnel-measurement.md) の「検索・AI 回答の月次観測」）。

## 内部リンク

- トップ→体験一覧→体験詳細の順にたどれる。どの体験詳細もトップから2クリック以内。
- 体験詳細から、実在する他の体験へのリンクを2〜3件置く。架空の関連記事・空のカテゴリへのリンクを置かない。
- NIHOapp・公式サイトから、niho-experienceの体験ページへリンクする（オーナー判断）。

## 担当1からの依頼への回答（2026-10-19）

画面側の実装（[docs/seo.md](../seo.md)）で「担当3と決めること」とされた4点への回答。

### 1. 英語の題名・説明文・検索語

| ページ | title（`%s \| NIHO Experience` の `%s`） | description |
| --- | --- | --- |
| トップ | 現状どおり：Meet the people of Kamakura | 現状どおり |
| 一覧 | Kamakura Experiences with Local Hosts | Small-group experiences in Kamakura hosted by people who live here. Prices in Japanese yen, times in JST, and no account needed to book. |
| 体験詳細 | 体験の題名（契約の `title`） | 契約の `lead`。160字を超える場合は、160字以内の文の区切りで切る（区切りがなければ単語の区切りで切り「…」を付ける）。実装は担当1 |
| 提供者向け | 現状どおり | 現状どおり |

体験ごとに狙う検索語（検索量は未取得。[search-research.md](search-research.md)）：

| slug | 本文・題名に自然に含める語 |
| --- | --- |
| `kamakura-community-dinner` | Kamakura, dinner with locals, Japanese home cooking, cooking class |
| `kamakura-coffee-roasting` | Kamakura, coffee roasting |
| `engakuji-zen-meditation` | Engakuji, Kamakura, zen meditation, zazen |
| `kamakura-ceramic-mending` | Kamakura, kintsugi-inspired, mend pottery。「traditional kintsugi」は使わない |
| `kamakura-calligraphy` | Kamakura, calligraphy, shodo |

検索語は原稿の中で自然に使い、繰り返しや検索語だけの段落を作らない（[copy-guidelines.md](../content/copy-guidelines.md)）。

### 2. 写真の許諾・代替文・Open Graph画像

- 写真の許諾は [photo-requirements.md](../content/photo-requirements.md) のとおり。実写真が届くまで、Open Graph画像は出さない（現状どおり）。
- Open Graph画像は、権利を確認した体験のメイン写真を使う。横1200px以上で、1.91:1に切り抜いても主題が残るものを選ぶ。
- 写真ごとの代替文は、現在の公開API（`PublicImage` は `url` だけ）では渡せない。`alt` の追加を担当2に依頼した（[#7](https://github.com/niho-life/niho-experience/issues/7)）。それまでは現状どおり、メイン写真は体験の題名、2枚目以降は「題名＋別の場面」とする。
- 提供者の紹介文（Host の bio）も現在の契約にないため、あわせて依頼した。

### 3. NIHO既存ページとの正規URL

案は[正規URLの方針](#正規urlの方針)のとおり。niho-experienceの体験ページを正規とし、NIHOappの企画ページはnoindexのままにする。`canonicalUrl` はNIHOが決めるので、連携Aでこの方針に合わせる（#7・担当2）。公式サイト（kamakura.niho.life）のページの扱いはオーナーの判断。

### 4. 公開後のSearch Consoleの確認

下の「公開後の確認手順」のとおり。担当者はオーナー（プロパティ作成と権限付与）、担当1（sitemap送信・URL検査・除外の確認）、担当3（4週間の週次確認と判断の記録）。数値は非公開台帳に置き、Issueには判断だけを書く。

## 公開後の確認手順（ドメイン決定後）

| 手順 | 担当 |
| --- | --- |
| Search Consoleでドメインプロパティを作り、DNSで所有確認する。担当者に必要最小限の権限を付ける | オーナー |
| sitemapの送信、robots.txtの確認、トップ・一覧・体験詳細1件のURL検査 | 担当1 |
| 予約・プレビューのURLがインデックスされていないことの確認 | 担当1 |
| 公開から4週間は毎週、インデックス状況と検索語を確認し、判断だけをIssueに記録する（数値は非公開台帳） | 担当3 |

検索での上位表示やAIの回答への掲載は保証しない。
