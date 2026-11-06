# Experience正本のstaging受入（2026-11-05）

対象: #92 / #285 / #369。旧NIHO商品・予約の移行ではなく、Experience正本の新規商品・公開・予約導線を確認する。実装済みと実環境での受入済みを分ける。個人情報・内部の本人／販売者／口座ID・接続情報・予約tokenは記録しない。

## 配備・接続の確認済み事項

| 対象 | 確認結果 |
| --- | --- |
| NIHO Host v1.0.0 | NIHOapp source `8b1df940eb71c9722fbd5a4b8441bf0ba60f99f2`、[staging公式配備](https://github.com/niho-coliving/niho-app/actions/runs/41956319240)のattempt 2成功。revision `nihoapp-backend-stg-00942-rsd` |
| 契約 | 同sourceのexport SHA-256 `924ce2062be2c431ee6a4dd3a8322c48558e6d76f0a097bae75ae6222610023e` がExperience固定値と一致。現在のidentity/Connect限定契約を使い、旧商品・予約APIへfallbackしない |
| NIHO実配備 | common contract flag ON、audience／caller／Experience exact originの一致をruntimeで確認。匿名identity要求は401。本人の接続・Experience OWNER判定・Connect readinessの読取が成功 |
| Experience | source `ea9891afc676daee45b77db37addb586790545ba`、[candidate](https://github.com/niho-life/niho-experience/actions/runs/41960693885)→[promote](https://github.com/niho-life/niho-experience/actions/runs/41961178904)成功。revision `niho-experience-host-stg-00025-jiy` がstableの100% |
| DB | 公式migration runnerで0060まで適用済み。124テーブルの宣言済みruntime grants照合が成功。停止中だった共用staging SQLを起動して実行し、他用途のScheduler等は再開していない |
| 商品編集 | native publication APIと公開read flagをstagingだけON。合成の同意版 `synthetic-stg-2026-11-05` を使用。本番同意の承認・本番販売許可を意味しない |
| 写真 | private bucketをUBLA／public access prevention付きで作成。runtimeにbucket限定object権限を付与。OWNER画面で許可済みテスト写真1枚のupload・1200×800画像のreadを確認 |
| Stripe | 現在のstaging secretがtest keyであることを値を出さず確認。対応するenabled webhookの7イベントと署名secret参照を照合。実決済／webhook処理／返金の受入は未完了 |

初回DB起動時にmaintenanceが継続していたため、最初のmigration preflightとNIHO配備は失敗した。SQL受付後、公式runner／失敗jobの再実行で成功を確認した。最初の失敗を成功扱いにしていない。

## 保存判定修正の再配備

PR #418の固定SHA `0f98043cf9ff568dfe84d59ce26c4a2a916c7acc` を[公式candidate workflow](https://github.com/niho-life/niho-experience/actions/runs/41965787002)で配備し、revision `niho-experience-host-stg-00028-gug` のReady、source SHA、publications／host API ON、guest booking OFF、indexing block、同じテスト同意版とprivate bucketを照合した。[promote](https://github.com/niho-life/niho-experience/actions/runs/41966220094)も成功し、同じrevisionがstableの100%であることを確認した。

## OWNERの画面で確認した範囲

- オーナーが実行時に承認したNIHOアカウントをstagingへ接続し、ホストホームへ復帰した。
- 同じ本人・同じ既存提供者・同じConnect受取先の完全一致を確認し、公式provision CLIでseller profileを明示登録した。既存手数料はサポートOFF／10%のまま、新規口座や別の提供者を作っていない。
- `staging-community-dinner-2026-11-05` を合成原稿として作成。英語・日本語・取消条件・人数条件を保存し、英語原稿を確認した。実在の参加募集ではないことを両言語で明記した。
- 掲載許可のある料理写真1枚を、オーナーのupload承認後に登録。写真の保存と同一originからの読み込みを確認した。本番の人物肖像許可や素材全体の確認を代替しない。
- 11月12日18:00–20:00 JST、定員8名の合成枠を保存し、週カレンダーの日時と受付中表示を照合した。
- 合成の集合案内（実在しない住所・道順・持ち物）を保存した。写真未選択はAPIが拒否するため、権利確認済みテスト写真を選んで保存した。確定予約へのsnapshot・mail配信は未検証。
- OWNERの実行時承認後、サポートOFF／合計10%（決済費用込み）と現行規約への同意をホスト画面で保存し、同意改訂1のreadbackを確認した。新規staging予約だけに適用する。
- 未公開slugのSSR・公開detail・availabilityは404、公開APIはno-store。匿名host productsと写真readは401、集合案内の編集画面はログインへ戻る。未公開写真の公開routeは404／no-store、一覧・sitemapにも下書きは出ない。robotsは全pathを検索除外にしている。
- 下書き保存後もキー順の差だけで未保存表示が残る不具合を発見した。修正は #417 / PR #418（merge `0f98043cf9ff568dfe84d59ce26c4a2a916c7acc`）。CIのWeb 2,254件とE2E 846件が成功し、型・lint・ビルド・premerge-gateも成功。E2Eの既定条件による87件skipは変更せず、修正版stagingでも、同じ下書きの復元で未保存表示が出ず、実際の英文変更では未保存になり、英語確認→保存後に未保存表示が消えて保存ボタンが無効になることを確認した。

## 続けて確認する事項

1. 保存判定修正のstaging確認は完了。公開前blockerはNIHOの口座再利用同意だけになった。
2. NIHOの受取口座再利用同意とExperience掲載同意を本人の明示操作で満たす。現在NIHO Host v1は同意projectionのreadだけで、旧NIHO画面はExperienceへredirectされるため、本人が同意を登録する現行導線が無い。共通基盤の限定Connect契約として[NIHO #19121へ記録](https://github.com/niho-coliving/niho-app/issues/19121#issuecomment-6649117694)した。旧payments/reuseの復活、DBへの同意の直接作成、公開gateの緩和はしない。
3. 合成商品で公開→通常編集で掲載維持→本人停止→再開、SSR・metadata・catalog・写真・availabilityの一致を確認する。
4. Stripe testのゲスト入力→Checkout→webhook確定→予約照会→取消／返金、満席・停止・失敗時の復帰を確認する。
5. 現在PAUSEDのstaging jobs drainとメール実行設定を確認したうえで、実メール配信、非公開集合案内の確定予約者限定表示、通知／job、運営停止と再公開、失効／権限不足を受け入れる。
6. 本番は別途、NIHO共通契約の配備、販売条件・素材・seller/Connect/readinessと本番運用の確認を行う。

本記録の時点でguest bookingはOFF、検索indexingはblock。本番の販売・検索公開は開けていない。#92・#285・#369・#15の完了条件全体は未達のためopenを維持する。
