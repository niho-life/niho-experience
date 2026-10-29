# 外部予約の定期照合（#237）

2026-10-30の設計。予約台帳と受入APIは[外部予約台帳](ota-external-reservations.md)、実行機の排他・停止は[worker](ota-worker.md)を再利用する。**以下のreaderと定期照合は未実装である。** 予約が読めない状態を予約ゼロや同期完了へ置き換えない。

## V1対象と実行単位

GetYourGuide、Airbnb、Viator、じゃらんがV1対象。サイト別の予約readerは、現在状態・明示取消・日時変更・人数を正しく読めることをそれぞれ受け入れる。AirbnbのGoogle busy区間だけでは予約ID、人数、取消の正本を作れない。メールは再照会の合図に限定する。

15分照合を一回ずつ全実施回の画面を開く構造にはしない。8週間×4販路の空実施回を逐次巡回すると、1時間の許容遅延を超えやすい。既存accountの排他lease内で、同一listingの期間全体を有界に走査する。最初は1商品・1組予約、8週間、既知account/listingだけを対象にする。

## server発行の読取scope

#236の現行APIは単一canonical occurrenceを対象にする。そのまま別の回の予約を投入してはならない。期間走査を有効にする前に、次を明示的に拡張する。

- serverがaccount/listing/mapping version、期間、既存canonical occurrenceとUTC時刻の対応表を固定する。worker入力から商品・回・別提供者を新設しない。
- serverが外部アクセス前に一つの単調generationを発行する。既存のbrowser leaseを再利用し、別のTTL排他を重ねない。
- 最大32件のpageごとにimmutable receipt IDとfingerprintを保持し、page ACK喪失を同じpayloadで再送する。別page、別cursor、旧mappingを混ぜない。
- pagination完走、全状態filter、対象account/product、coverage、読取開始・終了を確認した場合だけCOMPLETEにする。完走不明・件数上限・途中認証切れはPARTIAL/FAILED。
- snapshot tokenやsource revisionが無いpaginationでは、並行更新によりpage間で予約が移動する可能性を扱う。欠落を取消と推測しない。以前のactive予約が見つからなければ、既知IDの正規詳細を再照会するか要確認として占有を保持する。

## 台帳とfreshness

個々の確認済み事実はpartial batchでも台帳に保存できる。新規OPENを許可する読取healthは、個々の保存結果と分離する。現行mapping/coverageの完全な照合だけがfreshnessを更新し、空配列という理由だけでfreshにしない。

通常は15分以内に再照合し、再試行・外部伝播を含め60分を同期目標とする。これは達成済みの実測値ではない。初回未確認・失効・古いcoverageでは、新規OPENを保留する。既に外部で開いている枠を閉じたことにはせず、未閉鎖と遅延をスタッフへ示す。

確定・受付中の予約は空き枠を消費し、取消は正規な明示CANCELLEDだけで解放する。日時移動は旧占有解除と新占有作成を一つのtransactionにする。対象不明・矛盾・競合は自動取消や人の選別をせず、台帳と占有を残して確認へ回す。

## 実証・稼働判定

各readerで次を合成試験と許可済み実サイトの読取りで確認する。

1. 正しいaccount、listing、期間、全状態、全pageを読んだこと。
2. 新規予約、人数変更、取消先着、取消後の古い版、別日への移動、既知予約の欠落。
3. 途中の認証切れ、challenge、DOM/API形の変化、重複page、ACK喪失、古いmapping、並行HOLD。
4. 顧客名・メール・cookie・料金・raw responseがDTO、journal、ログ、公開fixtureへ入らないこと。
5. 予約検知から他販路の読戻しまでの時間と、1時間超過・人手介入を実測すること。

Claude Maxの上限、有効な掲載先session、reader未対応は異なる状態として記録する。従量APIへのfallback、challengeの自動突破、本人同意を飛ばす再ログインは行わない。本番flagは対象readerとStudio運用の受入前に開かない。
