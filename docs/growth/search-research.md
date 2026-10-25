# 検索需要・競合の測定設定と観測記録

最終更新：2026-10-26。対象：[#14](https://github.com/niho-life/niho-experience/issues/14)、[#12](https://github.com/niho-life/niho-experience/issues/12)。
検索量を推測で書かない。取得した数値の生データ（Keyword Planner・GSC・OTA管理画面のエクスポート）は非公開台帳に置き、この文書には測定設定・表示上の限界・判断に使った要約だけを書く。

## 検索量の測定設定

| ツール | 前提 | 設定 | 取得する値 |
| --- | --- | --- | --- |
| Google Keyword Planner | Google広告アカウントが必要（オーナー）。出稿しない場合、検索量は幅で表示される | 地域：米国、英国、オーストラリア、カナダ、シンガポール、香港、台湾をそれぞれ単独で、加えて全地域／言語：英語／検索ネットワーク：Google／期間：直近12か月の月別 | 月間平均検索数（幅）、月別の推移、競合性（広告の指標であり検索結果の競合ではない） |
| Google Trends | 不要 | 地域：全世界、および上記の国／期間：過去5年／カテゴリ：旅行 | 相対的な関心度と季節性（絶対数ではない） |
| Google Search Console | 公開ドメインの所有確認（[seo-content-policy.md](seo-content-policy.md)） | 公開後28日単位、国別、ページ別、検索語別 | 表示回数、クリック数、平均掲載順位、検索語 |

### 取得の試行記録

| 日付 | ツール | 方法 | 結果 |
| --- | --- | --- | --- |
| 2026-10-19 | Google Trends | 作業環境から非公式のライブラリ（pytrends）で自動取得 | 失敗（Googleが429を返した）。再試行はしていない。ブラウザで人が開いて取得し、設定と取得日を付けて非公開台帳に記録する |
| 2026-10-19 | Google Keyword Planner | 既存のNIHO広告アカウントで英語表記の10語を入力。日本と米国をそれぞれ単独指定、Google、画面表示「過去12か月」 | 取得済み（数値は非公開台帳）。言語設定はこの画面では「すべての言語」で固定され、英語話者だけの需要ではない。商品固有語の多くは値が表示されず、ゼロと判断できない。アカウントは詳細値の代わりに幅を表示 |
| 2026-10-19 | Google Search Console | 既存Chromeログインで `niho.life` のドメインプロパティを確認 | 体験サイトはまだ本番DNSが引けず、`experience.niho.life` の公開後実績は未取得。既存ドメインの総量を新サイトの検索需要に転用しない |
| 2026-10-26 | Google Keyword Planner | niho広告アカウントで57語（英語49語・日本語8語）を「全地域」と「米国・英国・豪州・カナダ」の2条件で取得。言語は「すべて」固定、期間は画面既定の直近12か月 | 取得済み（幅は [seo-growth-strategy.md](seo-growth-strategy.md) に記載、取得画面の記録は非公開台帳）。kamakura experience は英語圏で月10〜100と小さく、需要は計画段階の語と東京起点の体験語にある |
| 2026-10-26 | Google Search Console | `niho.life` のドメインプロパティで直近3か月のクエリと外部リンクを確認 | 英語の非指名の鎌倉語はほぼ無し。第三者被リンクは実質ひと桁（数値は非公開台帳）。新サイトは親ドメインの評価を当てにしない |

今回のKeyword Plannerでは、広い観光語は商品名に近い語より表示範囲が大きかった。ただし地域は日本・米国だけ、言語フィルタは全言語であり、英語の各商品の優先順位や購入意図は決められない。英国・豪州・カナダ・シンガポール・香港・台湾の国別測定と、英語設定が可能な画面での再確認は残る。GSCは公開後にページ・国・検索語を28日単位で取得する。GSCに言語フィルタはないので、検索語の表記を別に分類する。

### 記録の書式

| 検索語 | ツール | 地域 | 言語 | 期間 | 指標 | 値 | 取得日 | 取得者 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| kamakura cooking class | Keyword Planner | 米国 | 全言語（入力語は英語） | UIの「過去12か月」 | 月間平均検索数 | 取得済み（非公開台帳） | 2026-10-19 | 担当3 |

値の列は非公開台帳にだけ記入し、公開文書では「未取得」「取得済み（非公開台帳）」のどちらかを書く。例外として、Keyword Planner の幅（10〜100 など）は秘密ではないので公開文書に書いてよい（オーナー判断 2026-10-26）。Search Console・OTA 管理画面・提携先の数値と名前は非公開台帳だけに置く。

## 調べる検索語の候補

商品台帳の候補ごとに、旅行者が使いそうな英語の語を並べた。どれも検索量は未取得で、優先順位は測定後に決める。

| 対象 | 検索語の候補 |
| --- | --- |
| 地域全般 | kamakura things to do、kamakura day trip from tokyo、kamakura at night、kamakura local experience、meet locals kamakura |
| P-01 | kamakura cooking class、kamakura dinner with locals、japanese home cooking class near tokyo、community dinner japan |
| P-02 | coffee roasting experience japan、kamakura coffee |
| P-03 | kamakura zen meditation、zazen kamakura、zen temple experience near tokyo |
| P-04 | kintsugi workshop kamakura、kintsugi near tokyo |
| P-05 | kamakura calligraphy、shodo experience kamakura |

## 競合の観測記録

観測日：2026-10-19。観測の方法を列に書く。価格は表示されたとおりに記録し、為替換算や比較の計算はしない。表示通貨はサイトや閲覧地域で変わる。

### 直接表示して確認したもの

| 掲載先 | 体験（表示名） | 所要時間 | 表示価格 | 方法 |
| --- | --- | --- | --- | --- |
| [Wabunka](https://wabunka-lux.jp/) | Private Calligraphy Lesson with a Master Calligrapher at a Kamakura Residence | 90分 | from $173 /person | 商品ページ内の関連商品の欄を表示（ヘッドレスブラウザ、表示通貨USD） |
| Wabunka | Learn Traditional Tableware Lacquering from a Craft Master of Kamakura-bori Lacquerware | 120分 | from $241 /person | 同上 |
| Wabunka | Create a Personal Seal, Hand-finished by an Artisan at a Longstanding Kamakura Shop [Basic Plan] | 30分 | from $239 /person | 同上 |
| Wabunka | Create Vivid Otherworldly Ikebana Beauty with a Flower Artist in Kamakura | 90分 | from $193 /person | 同上 |
| Wabunka | Explore the World of Ikebana and Japanese Literature in an Atelier in Kamakura | 150分 | from $266 /person | 同上 |
| Wabunka | Paint the Spirit of Prayer with Kannon Artist in Kamakura, Kanagawa | 120分 | from $86 /person | 同上 |
| Wabunka | An Exclusive Journey into the Zen Philosophy and World of Shakuhachi Flutes at Kamakura's Houkoku-ji Bamboo Temple | 120分 | from $387 /person | 同上 |
| [byFood](https://www.byfood.com/experiences/rolled-sushi-bento-making-class-at-yokos-kamakura-home-262) | 鎌倉の個人宅での巻き寿司弁当づくり | 2時間 | US$57.28 | 商品ページを表示（ヘッドレスブラウザ、米国から） |
| [Airbnb](https://www.airbnb.com/s/Kamakura--Japan/experiences) | 鎌倉の検索結果に、古民家での書道、巻き寿司弁当づくり、大船の焼酎バーで地元客と飲む体験、街歩き、箸づくり、食品サンプルづくりが表示された。各カードに評価と件数が表示される | — | 記録せず | 検索結果ページを表示（ヘッドレスブラウザ、米国から） |

P-03の提供者が既に出している掲載は、競合ではなく同じ商品の他チャネルとして非公開台帳に記録した。

### Web検索の結果に出てきたもの（未表示・価格は記録しない）

Web検索ツール（米国の検索結果のみ、Googleの検索結果の順位とは一致しない）で次の検索語を調べ、出てきたページを記録した。要約された価格は検証できないため記録しない。

| 検索語 | 出てきた主なページ |
| --- | --- |
| Kamakura cooking class with locals | Expedia系の各サイトに、この商品（P-01）と同名の商品、およびNIHO kamakuraを会場とする類似名の商品。byFoodの巻き寿司弁当づくり |
| Kamakura calligraphy experience English | Expedia系の各サイトの書道体験（少なくとも3商品） |
| Kamakura kintsugi workshop English | 鎌倉の結果はなく、東京などの金継ぎ体験 |
| things to do in Kamakura evening local experience | Expedia系の居酒屋巡り、Airbnbの鎌倉の体験一覧、夜の過ごし方の記事 |

GetYourGuide、Expedia系の商品ページはbot判定により自動取得できなかった。確認する場合はオーナーまたは担当者がブラウザで開き、観測日と表示通貨を記録する。

### 観測から言えること（仮説）

- 鎌倉の書道・工芸の英語体験は、少人数・貸切で1人数十〜数百ドルの価格帯で既に複数売られている。P-04・P-05は、価格より「NIHOの作り手と会える」点で差を出す必要がある。
- 夕食の時間帯に地元の人と過ごす英語の体験は、検索結果で見た範囲では少ない。P-01は夕方以降に鎌倉に残る旅行者（宿泊者）に向くと考えられる。
- 競合のカードは評価と件数を目立つ位置に出している。こちらは実際の参加者のレビューが集まるまで表示しない（[copy-guidelines.md](../content/copy-guidelines.md)）ので、提供者の人柄・写真・条件の分かりやすさで信頼を作る。

いずれも検索量・予約データで検証していない仮説である。
