# NIHO Experienceを横断チャネルマネージャーへ育てる条件

2026-10-29の追加設計：[PWAの講師別カレンダー・Mac Studio実行部・外部予約サイトとの同期](../../idea/active/2026-10-29-ota-calendar-operations.md)、[アカウント名義・共有メール・講師精算](niho-experience-seller-and-settlement.md)。オーナーの低固定費・NIHO代行運営の方針を具体化した設計案で、下記のAPI審査の調査とは区別する。

調査日：2026-10-28。対象は体験・ツアーの**供給者側**予約システムとOTA接続。公開された各社の一次資料を確認した。契約の非公開部分とNIHOの個別審査結果は未確認である。関連：[鎌倉の市場・販路調査](kamakura-experience-market-and-channels.md)、[体験データの正本](../adr/0002-experience-domain-ownership.md)。

## 結論

1. **技術的には実現可能。接続は各社ごとの契約と審査を通す必要がある。** AirbnbはAPIプログラムの例に「activity and tour booking management software」を明記し、GetYourGuide、Viator、Klookも予約システム・チャネルマネージャー向けの接続仕様を公開している。ただし公開仕様を実装しただけでは利用資格を得られない。[Airbnb API規約 §1.1–1.3](https://www.airbnb.com/help/article/3418)、[GetYourGuide連携条件 §3](https://integrator.getyourguide.com/terms_and_conditions)、[Viator接続の前提条件](https://docs.viator.com/supplier-api/technical/)、[Klook API](https://klook.gitbook.io/openapi)。
2. **NIHO Experienceが自社の体験を直販するだけでAirbnb接続が原理的に禁止される、とまでは言えない。** Airbnb接続を公表する[Bókun](https://www.bokun.io/grow/bokun-and-airbnb-connection)は[自社サイトでの直販機能](https://www.bokun.io/sell/online-booking)も提供する。ただし同社の個別契約は公開されておらず、NIHOのように他者の体験を集めて旅行者向けに販売するマーケットプレイスまで許容される証拠ではない。Airbnb API規約の**競合・類似機能の制限には個別契約の例外**があり、NIHOの利用形態を開示して書面で認めてもらう必要がある。[Airbnb API規約 §2.2(I)](https://www.airbnb.com/help/article/3418)。
3. **「NIHO Manager」という別アプリを作ることは審査の保証にならない。** Airbnb規約はAPIを使う「組織」とそのAPIクライアントを対象にし、求められれば**実際の製品・サービスのデモアカウント**を提示する。画面・名称だけ分けても、同じ組織がAirbnb由来のデータをNIHO Experienceの販売・広告に流すなら規約上の懸念は残る。反対に、独立した供給者向け予約管理機能とデータ用途の分離は、審査で説明可能な構成になる。これは規約からの推論であり、適格性の最終判断はAirbnbが行う。[同規約 §1.1、§1.5、§2.2、§2.3](https://www.airbnb.com/help/article/3418)。
4. **一度通っても恒久利用ではない。** AirbnbはAPI権限を変更・停止でき、更新実装、セキュリティの再評価、利用状況の監視を定める。掲載された**体験自体**も、評価・取消・品質などの継続審査を受ける。GetYourGuideもAPI基準未達なら接続・商品を止められる。顧客との約束を守るには、停止時に販売を切り替える運用が必要。[Airbnb API規約 §1.3、§1.7、§2.3、§4](https://www.airbnb.com/help/article/3418)、[Airbnb体験の継続基準](https://www.airbnb.com/help/article/1451)、[GetYourGuide連携条件 §4](https://integrator.getyourguide.com/terms_and_conditions)。
5. **資本金の公開最低額は確認できない。** 確認した各社の公開API規約・接続手順には「資本金○円以上」の数値基準が見当たらない。これは「資本金を審査しない」ことを意味しない。Airbnbには非公開のプログラム要件・個別契約があり、Viatorには既存供給者と正式な技術承認の前提がある。公開情報で重く見えるのは契約主体・担当者の確認、接続先の実在、データ安全性、機能・性能・運用体制である。会社設立が一律に必須かどうかも、公開規約だけでは断定できない。[Airbnb API規約 §1.2–1.5](https://www.airbnb.com/help/article/3418)、[Viator Reservation System API](https://docs.viator.com/supplier-api/technical/)。

## Airbnbの「競合」をどう読むか

Airbnbの[API利用規約](https://www.airbnb.com/help/article/3418)には次の二面がある。

| 公開条項 | 明文の内容 | NIHOへの読み方 |
| --- | --- | --- |
| §1.1、§1.2 | 体験・ツアー予約管理ソフトがAPIプログラムの対象例。権限範囲は参加プログラムと個別条件による | 「体験管理」は対象。ただし希望する予約・在庫・メッセージ等の権限が自動で付くわけではない |
| §2.2(E)(F)(I) | **個別契約に別段の定めがない限り**、API・コンテンツの第三者提供、API利用による収入、AirbnbのAPIプログラム・ホストサービス・製品と競合または類似する製品でのAPI利用を制限 | 有料SaaSとして売る場合も、NIHO Experienceと一体で運営する場合も、利用・収益化の範囲を個別契約で明示する必要がある。条文だけでNIHOが適格・不適格とは断定できない |
| §2.2(A)(V)(Y)(X) | API由来のコンテンツを蓄積・分析・再包装しない。プラットフォーム全体の比較や広告利用を制限。Airbnbに関する決済処理は個別契約での明示的な許可が必要 | Airbnb予約を管理するために受け取る情報を、NIHO Experienceの集客リスト、リターゲティング、他販路の価格分析へ転用しない。Airbnb予約の決済をNIHOのStripeで取り直す設計にしない |
| §1.3、§1.5、§2.3、§4 | NDA・個別契約・データ安全性審査、求められたデモアカウント、継続監視、停止・終了後30日以内のAPI取得データ削除 | 審査資料と運用証跡を継続して維持する。終了時のデータ消去と未催行予約の引き継ぎ手順を先に設計する |

**体験の掲載審査とAPIパートナー審査は別物。** 体験ホストとして商品が掲載されたことは、NIHOの予約ソフトがAPI接続を認められたことを意味しない。掲載後もホスト・商品には継続基準があり、大きな変更は再審査の対象になる。[Airbnbの開発者ポータル](https://developer.withairbnb.com/)にはActivities API、活動内容管理、リアルタイムの空き確認等が掲載されるが、詳細な権限・参加条件の一部はパートナーポータルや個別のプログラム資料に委ねられる。[API規約 §1.2–1.3](https://www.airbnb.com/help/article/3418)、[体験の継続基準](https://www.airbnb.com/help/article/1451)。

同じ開催回に複数サイトの参加者を入れる設計にも注意が要る。Airbnbの[体験ホスト基準](https://www.airbnb.com/help/article/1451)は、Airbnb客と他プラットフォーム客を**同一回に混ぜないことを推奨**する。禁止と書かれた一律ルールではないが、共通の残席数をそのまま全サイトへ開けば混在が起き得る。NIHOの商品ごとにAirbnb専用回、貸切回、他販路との共催回の可否を確認して設計する。

### NIHO ExperienceとNIHO Managerの3案

| 案 | 競合とデータ用途の論点 | 判断 |
| --- | --- | --- |
| Experience `/host` にOTA管理を直接実装 | 旅行者向け販売サイトとAPIクライアントが一体。審査時に双方の機能とデータの流れを説明する必要がある | 構築は単純だが、Airbnb §2.2(I)の適用について個別承認が先。公開規約だけで可否を決めない |
| **Managerを実際に独立した供給者向け製品として設計** | 提供者ごとの権限・在庫表示・OTA接続を持つ。NIHO商品の在庫正本は当面Experienceの予約エンジンに置き、ExperienceはManagerから見ると一販売チャネルとして扱う。OTAのゲスト・予約データは提供者の履行目的に限定 | 審査上の説明がしやすい構成。別ドメイン・別アプリ・別法人そのものが合格条件という公開根拠はない。**機能、契約主体、データ境界、利用目的**を事実通りに申告する |
| 既存チャネルマネージャーへNIHOの在庫APIを接続 | OTAとの直接契約・継続保守の多くを外部事業者が担う。ただしNIHOと外部事業者の接続審査・費用・データ境界は残る | 複数OTAを早く検証する比較案。[RezdyConnect](https://developers.rezdy.com/rezdyconnect/index.html)と[Bókun Channel Manager](https://www.bokun.io/pricing)の対応販路、価格、正本維持を個別確認 |

新しい**法人**を作る案と、新しい**アプリ**を作る案は別。Airbnbの契約当事者は申請する組織で、関連会社やデータ提供先の扱いも個別条件に従う。新法人化を「競合制限の回避策」として先に決める根拠はない。まずNIHOの実際の製品・資本関係・データ流通を開示して、ManagerとExperienceの共存が許される範囲を確認する。これは規約からの実務的推論。[Airbnb API規約冒頭・§1.5・§2.2](https://www.airbnb.com/help/article/3418)。

## OTA別の公開接続条件

下表は**供給者側API**の話。旅行者に商品を再販するためのアフィリエイト／販売パートナーAPIとは審査も用途も異なる。

| OTA | 公開された入口・審査 | 技術・継続利用の要点 | 資本金の数値基準 |
| --- | --- | --- | --- |
| Airbnb Experiences | 体験・ツアー管理ソフトがAPI対象例。NDA、API規約、必要な個別契約、データ安全性審査。権限はAirbnb裁量。[API規約 §1](https://www.airbnb.com/help/article/3418) | Activities API、在庫確認等。必須API機能をリリース後6か月以内に実装。MFA、最小権限、四半期ごとの脆弱性スキャン、セキュリティ再審査、API更新対応。[開発者ポータル](https://developer.withairbnb.com/)、[API規約 §2.3](https://www.airbnb.com/help/article/3418) | 公開条件に最低額を確認できず。非公開のプログラム要件は別 |
| GetYourGuide | Integrator Portalに登録、連絡担当・技術責任者、結合試験、GYGの本番承認。[連携条件 §1–3](https://integrator.getyourguide.com/terms_and_conditions) | 空き照会、仮押さえ、予約、各取消、空き更新通知が必須。複数供給者向けシステムは個人・団体料金、時点・期間型商品にも対応。月間99.8%稼働、reserveの95パーセンタイル3秒、book同4秒等。基準未達時に無効化可能。供給者間の個人・取引データの混合を禁じ、供給者の指示に沿った処理に限定。[技術文書](https://integrator.getyourguide.com/documentation/overview)、[連携条件 §4・§12](https://integrator.getyourguide.com/terms_and_conditions) | 確認した公開文書に最低額なし |
| Viator | **Viator登録済みの事業者がその予約システムを使っていること**が開発着手の前提。技術評価と正式承認を経る。[Reservation System API](https://docs.viator.com/supplier-api/technical/) | 空き・価格と予約を中心に商品ID対応、契約試験、認証試験、少数商品のパイロット、段階的本番移行。[実装手順](https://docs.viator.com/supplier-api/technical/api-overview/) | 確認した公開文書に最低額なし |
| Klook | Merchant、予約システム、チャネルマネージャー向けAPI。開発後にテスト用認証情報と商品を提示し、Klookの試験、実予約・バウチャー確認を経て本番化。[API概要](https://klook.gitbook.io/openapi)、[接続手順](https://klook.gitbook.io/openapi/getting-started/integration-process) | 商品、価格、在庫、仮押さえ、予約・取消に対応。HTTPSエンドポイントと認証情報の提供が必要。 | 確認した公開文書に最低額なし |

じゃらん、アソビュー！、アクティビティジャパンの**任意の新規チャネルマネージャーが使える公開API・参加基準**は、今回の一次資料では確定できなかった。国内OTAも自動連携できる前提で全販路対応を約束しない。[販路・既存ツールの確認範囲](kamakura-experience-market-and-channels.md)。

## NIHOが実装・運用するなら必要なもの

**現在の体験商品・開催枠・残席・予約・決済状態の正本はNIHO Experience**とする。[ADR 0002](../adr/0002-experience-domain-ownership.md)に従い、旧NIHO APIと同じ回を二重販売しない。Managerを作る場合も、別の販売可能残席の正本を増やさず、Experienceの予約エンジンに供給者別の認可された接続を置く。Managerが将来正本を引き受けるなら、データ移行と切替ゲートを別途設計する。

| 領域 | 最低限の設計・運用 | なぜ要るか |
| --- | --- | --- |
| 商品と開催回 | 提供者・商品・プラン・時刻・タイムゾーン・料金区分・定員・貸切・締切を共通IDに対応付け、OTA別IDを保持 | OTAごとに商品単位・人数・価格・キャンセル条件が異なる。誤マッピングは違う体験や時刻を売る |
| 共通在庫 | 同一回の予約前の残席確認、原子的な仮押さえ、期限切れ解放、確定・取消・人数変更、販売停止 | 複数販路が同時に同じ最後の席を取る。GetYourGuideは仮押さえを必須とする |
| 同期と復旧 | OTA別のイベント受信・更新通知、冪等処理、再送、失敗キュー、定期照合、重複・順序逆転への対応 | 通信失敗や再試行時にも予約・残席を一致させる。Google Calendarの予定表示では代替できない |
| 権限・個人情報 | 提供者ごとの接続同意、最小権限、鍵の保管と更新、予約履行以外へのOTA由来データ転用禁止、監査記録、終了時削除 | 提供者間の漏えいと、OTA予約客のNIHOマーケティング転用を防ぐ |
| 運用と品質 | 監視・アラート、障害時のOTA販売停止、手動復旧、サポート窓口、セキュリティ評価・パッチ、回帰試験 | 99.8%の月間稼働なら許容停止は30日で約86分。担当者と復旧手順なしに接続を維持できない |
| 精算と契約 | OTA決済・払戻しとNIHO直販決済を分け、提供者との分配・手数料、予約データ用途、接続解約時の予約履行を明文化 | API連携はOTA予約の決済権限を自動で与えない。Airbnbは個別契約なしの関連決済処理を制限する |

**「高度なシステム」の意味は派手な画面ではなく、予約が失われず、過剰販売せず、障害を検知・復旧できること。** 特にGetYourGuideの公開仕様は数値基準を示し、Airbnbはセキュリティと必須機能の継続実装を要求する。GetYourGuideの[連携条件 §6](https://integrator.getyourguide.com/terms_and_conditions)では接続開発・試験に関する当事者間の支払いはなく、接続先は供給者への利用料を請求できるが、開発・保守費は自社負担である。APIの利用料がゼロでも、NIHO Managerの運用が無料になるわけではない。全OTAに一度に接続する設計より、1つの実商品・提供者で契約と予約往復を通し、次のOTAへ共通部分を広げる方が検証できる。

## 進める順序と確認すべき質問

1. **販売実績と接続需要を実測。** 水引などの固定枠は当面販路ごとに開催回を分ける。共有在庫が必要な商品数・予約件数・手作業時間・過剰販売リスクを記録する。[初期枠管理案](kamakura-experience-market-and-channels.md#あかねさんの水引講座で始める枠管理案)。
2. **既存ツールとの接続を比較。** NIHO Experienceの在庫・予約を正本にできるか、Airbnb／Klook／国内OTAの接続範囲、月額・予約課金、データの帰属、停止時の引継ぎをBókun、Rezdy等に確認する。売上規模が小さい段階では直接APIの継続運用費と比較する。
3. **NIHO Managerの最小構成を作るなら、契約前にデータ境界を設計。** 提供者向け画面、共通在庫API、OTA別アダプター、障害監視を分ける。NIHO Experienceは一般の販売チャネルとして、提供者がNIHOに許諾した商品・在庫だけを使う。API由来の予約客情報を他チャネルの集客に流さない。
4. **最初のAPI相手に確認。** Airbnbには、(a) NIHO Experienceという旅行者向けマーケットプレイスを同一組織が運営してもActivities APIに参加可能か、(b) Managerを別製品としたときの必要な機能・データ分離、(c) 有料の管理料・OTA接続料を個別契約で許すか、(d) 必要な権限・審査・日本の法人要件・資本金の有無、(e) ゲスト情報の保持と接続終了時の未催行予約対応を**書面で**尋ねる。Viatorには登録済み供給者の前提とパイロット条件、GetYourGuide・Klookには必要商品数、地域、SLA、費用を尋ねる。**回答前にAirbnb接続を既定路線として実装しない。**

現時点で提携やAPI権限を取得したという意味ではない。資料公開後の条件変更、個別契約、審査判断に依存する部分は、申請前に各社の現行条件を確認する。
