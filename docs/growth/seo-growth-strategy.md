# 検索と AI 検索で鎌倉の体験予約を伸ばす（SEO・AIO 育成戦略）

調査日：2026-10-26。対象：[#156](https://github.com/niho-life/niho-experience/issues/156)（Epic。子 Issue は #139、#141〜#155）、[#12](https://github.com/niho-life/niho-experience/issues/12)、[#14](https://github.com/niho-life/niho-experience/issues/14)。

根拠：Google Ads Keyword Planner（niho 広告アカウント、幅表示）、Search Console（niho.life）、Web 調査 4 本（検索結果の地形図／流通・被リンク・AI 引用／旅行者行動と市場／コンテンツ戦略）。Web 調査は米国向け検索の返却順で、Google の実順位ではない。Search Console・OTA・提携先の数値は非公開台帳に置き、ここには判断だけを書く。Keyword Planner の幅（10〜100 など）は秘密ではないので書く（オーナー判断 2026-10-26）。「推測」と書いた箇所は推論。

既存の方針（[事業方針](community-led-strategy.md)、[30 日検証計画](pilot-30day-plan.md)、[ローンチキット](launch-kit.md)、[SEO 情報設計](seo-content-policy.md)、[検索調査](search-research.md)、[原稿ガイドライン](../content/copy-guidelines.md)）を前提にし、矛盾する提案はしない。特に金継ぎ（P-04）は接着剤で継ぐので「traditional kintsugi」「kintsugi workshop」とは書かない。

## 結論

1. **「kamakura experience(s)」は英語圏でほぼ検索されていない**（米英豪加で月 10〜100、複数形はデータ無し）。狙う「広い語」はこれではなく、**計画段階の語**（things to do in kamakura／kamakura day trip (from tokyo)／kamakura itinerary）と、**東京起点の体験語**（workshops in tokyo／cultural experiences japan／zen meditation tokyo）。
2. **鎌倉×体験の固有語は需要が小さいが競合がほぼ空。** kamakura at night／kamakura zazen／kamakura calligraphy は月 10〜100 だが、検索結果に鎌倉の事業者ページがほとんど無い。金継ぎと焙煎は英語・日本語とも鎌倉の提供者ページが見つからなかった。体験ページ 5 枚と記事数本で取れる（推測）。
3. **親ドメインの評価は当てにできない。** niho.life の第三者被リンクは実質ひと桁で、英語の非指名流入はほぼ無い。`experience.niho.life` はゼロから被リンクを作る前提。
4. **指名検索は既にある。** 「niho kamakura」の指名検索が継続して入っている。AI 検索ではブランド言及と露出の相関が強い（Ahrefs、r=0.66）ので、「NIHO Experience, Kamakura」の表記を全媒体でそろえて増やす。
5. **AI 検索の引用元は自社サイトの外が主。** 旅行の AI Mode 引用は独立系ブログ 56.8%、ツアー質問では Tripadvisor が 62.5% の回答に登場、YouTube は 100 回答中 76、Reddit は 70（いずれも二次調査）。構造化データは必須でも十分でもない。ブロガー招待・レビュー・YouTube が AIO の本線。
6. **2026 年 3 月のコアアップデートで集約サイトが落ち、提供者自身のサイトが上がった**（Tripadvisor −44.8%、Lonely Planet −23.8%。Amsive）。小さな一次情報サイトに追い風。
7. **予約は直前、発見は動画と地図。** 米の旅行者の 70% は体験の 7 日未満前に予約し、日本滞在中の体験予約は 38.5% が旅ナカ（Arival 2025、デロイト 2026）。旅マエの情報源は米英豪で動画が 1 位、旅ナカは Google マップが 99%（観光庁 2024、Payke 2025）。「直近の空きが見える」「スマホで 2 分で予約できる」「Google ビジネスプロフィールが整っている」「YouTube に動画がある」が順位と同じくらい効く。
8. **鎌倉は宿泊 3%・滞在 4.2 時間の日帰りの町**（神奈川県推計・鎌倉市 2024〜25）。寺社は 17 時に閉まる。夕食体験はこの構造的な穴に直接はまり、「泊まる理由」になる。夜・前泊の角度は検索でも空いている。

## 需要の実測（Keyword Planner、2025-10〜2026-09、月間平均・幅）

地域は米国・英国・豪州・カナダの合算、言語は「すべて」（この画面では固定）。全地域の値は日本国内の検索を含むので英語話者の需要として読まない（例：engakuji は全地域 1 万〜10 万、英語圏 100〜1,000）。close variants を含む。

| 幅 | 検索語 | 読み |
| --- | --- | --- |
| 1 万〜10 万 | kamakura, kamakura japan | 地名そのもの。Wikipedia・Japan Guide の領域。狙わない |
| 1,000〜1 万 | things to do in kamakura, kamakura day trip, kamakura from tokyo, tokyo day trips, kita kamakura, tea ceremony tokyo, kintsugi workshop, kintsugi class | 計画段階の語。kintsugi workshop／class は「自国の教室」を含むので割り引く |
| 100〜1,000 | kamakura day trip from tokyo, kamakura tour, kamakura itinerary（直近 3 か月で急増）, kintsugi workshop tokyo, engakuji, kamakura temples, kamakura hydrangea, cultural experiences japan, workshops in tokyo, kamakura what to do | 東京起点の体験語と、鎌倉の計画語 |
| 10〜100 | kamakura experience（急増中）, kamakura at night, kamakura zazen, zazen experience, zen meditation tokyo, kamakura calligraphy, calligraphy class tokyo, japanese calligraphy experience, shodo experience, coffee roasting experience, kamakura coffee, kamakura tea ceremony, kamakura one day itinerary, kamakura guide, kamakura hidden gems, kintsugi experience japan, cultural experiences tokyo, japanese craft workshop | 小さいが購入意図が高く、競合が薄い |
| データ無し | kamakura experiences, kamakura local experience, kamakura cooking class, kamakura food tour, dinner with locals japan, kamakura kintsugi, zen meditation kamakura, engakuji meditation, meet locals japan, japan local experiences | 「ゼロ」とは言えないが、検索から取る語ではない。記事と OTA で需要を作る側 |

日本語（全地域）：鎌倉 観光 1 万〜10 万、鎌倉 体験 1,000〜1 万、鎌倉 金継ぎ／鎌倉 座禅／鎌倉 ワークショップ／鎌倉 夜 各 100〜1,000、鎌倉 書道 10〜100。日本語の「鎌倉 体験」は英語の「kamakura experience」より 2 桁大きい。

## 検索結果の地形図（誰が上位にいるか）

| 語の群 | 上位の種類 | 鎌倉の小規模事業者 | 判断 |
| --- | --- | --- | --- |
| things to do / day trip / itinerary | 個人ブログ（travel2next, wapititravel, saltinourhair, jw-webmagazine）、Headout・Expedia・Trip.com、Lonely Planet、visitkanagawa | 無し | 正面から 90 日で勝つのは難しい。「best things to do」記事 4 本のうち体験・ワークショップに触れた記事は 0。「hands-on」「evening」の角度が空いている |
| tours / walking tour | Headout, Magpie, Jasumo, JTB, ToursByLocals, Tokyo Localized | 無し | OTA の領域。自社は狙わない |
| dinner with locals / cooking class | NIHO の夕食が Expedia 系の複数サイトに既に出ている。byFood、Airbnb | 自社ドメインは出ない | サイト間で価格・開始時刻が食い違う。自社ページを「事実の正本」にして統一する |
| kintsugi (kamakura / near tokyo) | 東京の Airbnb・Headout・Veltra | 鎌倉の提供者ページ無し（日本語も同様） | 空き。「漆と接着剤の違い」を正直に書く記事で受ける |
| zazen / engakuji | Wikipedia、japan-experience、個人ガイドの 300 語ページ、DMO の PDF | 数件 | 円覚寺の座禅会の曜日が資料ごとに違う。日付・服装・所要時間を正確に書いた初心者向けページで越えられる |
| calligraphy / shodo | Expedia 系 5 ドメイン、Lokalee、Airbnb、Tripadvisor | OTA 除外時に数件 | OTA が強い。「何を書くか」「持ち帰るもの」で差をつける |
| at night / evening | 提携型コンテンツ、Expedia の居酒屋巡り | 1 件 | 薄い。夕食体験と「鎌倉の夜の過ごし方」記事で取れる |
| coffee roasting | カフェの店舗情報ばかり | 予約ページ無し | 空き。需要は小さい |

注意：`kamakura-info.jp` は 2026-10-26 時点でオンラインカジノの情報サイト。鎌倉市観光協会と無関係なので、リンク・引用の対象にしない。

## 勝ち筋：3 本の車線

### 車線 C：空いている固有語を体験ページで独占する（公開〜3 か月）

対象：kamakura at night／kamakura zazen／engakuji zazen／kamakura calligraphy／kamakura coffee roasting／kamakura experience。

- 体験ページの題名・h1 に [seo-content-policy](seo-content-policy.md) の検索語を入れる（例：Zazen at Engakuji: Zen Meditation and a Temple Walk in Kamakura）。本文には既に shodo・zazen が出ているのに題名に無いのが現状。
- 各ページに流れ・料金・集合場所・所要時間・言語・持ち物・FAQ 10 問以上・ホスト紹介を揃える（東京の料理教室の自社サイトは FAQ 21 問で予約前の不安を消している）。
- 金継ぎは例外。「kintsugi-inspired」「mend」まで。検索需要は記事で受ける。
- 期待：月 10〜100 の語を 5 本取っても流入は月数十。ただし購入意図が高く、AI の「Kamakura で金継ぎはできる？」への回答元になる。

### 車線 A：東京起点の体験語を「鎌倉は東京から 1 時間」で取る（3〜6 か月）

対象：kintsugi workshop tokyo／workshops in tokyo／cultural experiences japan・tokyo／zen meditation tokyo／calligraphy class tokyo／japanese craft workshop。

- 東京の OTA が強いので体験ページ単体では勝てない。比較記事で入る（「Kintsugi, Explained Honestly: Urushi, Glue, and What You Can Do in Two Hours」「Hands-On Japan Near Tokyo」）。
- 一覧ページの title は決定済みの「Kamakura Experiences with Local Hosts」を反映したうえで、「1 hour from Tokyo」を description に入れるかを担当3 と決める。
- 期待：語の規模が 10 倍。被リンクが 10〜30 本ついてから効き始める（推測）。

### 車線 B：計画段階の大きな語に、角度をつけた柱記事で入る（6〜12 か月）

対象：kamakura day trip from tokyo／kamakura itinerary／things to do in kamakura／kamakura at night。

- 汎用の「15 things to do」は飽和。空いている角度は「4 PM 以降の鎌倉」「人混みを避ける時間割」「手を動かす 1 日」。AI Mode の旅行回答では itinerary 型が 1 回答あたり最多の引用（29.4 件）。
- 柱記事は検索順位よりも、AI の引用元と内部リンクの中継として価値がある。1 年の目標。

### 共通：指名（ブランド）を育てる

「NIHO Experience」「NIHO Experience, Kamakura」の表記を Google ビジネスプロフィール、Tripadvisor、OTA、Instagram、YouTube、記事の署名で統一する。体験後のメール・QR で「NIHO Experience で検索」「Google でレビュー」を促す。

## 被リンクと掲載：現実的な積み上げ方

量より「旅行者が実際に読むサイト」からのリンクと言及を優先する。

| 優先 | 施策 | 期待 | 費用 | 条件・備考 |
| --- | --- | --- | --- | --- |
| 1 | Google ビジネスプロフィールに「チケット／アクティビティ」の予約リンク（Things to do の無料枠への直接の入口） | 高（推測） | 0 | クラス型が対象かは申請して分かる。NIHO の実拠点で登録 |
| 2 | 神奈川県観光協会（visitkanagawa.jp）の Travel Trade・会員制度、鎌倉市の英語観光ページ | 中 | 会費未確認 | DMO の資料に「体験」として載ると、英語ガイド・OTA・ブロガーの引用元になる |
| 3 | Tripadvisor に登録しレビューを集める | 高（AI 引用元として最上位） | 0 | 最初の予約から。レビュー依頼の導線を体験後メールに |
| 4 | Viator（初回 $29＋手数料 20〜35%・二次）または Klook に 1〜2 体験 | 中 | 手数料 | 売上目的ではなく「レビュー・言及・指名検索」目的。OTA 契約の送客条項を確認してから自社の価格方針を決める |
| 5 | Airbnb Experiences（20%・二次） | 中 | 手数料 | レビューが集まってから |
| 6 | ブロガー・YouTuber 招待（プレス体験） | 高 | 体験費・謝礼 | AI Mode の旅行引用は独立ブログ 56.8%。開示つき |
| 7 | Tokyo Cheapo（月 ¥11,000〜・二次）／Japan Guide（Sponsored Story、問い合わせ制） | 中 | 有料 | nofollow でも「言及」として効く。レビューか実績写真が揃ってから |
| 8 | 鎌倉・東京の宿の「周辺のおすすめ」ページ、コンシェルジュ | 中 | 0 | フロントカード（launch-kit B1）と同時に依頼 |
| 9 | 提供者自身のサイト・Instagram・所属団体からのリンク | 中 | 0 | |
| 10 | kamakura.niho.life／kamakura-hitohako.com からの本文リンク | 低〜中 | 0 | 評価は小さいが、インデックスを早める |
| 11 | YouTube（体験 1 本 2〜3 分、英語字幕、ホストが話す） | 中〜高 | 制作費 | AI Mode の 76/100 回答に YouTube |
| 12 | Reddit r/JapanTravel | 中（長期） | 0 | 事業者名義の宣伝はしない。参加者の自然な言及と開示つきの回答のみ |
| 13 | Bing Webmaster Tools 登録・IndexNow | 低（前提） | 0 | ChatGPT 検索は Bing の索引を使う（二次） |
| 14 | robots.txt で OAI-SearchBot／PerplexityBot／Claude-SearchBot を許可、学習用は別途判断 | 中（前提） | 0 | OAI-SearchBot 拒否 = ChatGPT 検索に出ない |
| 15 | llms.txt | 低 | 0 | Google は「不要」と明記。97% のファイルは AI から 0 リクエスト。やらない |

## コンテンツ地図（柱 5 本）

方針：総合ガイドを作らない。5 体験に根ざした「夜・座禅・手仕事」で、一次情報（ホストの言葉、実写、実際の時刻・料金）だけを書く。Google の AI 最適化ガイド（2026-05）は一次体験に基づく内容を最重要とし、クエリ網羅の量産をスパム扱いしている。

| 柱 | 仮題／狙う語 | ぶら下げる記事 | つなぐ体験 |
| --- | --- | --- | --- |
| P1 夕方〜夜 | Kamakura After 4 PM: What to Do When the Temples Close／kamakura at night | Dinner with Locals in Kamakura: Hour by Hour／Last Train from Kamakura to Tokyo／Where to Eat in Kamakura Beyond Shirasu／Vegetarian & Shojin Ryori in Kamakura | 夕食、焙煎 |
| P2 座禅 | Zazen in Kamakura: Public Sessions vs a Guided Morning at Engaku-ji／kamakura zazen | Zazen for Beginners／Kita-Kamakura Temples Walk, Timed Around the Crowds／Zazen, Shakyo or Shodo? | 座禅、書道 |
| P3 手仕事 | Hands-On Japan Near Tokyo: Mending, Calligraphy and Coffee in Kamakura／workshops in tokyo | Kintsugi, Explained Honestly: Urushi, Glue, and What You Can Do in Two Hours／Japanese Calligraphy for Beginners／Roast Your Own Coffee in Kamakura | 金継ぎ（kintsugi-inspired）、書道、焙煎 |
| P4 計画の拠点 | Kamakura Day Trip from Tokyo (Without the Crowds)／kamakura itinerary | How to Get to Kamakura from Tokyo／Kamakura vs Nikko vs Hakone／Kamakura in June: Hydrangeas Without the Queue／A Hands-On Day in Kamakura | 全体 |
| P5 人 | Meet the Hosts | 体験ごとにホスト 1 人を主語にした記事 5 本 | 全体 |

最初の 90 日：月 4〜6 本（根拠は弱い。小規模運営の月 2.5 本と大手の月 20 本の中間）。本数より一次情報・著者・更新日。日本語版は「鎌倉 体験」「鎌倉 金継ぎ 体験」「鎌倉 座禅 体験 初心者」「鎌倉 夜」を先に。

## 旅行者の行動に合わせた打ち手

| 段階 | 時期 | 媒体・検索語（例） | 打ち手 |
| --- | --- | --- | --- |
| 憧れ | 数か月〜1 年前（推測） | YouTube・Instagram・TikTok | ホストと場所が分かる短尺素材 |
| 日本旅行の計画 | 数か月前。欧豪は 10 泊以上 | Google、YouTube、Reddit、ChatGPT。"Japan itinerary 2 weeks" | 東京拠点の旅程に「鎌倉＋体験」が載る説明ページ（P4） |
| 鎌倉を行き先に加える | 旅程の細部決定時 | "Kamakura day trip from Tokyo" | 日帰りに夕方〜夜を足す提案（P1） |
| 鎌倉での過ごし方 | 数週間前〜直前 | "Kamakura avoid crowds", "things to do in Kamakura evening", "stay in Kamakura" | 閉門後・早朝・前泊の時間帯別ガイド。宿との連携 |
| 体験を選び予約 | 7 日前〜当日 | Google、Klook、ChatGPT。"zen meditation Kamakura", "dinner with locals Kamakura" | 事実を一画面に。直近の空きと締切。ゲスト予約のモバイル完結 |
| 現地（前泊・当日） | 48 時間前〜当日 | Google マップ 99%、スマホ 89.5% | GBP・地図。集合地点の写真と経路。遅刻時の連絡手段 |
| 体験後の共有 | 当日〜帰国後 | Instagram、Google マップの口コミ、Tripadvisor | 共有しやすい写真と、Google／Tripadvisor のレビュー導線 |

市場の事実：鎌倉市の延入込観光客は 2025 年約 1,606 万（2013 年ピークの約 70%）。宿泊客の消費単価は日帰りの約 4 倍。混雑は総数ではなくスポットと時間帯に集中（八幡宮 −11%、ハイキングコース +38%、2025 年）。欧米豪の Instagram 上位投稿に鎌倉の食の投稿は 0 件（日本人は 49%）。生成 AI の利用率は調査により 6%〜94% とばらつくが、「旅行中に AI に聞く」層が厚い。AI は価格・時刻・場所の事実を複数媒体から照合するので、自社・OTA・GBP・Tripadvisor で一致させる。

## 計測と見直し

- Search Console（experience.niho.life）：非指名クエリの表示回数、国別、「生成 AI 機能」レポート。Bing Webmaster Tools の AI Performance レポート。
- 指名検索：「niho experience」「niho kamakura」の表示回数の推移（AIO の代理指標）。
- 手動：狙う語 30 本の順位を月 1 回。ChatGPT／Perplexity／AI Mode に 10 問を月 1 回聞き、引用元を記録。
- 判断の節目：3 か月で車線 C の語が 1 ページ目に入らなければ題名・内部リンク・被リンクを見直す。6 か月で車線 A に動きがなければ比較記事と被リンクを増やす。1 年で車線 B。
- 数値は非公開台帳、判断だけを Issue に。

## 確認できなかったこと

- Google の「Things to do」枠・AI Overview が鎌倉の英語検索で出ているか（ツールから SERP 機能は見えない）。ブラウザで実検索して確認する。
- Google ビジネスプロフィールの予約リンクでクラス型（料理・座禅・書道）が通るか。
- OTA の規約で自社サイトへのリンクが許されるか。
- Keyword Planner は幅表示で、英語限定の値は取れていない。

## Issue との対応

| 区分 | Issue |
| --- | --- |
| 技術・設定 | [#139](https://github.com/niho-life/niho-experience/issues/139) 技術面の穴（実装済み）、[#141](https://github.com/niho-life/niho-experience/issues/141) 検索・AI 検索への登録と robots、[#142](https://github.com/niho-life/niho-experience/issues/142) GBP・Tripadvisor、[#145](https://github.com/niho-life/niho-experience/issues/145) 記事基盤、[#146](https://github.com/niho-life/niho-experience/issues/146) 体験ページの題名・FAQ |
| 販路・被リンク | [#143](https://github.com/niho-life/niho-experience/issues/143) OTA の統一と追加掲載、[#144](https://github.com/niho-life/niho-experience/issues/144) DMO・メディア・宿からの掲載、[#153](https://github.com/niho-life/niho-experience/issues/153) ブロガー招待 |
| 記事 | [#147](https://github.com/niho-life/niho-experience/issues/147) P1 夕方〜夜、[#148](https://github.com/niho-life/niho-experience/issues/148) P2 座禅、[#149](https://github.com/niho-life/niho-experience/issues/149) P3 手仕事、[#150](https://github.com/niho-life/niho-experience/issues/150) P4 計画の拠点、[#151](https://github.com/niho-life/niho-experience/issues/151) P5 Meet the Hosts |
| 動画・日本語・計測 | [#152](https://github.com/niho-life/niho-experience/issues/152) YouTube・ブランド表記、[#154](https://github.com/niho-life/niho-experience/issues/154) 日本語版、[#155](https://github.com/niho-life/niho-experience/issues/155) 月次観測 |

## 主な出典

- Google：[AI 機能と検索](https://developers.google.com/search/docs/appearance/ai-features)、[AI 最適化ガイド](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)、[Things to do](https://developers.google.com/actions-center/verticals/things-to-do/overview)、[GBP のチケット／アクティビティ](https://support.google.com/business/answer/12944910)
- OpenAI [クローラー](https://developers.openai.com/api/docs/bots)、Perplexity [クローラー](https://docs.perplexity.ai/guides/bots)
- Amsive：[2026 年 3 月コアアップデート](https://www.amsive.com/insights/seo/google-march-2026-core-update-winners-losers-analysis/)
- search.agency：[AI Mode の旅行クエリ引用分析](https://search.agency/blog/ai-mode-travel-guides-still-perform)、Qvery：[Tripadvisor の AI 引用](https://qvery.ai/blog/tripadvisor-ai-citations-statistics/)、Ahrefs：[ブランド言及と AI Overviews](https://ahrefs.com/blog/ai-overview-brand-correlation/)、ppc.land：[llms.txt の採用](https://ppc.land/llms-txt-adoption-rises-8-8x-but-97-of-files-get-zero-ai-requests/)
- Arival：[2026 年の体験市場](https://arival.travel/article/4-findings-for-experiences-market-2026/)、[Tour Taker](https://arival.travel/article/the-modern-day-tour-taker/)、トラベルボイス：[関空出口調査](https://www.travelvoice.jp/english/45-of-international-travelers-arriving-in-kansai-airport-book-local-experiences-in-japan-before-their-departures)、[デロイト 2026](https://www.travelvoice.jp/20260807-160311)、[博報堂 2026](https://www.hakuhodo.co.jp/news/newsrelease/267410)、[Payke 2025](https://honichi.com/news/2025/07/25/payke_traffic/)、[Amex 2026](https://www.americanexpress.com/en-gb/travel/discover/get-inspired/global-travel-trends-en-gb)
- 鎌倉市：[観光の概要](https://www.city.kamakura.kanagawa.jp/kankou/documents/gaiyou7p7p31.pdf)、[2025 年入込観光客数](https://www.city.kamakura.kanagawa.jp/kisya/data/2026/20260528.html)、神奈川県：[推計表](https://www.pref.kanagawa.jp/documents/138016/r72hyou.pdf)、[visitkanagawa Travel Trade](https://visitkanagawa.jp/travel-trade)
- 掲載・料金：[Viator](https://operatorresources.viator.com/about-us/)、[Japan Guide 広告](https://www.japan-guide.com/e/e460.html)、[Tokyo Cheapo 広告](https://tokyocheapo.com/advertise/)
