# 外部予約の定期照合（#237）

2026-10-30の設計と、#237の保存API・#262の配送基盤の実装。予約台帳と受入APIは[外部予約台帳](ota-external-reservations.md)、実行機の排他・停止は[worker](ota-worker.md)を再利用する。**期間readの保存API・page receipt・health、15分scheduler、固定reader executorへの配送と、GetYourGuideのreader（既定OFF、実サイト未受入）までを実装した。Airbnb・Viator・じゃらんのreaderと実サイト受入は未実装である。** 予約が読めない状態を予約ゼロや同期完了へ置き換えない。この段階だけで#237全体を完了または本番対応済みとは扱わない。

## 今回実装した境界

- migration `0016_external_reservation_window_reads.sql` は既存の単一回 `OCCURRENCE` readを残したまま、`WINDOW` scope、JST当日-3日の00:00から当日+59日の00:00未満までの62日coverage、最大512回のimmutable canonical manifest、server発行page receipt、跨page fact fingerprint、listing別healthを追加する。旅行者へ表示する8週間（当日から55日後まで）の前後へ、最大24時間の実施時間・準備・片付けを安全に判定する余白を持たせる。
- `POST /internal/ota/v1/jobs/{id}/reservation-window-read` は既存の認証済みworkerとOBSERVE lease内で、server clockからJST日境界を決めた62日manifestと最初のreceipt IDを発行する。商品・回・期間をworker入力から受け取らない。
- `POST /internal/ota/v1/jobs/{id}/reservation-window-pages` は最大32facts・16 KiB、連続page番号、expected previous receipt、`sourceCursor` / `nextSourceCursor` chain、任意のsnapshot token、terminal evidenceを検証する。cursor原文は保存せずdigestだけを永続化する。1page目は開始cursorなし、次pageは直前の`nextSourceCursor`と一致し、terminalは`nextSourceCursor`なしに限定する。同一receiptの同一payloadはACK replayし、改変、順序抜け、cursor/token混在、同じ予約IDの異なるfactを409で拒否する。
- 個々のfactは既存単一回APIと同じ台帳適用moduleを使い、明示取消、source版、日時移動、resource buffer、要確認fence、transactional outboxの規則を共有する。manifestに一意に対応しない時刻は推測しない。
- 32件と16 KiBの両方を満たすようにreader側で分割する。外部サイトの1ページを複数の保存pageへ分ける場合は、外部cursorと分割位置を区別したopaque cursorを使う。以前のcursorへ戻る循環も拒否する。ACK再送は同じreceipt・payloadのまま行う。
- `COMPLETE` healthは、現在のaccount/mapping/canonical manifest、page完走、全状態・coverage evidence、既知active予約の欠落なし、当該readの`NEEDS_REVIEW` / `STALE`なしを同一transactionで満たしたときだけgeneration順に更新する。15分後のnext due、45分後のfreshness expiryと即時・expiry calendar outboxを保存する。`PARTIAL` / `FAILED` / 欠落active / stale fact / 空配列だけではfreshにしない。初回の空COMPLETEは完全性証跡があり既知activeがない場合だけ許す。
- availability gateは、listingがactiveかつ`canReadReservations=true`になった時点から有効になる。初回未確認、期限切れ、coverage外、account/mapping変更、account inactive/revoked/delegation切れ、`canObserve=false`では対象商品と共有resource商品だけ新規OPENを`EXTERNAL_RESERVATION_READ_UNAVAILABLE`（Host表示「確認待ち」）で保留する。listing自体をinactiveまたは`canReadReservations=false`にした場合だけ読取要件を外す。既存の`canReadReservations=false` pilotは変えない。
- `channel_jobs.purpose=RESERVATION_WINDOW` とlisting別のdurable巡回stateを追加した。既存claim routeが通常outbox処理後に最大1件をenqueueし、初回は即時、成功はhealthの15分後、失敗は1/5/15/30/60分の有界backoffにする。mapping/account/assignment等が変わったQUEUED jobは`SUPERSEDED`にするが、LEASED jobと既存browser排他はschedulerから解除しない。canonical desired rowが無いlistingは予約ゼロを捏造せず、有界延期する。
- 配備されていないreaderは候補件数の制限前に除外する。停止した巡回は通常pollで自動解除せず、既存のスタッフによる停止確認・復旧OBSERVEが成功した場合だけ再開する。復旧操作だけでは予約healthをfreshにせず、次の完全な予約readを待つ。
- claim DTOは予約jobだけ`purpose: RESERVATION_WINDOW`を持つ。通常OBSERVEは従来shapeのままで、予約jobはavailability driverやClaudeへ渡さず固定reader executorへ分岐する。`RESERVATION_VERIFIED`は最終COMPLETE page receiptと同じreadのcurrent health、lease epoch、worker、account/mapping/assignment、現在manifestをserver側で再確認し、通常のobserved列やquarantine recoveryを更新しない。
- `ota-worker` はmanifestを固定readerへ渡し、reader応答を1回512facts・256 KiB、配送を最大4096page・各32facts・JSON実byte 16 KiB以下に制限する。外部cursorは512文字、snapshot tokenは256文字まで受け、分割位置とcursorのdigestから512文字以下のopaque chainを作る。選別済みfactとimmutable receiptだけを送信前にowner-only private journalへ保存し、ACK喪失時は同一payloadを最大1回だけ再送する。deadline/lease失効ではreader callbackを待ち続けず直ちにstopを開始し、有界時間内に停止を証明できなければ成功へしない。reader registryは`GetYourGuide/gyg-browser@1`だけを持ち、Studioのlocal configの`reservationReaders`に明示した場合だけ使う（既定は空）。未登録・未有効のreaderでは期間readを開始せず、unsupported readerを空の`COMPLETE`へ置換しない。

## GetYourGuide reader（実サイト未受入）

2026-10-31に追加。専用profileで実画面の`/bookings`をread-onlyで観測したquery構造（`supplierBookingEntitySearch`、`BookingSearchInput`のlimit/offset/sorts/filters、`pagination.totalItems`）に基づく。観測時の予約一覧は空だったため、各fieldの型と非空時の状態の組合せは未確認である。

- 専用profileのbrowserで会社のSupplier IDを照合してから`/bookings`を通常UIで開く。画面自身の読み取りqueryが通るまで待ち、その認証headerをメモリだけに保持する。保存・ログ・journalへ出さない。
- 読み取りは固定の名前付きquery `NihoReservationWindowRead`を同じ画面内から送る。selectは予約ID、状態、人数、開始時刻、option/商品ID、optionの所要時間だけで、顧客名・連絡先・価格・ticket・位置は取得しない。mutationと未許可の遷移は遮断する。
- 条件はsupplierIdと開始時刻の範囲だけで、状態filterを付けない。GYG側の日時解釈が未確認のため、coverageの前後24時間まで広げて読み、coverage外の予約はfactにしない。他商品の予約は件数照合に数えるが、factにはしない。
- `status=CANCELED`だけを取消とする。`ACTIVE`かつ`guideStatus=CONFIRMED`かつ`isPending=false`を確定とし、それ以外のACTIVEは受付中として占有を保つ。未知の値、offsetの無い開始時刻、未知の所要時間単位、24時間を超える所要時間は推測せず停止する。終了時刻はGYGのoption所要時間から求め、manifestから借りない。NIHOと時刻が一致しない予約はserverが要確認にする。
- 完全性は、各ページの`totalItems`が変わらないこと、IDが重複しないこと、読んだ件数が総数と一致することの全てで判断する。途中の件数変化・重複・欠落はPARTIALとし、それまでのページは観測として残す。総数が4000件を超える場合は停止する。
- local configの`reservationReaders`は既定で空であり、serverの`canReadReservations` capabilityも変えていない。非空の予約での型と状態、日時filterの解釈、状態filterなしで全状態が返ることを許可済み口座の実読取りで受け入れるまで、どちらも有効にしない。

## V1対象と実行単位

GetYourGuide、Airbnb、Viator、じゃらんがV1対象。サイト別の予約readerは、現在状態・明示取消・日時変更・人数を正しく読めることをそれぞれ受け入れる。AirbnbのGoogle busy区間だけでは予約ID、人数、取消の正本を作れない。メールは再照会の合図に限定する。

Airbnbは2026-10-31に許可済みStudioのChromeで本人照合・カレンダー・「今日／今後」をread-onlyで確認した。カレンダーの開催枠と個別予約は別であり、非空予約・明示取消・全ページの根拠は未確認のためreaderは未実装・既定OFFを維持する。確認できたschemaと有効化条件は[Airbnb予約取込みの実画面調査（#312）](ota-airbnb-reservation-discovery.md)に記録する。

15分照合を一回ずつ全実施回の画面を開く構造にはしない。8週間×4販路の空実施回を逐次巡回すると、1時間の許容遅延を超えやすい。既存accountの排他lease内で、同一listingの期間全体を有界に走査する。最初は1商品・1組予約、8週間、既知account/listingだけを対象にする。

## server発行の読取scope

#236のAPIは単一canonical occurrenceを対象にする。そのまま別の回の予約を投入してはならない。期間走査用に次の境界を拡張した。

- serverがaccount/listing/mapping version、期間、既存canonical occurrenceとUTC時刻の対応表を固定する。worker入力から商品・回・別提供者を新設しない。
- serverが外部アクセス前に一つの単調generationを発行する。既存のbrowser leaseを再利用し、別のTTL排他を重ねない。
- 最大32件のpageごとにimmutable receipt IDとfingerprintを保持し、page ACK喪失を同じpayloadで再送する。別page、cursor chain、旧mappingを混ぜない。
- pagination完走、全状態filter、対象account/product、coverage、読取開始・終了を確認した場合だけCOMPLETEにする。`allPagesRead` / `allStatusesIncluded` / `coverageComplete`はallowlist済みreaderによる宣言であり、serverがvendor画面の完全性を独立に証明したものではない。完走不明・件数上限・途中認証切れはPARTIAL/FAILEDにし、未受入readerのcapabilityは閉じたままにする。
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

## 次batchに残るもの

- GetYourGuide、Airbnb、Viator、じゃらん各サイトの実readerと実サイトでの全状態・全page・取消・日時変更・challenge受入。
- GetYourGuide readerの実読取り受入（非空予約・取消・日時変更・全状態・ページ送り）と有効化。Airbnb・Viator・じゃらんのreader、既知予約欠落時の詳細再照会フローへの接続。受入前のreaderでは本番capabilityを開けない。
- rolloutは旧worker停止の確認、migrationとserver、新worker、サイト別受入、deployment/listing capabilityの順とする。予約期間jobだけ新purpose/receiptを使い、通常の枠jobは従来shapeを維持する。
- 許可済み実サイトでの1時間以内という同期目標の計測。15分/45分は今回保存した初期運用値であり、達成済み実測ではない。
- Studio常駐設定、段階的なdeployment/listing capability有効化、実DB migrationと本番/ステージング受入。未対応readerを本番対応へ昇格しない。
