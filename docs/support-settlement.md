# Experience予約の支援・実費精算

対象: Experience #117・#121・#128・#380。Experience予約の支援設定、Adminの支援業務、実取引費用の照合を扱う。販売条件やOTAの操作は対象外。

## 設定と受付時snapshot

- `/host/support?hostKind=EXPERIENCE_PROVIDER&hostId=…` で現在のNIHO OWNERが支援ON/OFFとExperienceサポート規約版へ同意する。10%（OFF）/15%（ON）は決済費用込みの利用料。
- 設定の同意版・改訂・actor・時刻を保存し、設定revisionを使って同時更新を拒否する。接続失敗時は入力を保持し、再読込した現在値で結果を照合する。
- 同意がない提供者は新しい販売予約を受け付けない。新しい予約のpricing snapshotへON/OFF、料率、同意版、改訂を固定する。過去予約やlegacy NULLを現在設定で補わない。既存の旧版同意snapshotはその予約時点の同意として扱い、現行版へ置換しない。
- Admin支援操作は予約時snapshotが支援ONで、予約者データ保持期間内の場合だけ開く。内部Adminメモは専用case tableに保存し、ホストと予約者へ共有される相談スレッドから分離する。

## Admin支援業務

- `/admin/site-bookings` のAdmin予約詳細から、現在のAdmin候補への担当割当、内部メモ、操作履歴、予約者への支援連絡を行う。
- ホストのExperience予約詳細には、支援操作の種別・結果・時刻と、予約者へのNIHOサポート連絡時刻だけを共有する。Admin ID、command ID、内部メモ、予約者の連絡内容はこの履歴DTOへ含めない。連絡本文は既存の予約メッセージスレッドだけに表示する。
- 承認・辞退・取消／返金は既存の予約・返金repositoryへ接続する。支援専用の予約状態や返金状態は追加しない。操作履歴は既存の永続操作commandと状態変更から記録し、本文・予約者PIIをイベントへ複製しない。
- 新規予約、決済要確認、取消依頼、取消、返金更新、支援ON予約への予約者からの新着連絡をAdmin通知一覧へ登録する。既読はAdmin actorごとに保存する。予約イベント更新と通知登録は同一DB transactionで行い、重複イベントはdedupe keyで排除する。NIHO自身が送った連絡を新着ゲスト連絡として通知しない。
- case更新はUUID command ID、request fingerprint、revision CASで冪等化する。候補から外れた担当者やrevision競合では入力を保持して現在値を読み直す。401/403ではAdmin予約画面と関連private dataを消去する。

## 実費照合

- 受付時の見込料率・見込NIHO利用料は不変snapshotから示し、売上総額や今の設定から再計算して上書きしない。
- settlement workerはStripeのCharge、Balance Transaction、Application Fee、返金一覧を読み、ローカル返金commandと照合する。処理費用はBalance Transactionの`fee_details`から`application_fee`を除き、`stripe_fee`と`payment_method_passthrough_fee`を合算する。未知の費用区分や内訳不一致は要確認にし、合計`fee`を処理費用として補填しない。返金履歴が不完全、費用負担者不明、金額不一致、結果不明なら最終金額を確定しない。
- Stripe上の処理費用負担者が接続口座ならNIHOが同額をホストへ補填する。APPLICATION負担なら追加補填しない。返金で戻らない処理費用はNIHOの負担に含める。
- 最終ホスト額は「総額 − 成功返金 − 返還されていないNIHO利用料 − 口座負担の処理費用 + NIHO補填」。NIHO差引額は「NIHO利用料 − 利用料返還 − 実処理費用」。どちらもStripe証跡と補填Transferが揃うまではnull。
- 返金行の追加・金額・状態・終了更新は同じDB transactionから照合を再予約する。settlement完了後にStripe上で直接作られた返金も拾うため、`SETTLED`行は30日おきに再照合する。
- 補填Transfer commandをStripe呼出し前に永続化する。Transfer groupとcommand metadataで未知結果を再照合し、成功済みなら同じTransferを再利用する。Stripe idempotency保持期間を越え、Stripe側にTransferが見つからない未知結果は自動再送せず要確認へ送る。確定的な残高不足だけを別commandのbounded retry対象とする。
- ホスト売上画面とAdmin予約画面で「見込」「実費確定」「処理中」「結果確認中」「要対応」を分け、支払済みやホスト入金済みとは表示しない。

## 検証・受入

通常売上、部分返金、全額返金、pending返金、失敗返金と再試行、返金履歴の欠落、処理費用負担者、補填Transferの再照合をunit testで確認する。PostgreSQL統合テストは同意snapshot・legacy NULL拒否、内部メモ分離、actorごとの既読、通常/部分/全額返金の最終負担を確認する。

CIのPostgreSQL統合testとStripe test modeでの受入が必要。Stripe test modeではConnected Account設定別の実取引、返金後も戻らないBalance Transaction費用、Transfer検索によるunknown-result回復、残高不足後の再試行上限を確認する。これらの外部Stripe受入はこの変更では実施していない。
