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

## OWNERの画面で確認した範囲

- オーナーが実行時に承認したNIHOアカウントをstagingへ接続し、ホストホームへ復帰した。
- 同じ本人・同じ既存提供者・同じConnect受取先の完全一致を確認し、公式provision CLIでseller profileを明示登録した。既存手数料はサポートOFF／10%のまま、新規口座や別の提供者を作っていない。
- `staging-community-dinner-2026-11-05` を合成原稿として作成。英語・日本語・取消条件・人数条件を保存し、英語原稿を確認した。実在の参加募集ではないことを両言語で明記した。
- 掲載許可のある料理写真1枚を、オーナーのupload承認後に登録。写真の保存と同一originからの読み込みを確認した。本番の人物肖像許可や素材全体の確認を代替しない。
- 11月12日18:00–20:00 JST、定員8名の合成枠を保存し、週カレンダーの日時と受付中表示を照合した。
- 合成の集合案内（実在しない住所・道順・持ち物）を保存した。写真未選択はAPIが拒否するため、権利確認済みテスト写真を選んで保存した。確定予約へのsnapshot・mail配信は未検証。
- 下書き保存後もキー順の差だけで未保存表示が残る不具合を発見した。修正は #417 / PR #418、実環境の再確認は配備後に行う。

## 続けて確認する事項

1. #418の固定SHA配備後に、下書き保存・再読込・本当の編集時の未保存判定を確認する。
2. NIHOの受取口座再利用同意、Experienceの現行手数料／サポート条件と掲載同意を本人の明示操作で満たす。DBへ同意を直接作らない。
3. 合成商品で公開→通常編集で掲載維持→本人停止→再開、SSR・metadata・catalog・写真・availabilityの一致を確認する。
4. Stripe testのゲスト入力→Checkout→webhook確定→予約照会→取消／返金、満席・停止・失敗時の復帰を確認する。
5. 実メール配信、非公開集合案内の確定予約者限定表示、通知／job、運営停止と再公開、失効／権限不足を受け入れる。
6. 本番は別途、NIHO共通契約の配備、販売条件・素材・seller/Connect/readinessと本番運用の確認を行う。

本記録の時点でguest bookingはOFF、検索indexingはblock。本番の販売・検索公開は開けていない。#92・#285・#369・#15の完了条件全体は未達のためopenを維持する。
