# OTA外部予約台帳

対象: #236（親 #194 / #200）。外部掲載先から正規に読み取った現在の予約事実を、Experienceの共有在庫へ反映するサーバー側契約を定義する。実OTA driver、account全体の走査、15分scheduler、Studio常駐設定は #237 とし、この文書の配備だけでは外部アクセスを開始しない。

## 境界と保存内容

外部予約は直販の `bookings`、支払台帳、guest確認tokenとは別の `external_reservations` に保存する。正本キーは `source site + 読取時のexternal account ID snapshot + external reservation ID` であり、変更可能な内部account IDだけに依存しない。current rowはprovider、listing、product、canonical occurrence、外部product/option、source開始・終了、人数、`PENDING / CONFIRMED / CANCELLED`、local revision、任意のsource更新時刻・opaque revision、最後に受理したDB generation、`payment_owner=EXTERNAL`を持つ。

顧客氏名、メール、電話、価格、料金差、cookie、画面のraw JSONは保存しない。取込は料金・決済・返金・取消・顧客通知を実行しない。通常のHost/operator DTOにも外部予約IDや個別人数を追加せず、在庫評価後の集計だけを既存の権限範囲で使う。

`external_reservation_revisions` は適用、重複、stale、要確認の各observationを監査保持する。`external_reservation_inventory_snapshots` とresource occupancyはlocal revisionごとに不変であり、日時変更・取消でも過去snapshotを削除しない。current ledgerが指すrevisionだけが現在の占有になる。

## 読取サイクルとHTTP契約

既存の認証済みworker、account assignment、全体/account排他OBSERVE leaseを再利用する。独自browser leaseやTTL解放は作らない。listingの `canReadReservations` は既定falseで、listing設定と配備adapter allowlistの両方がtrueのときだけ使える。`canObserve`だけでは予約を投入できない。

すべて `POST`、JSON 16 KiB以下、`private, no-store` とする。

- `/internal/ota/v1/jobs/{id}/reservation-read`: `{leaseToken}`。DB identity由来の単調 `generation` を外部サイトの読取り前に固定し、`readId`、対象occurrenceとsource時刻を返す。同じjob + lease epochの再送は同じreadを返す。
- `/internal/ota/v1/jobs/{id}/reservations`: `{receiptId,readId,leaseToken,batchStatus,observations}`。`receiptId` はUUID v4。最大32件。`batchStatus` は `COMPLETE / PARTIAL / FAILED` を区別し、`FAILED` は空配列だけを受ける。

observationのallowlistは `externalReservationId`、`externalProductId`、任意の`externalOptionId`、canonical UTCのsource開始・終了、`PENDING / CONFIRMED / CANCELLED`、1〜1000の人数、任意のcanonical UTC `sourceUpdatedAtUtc`、任意のopaque `sourceRevision` だけである。unknown key、batch内重複ID、不正時刻・人数をtransaction前に拒否する。空配列、欠落、`PARTIAL`、`FAILED`を取消と推定せず、明示された`CANCELLED`だけが占有を解除する。

begin/submitは毎回、worker credential version、assignment version、account active/revocation/delegation/version、listing active/mapping、OBSERVE jobのlease epoch/token/期限/worker、`canObserve`、`canReadReservations`、配備adapter能力、product公開状態、job snapshotと現在のcanonical occurrence時刻を確認する。通常のdesired versionだけが変わっても同じ商品・回・時刻の予約事実は捨てない。mapping、商品、対象時刻が変わった場合は409で止める。

## 冪等性、順序、quarantine

取込transactionは既存preflight/resultと同じくworker rowで同一workerの要求を直列化し、jobからproviderをnolockで特定して`provider-inventory:{providerId}` advisory mutexを取る。その後にreceipt、job/assignment/account/listing、read、ledgerを一定順序でlockする。workerを持つ処理はworker→providerの順を守り、provider取得後のworker lockを避ける。receiptにはpayload全体のSHA-256 fingerprintと結果を耐久保存する。同じreceipt + 同じpayloadは再適用せず同じ結果を返し、payload改変または同じreadへの別receiptは409とする。受付済みreceiptはjob終了・lease期限後も現在のcredentialと元のassignment version・account権限を検証して再送でき、在庫やoutboxを再適用しない。batch途中のDB失敗はreceipt、ledger、revision、占有snapshot、calendar outboxをすべてrollbackする。

generationがcurrent rowより古ければ適用しない。`sourceUpdatedAtUtc` が双方にある場合は古い時刻をstaleとし、同時刻で内容が違えば要確認にする。`sourceRevision` はopaque equality情報であり大小比較しない。更新時刻がない新しい事実は、新しい正規read generationからだけ反映できる。取消先着もtombstoneとして残り、古いCONFIRMED再送で復活しない。

外部product/optionまたはsource時刻がjob targetと違うobservationは、最小事実だけを`NEEDS_REVIEW` revisionとして残す。新しいキーにはquarantine rowを作るがcanonical occurrenceへ結ばない。既存のactive予約で不一致が来ても以前の占有を解放しない。別provider・listing・occurrenceを入力から新設しない。対象不一致・同一source版の矛盾が未解決ならprovider全体を`EXTERNAL_RESERVATION_UNRESOLVED`で新規受付不可にし、再計算を通知する。会場や時刻が確定できないため範囲を推測しない。新しい正規readで対応を確定するまで、この保留をTTLや空結果で解除しない。

## 共有在庫

`PENDING` と `CONFIRMED` をactiveとして扱う。`SEAT` は外部人数を直販の確定席・有効HOLDへ加算し、`PRIVATE_GROUP` はactiveな1件で満席とする。取込時点の商品booking mode、resource、準備・片付けbufferをsnapshotする。同じ外部キーの正規な別occurrence読取は、current pointerを旧snapshotから新snapshotへ一つのtransactionで移す。

外部予約が直販HOLD/確定予約、別の外部予約、同じ会場・講師のoccupancyと競合しても、事実を自動取消・選別しない。両方を保持して外部ledgerを要確認にし、availabilityは安全側に閉じる。取消はその外部revisionだけを非activeにし、manual CLOSED、別予約、Google busy、inactive resourceを解除しない。

外部予約の追加・人数変更・移動・取消は旧/新occurrenceの `calendar_outbox_events` を同じtransactionで作る。既存inventory evaluatorがexternal active seat/group/resource occupancyを読むため、Host/guest HOLD、channel desired/preflight/resultは同じ判定になる。同じresourceを使う別商品はCLOSEになり、別resourceや非重複時間は影響を受けない。schedule/occurrence日時とproduct inventory設定の「予約あり」guardにもactiveな外部予約を含める。

source siteまたはexternal account IDを変えるAdmin更新は、同じprovider inventory mutex内で未終了のactive外部予約を検査し、存在時は拒否する。表示名、停止、委任状態の変更はidentity変更とは分ける。

## 保持・DB権限・配備順

初期保持期間はsource終了から7年とし、current ledger/tombstone、revision、read、receipt、inventory snapshotを同じ監査単位で保持する。active、未終了、未解決review、参照中snapshotは7年を過ぎても解決前に消さない。個人情報を追加しない前提を維持し、自動削除jobはこのsliceに含めない。将来の削除jobは一つの外部予約に属する参照を監査単位で処理し、currentだけ、またはreceiptだけを先に消さない。

runtime DB roleはchannelのread/job/receipt/ledger/snapshotとcalendar outboxに必要な限定権限だけを持たせ、migration roleと分離する。公開CIは合成DBだけを使い、本番cookie・予約・顧客情報へ接続しない。

配備は次の順に行う。

1. `0014_external_reservations.sql` を先行適用する。
2. 新コードを配備するが、runtime flag、listing capability、adapter allowlistはfalseのままにする。
3. 合成PostgreSQL試験とstagingでreceipt再送、stale generation、取消tombstone、移動、共有resource競合、rollback、権限失効を確認する。
4. #237のreaderを対象adapter単位で受け入れ、`canReadReservations` を配備allowlist、listingの順に限定有効化する。
5. rollback時はcapabilityをfalseにして新規readを止める。既に受理したledgerと占有を削除せず、旧writerと同じ枠を二重販売しない。
