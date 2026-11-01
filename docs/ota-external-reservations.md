# OTA外部予約台帳

対象: #236（親 #194 / #200）。外部掲載先から正規に読み取った現在の予約事実を、Experienceの共有在庫へ反映するサーバー側契約を定義する。実OTA driver、account全体の走査、15分scheduler、Studio常駐設定は #237 とし、この文書の配備だけでは外部アクセスを開始しない。

## 境界と保存内容

外部予約は直販の `bookings`、支払台帳、guest確認tokenとは別の `external_reservations` に保存する。正本キーは `source site + 読取時のexternal account ID snapshot + external reservation ID` であり、変更可能な内部account IDだけに依存しない。current rowはprovider、listing、product、canonical occurrence、外部product/option、source開始・終了、人数、`PENDING / CONFIRMED / CANCELLED`、local revision、任意のsource更新時刻・opaque revision、最後に受理したDB generation、`payment_owner=EXTERNAL`を持つ。

価格、料金差、cookie、画面のraw JSONは保存しない。予約者の名前・人数の内訳・連絡先・言語・OTA の予約番号・OTA 側のメモは、オーナー決定（2026-11-01、#194）で保存して `/host` に出す。台帳とは別の表に置き、下の「予約者の情報（#194）」に従う。取込は料金・決済・返金・取消・顧客への連絡を実行しない。ホストに出すのは下の「ホストが読むもの」だけで、外部 account ID・外部予約 ID・listing・calendar ID は出さない。

`external_reservation_revisions` は適用、重複、stale、要確認の各observationを監査保持する。`external_reservation_inventory_snapshots` とresource occupancyはlocal revisionごとに不変であり、日時変更・取消でも過去snapshotを削除しない。current ledgerが指すrevisionだけが現在の占有になる。

## 読取サイクルとHTTP契約

既存の認証済みworker、account assignment、全体/account排他OBSERVE leaseを再利用する。独自browser leaseやTTL解放は作らない。listingの `canReadReservations` は既定falseで、listing設定と配備adapter allowlistの両方がtrueのときだけ使える。`canObserve`だけでは予約を投入できない。

すべて `POST`、JSON 16 KiB以下、`private, no-store` とする。

- `/internal/ota/v1/jobs/{id}/reservation-read`: `{leaseToken}`。DB identity由来の単調 `generation` を外部サイトの読取り前に固定し、`readId`、対象occurrenceとsource時刻を返す。同じjob + lease epochの再送は同じreadを返す。
- `/internal/ota/v1/jobs/{id}/reservations`: `{receiptId,readId,leaseToken,batchStatus,observations}`。`receiptId` はUUID v4。最大32件。`batchStatus` は `COMPLETE / PARTIAL / FAILED` を区別し、`FAILED` は空配列だけを受ける。

observationのallowlistは `externalReservationId`、`externalProductId`、任意の`externalOptionId`、canonical UTCのsource開始・終了、`PENDING / CONFIRMED / CANCELLED`、1〜1000の人数、任意のcanonical UTC `sourceUpdatedAtUtc`、任意のopaque `sourceRevision`、任意の `guest`（下の「予約者の情報（#194）」）だけである。unknown key、batch内重複ID、不正時刻・人数・予約者の情報をtransaction前に拒否する。空配列、欠落、`PARTIAL`、`FAILED`を取消と推定せず、明示された`CANCELLED`だけが占有を解除する。

begin/submitは毎回、worker credential version、assignment version、account active/revocation/delegation/version、listing active/mapping、OBSERVE jobのlease epoch/token/期限/worker、`canObserve`、`canReadReservations`、配備adapter能力、product公開状態、job snapshotと現在のcanonical occurrence時刻を確認する。通常のdesired versionだけが変わっても同じ商品・回・時刻の予約事実は捨てない。mapping、商品、対象時刻が変わった場合は409で止める。

## 冪等性、順序、quarantine

取込transactionは既存preflight/resultと同じくworker rowで同一workerの要求を直列化し、jobからproviderをnolockで特定して`provider-inventory:{providerId}` advisory mutexを取る。その後にreceipt、job/assignment/account/listing、read、ledgerを一定順序でlockする。workerを持つ処理はworker→providerの順を守り、provider取得後のworker lockを避ける。receiptにはpayload全体（予約者の情報を除く。#194）のSHA-256 fingerprintと結果を耐久保存する。同じreceipt + 同じpayloadは再適用せず同じ結果を返し、payload改変または同じreadへの別receiptは409とする。受付済みreceiptはjob終了・lease期限後も現在のcredentialと元のassignment version・account権限を検証して再送でき、在庫やoutboxを再適用しない。batch途中のDB失敗はreceipt、ledger、revision、占有snapshot、calendar outboxをすべてrollbackする。

generationがcurrent rowより古ければ適用しない。`sourceUpdatedAtUtc` が双方にある場合は古い時刻をstaleとし、同時刻で内容が違えば要確認にする。`sourceRevision` はopaque equality情報であり大小比較しない。更新時刻がない新しい事実は、新しい正規read generationからだけ反映できる。取消先着もtombstoneとして残り、古いCONFIRMED再送で復活しない。

外部product/optionまたはsource時刻がjob targetと違うobservationは、最小事実だけを`NEEDS_REVIEW` revisionとして残す。新しいキーにはquarantine rowを作るがcanonical occurrenceへ結ばない。既存のactive予約で不一致が来ても以前の占有を解放しない。別provider・listing・occurrenceを入力から新設しない。対象不一致・同一source版の矛盾が未解決ならprovider全体を`EXTERNAL_RESERVATION_UNRESOLVED`で新規受付不可にし、再計算を通知する。会場や時刻が確定できないため範囲を推測しない。新しい正規readで対応を確定するまで、この保留をTTLや空結果で解除しない。

## 共有在庫

`PENDING` と `CONFIRMED` をactiveとして扱う。`SEAT` は外部人数を直販の確定席・有効HOLDへ加算し、`PRIVATE_GROUP` はactiveな1件で満席とする。取込時点の商品booking mode、resource、準備・片付けbufferをsnapshotする。同じ外部キーの正規な別occurrence読取は、current pointerを旧snapshotから新snapshotへ一つのtransactionで移す。

外部予約が直販HOLD/確定予約、別の外部予約、同じ会場・講師のoccupancyと競合しても、事実を自動取消・選別しない。両方を保持して外部ledgerを要確認にし、availabilityは安全側に閉じる。取消はその外部revisionだけを非activeにし、manual CLOSED、別予約、Google busy、inactive resourceを解除しない。

外部予約の追加・人数変更・移動・取消は旧/新occurrenceの `calendar_outbox_events` を同じtransactionで作る。既存inventory evaluatorがexternal active seat/group/resource occupancyを読むため、Host/guest HOLD、channel desired/preflight/resultは同じ判定になる。同じresourceを使う別商品はCLOSEになり、別resourceや非重複時間は影響を受けない。schedule/occurrence日時とproduct inventory設定の「予約あり」guardにもactiveな外部予約を含める。

source siteまたはexternal account IDを変えるAdmin更新は、同じprovider inventory mutex内で未終了のactive外部予約を検査し、存在時は拒否する。表示名、停止、委任状態の変更はidentity変更とは分ける。

## 要対応キューと反映時間の計測

対象: #200。競合を残した外部予約をスタッフの要対応として表に出し、予約を検知してから他の販路で受付停止を確認するまでの時間を測る。予約の自動取消・再課金・返金・顧客への連絡はしない。手動の「対応済み」も記録だけで、予約・直販予約・在庫・jobを変えない。

### 要対応キュー（`external_reservation_conflict_cases`）

- 開始: active（`PENDING`/`CONFIRMED`）の外部予約の書込みが `INVENTORY_CONFLICT` になったとき、ledger と同じ transaction・provider inventory mutex の中で、その occurrence の OPEN case を作るか `last_seen_at` を更新する。OPEN case は provider×occurrence で1件。
- メンバー: その外部予約、同じ occurrence の active な外部予約と直販予約（確定と期限内HOLD）、資源の衝突で当たった相手の予約（取れる範囲、最大50件）。同じ予約は1回だけ登録する。DUPLICATE/STALE の再送では何も作らない。
- 自由記述の列はない。Admin へは site・外部予約ID・人数・現在の状態、直販は予約IDだけを返し、external account ID は返さない。
- 自動解決: watchdog が、その occurrence に `review_reason='INVENTORY_CONFLICT'` の active な外部予約が残っていなければ `CONFLICT_CLEARED` で閉じる。ledger はこの flag を書込み時にだけ再計算するため、先に入った側（flag なし）が取り消されても、後から入った側の flag は残り、case は開いたままになる。その場合はスタッフが閉じる。
- 手動解決: `CUSTOMER_CONTACTED`（お客様に連絡した）、`ACCEPTED_BOTH`（両方の予約を受け入れる）、`CANCELLED_AT_SOURCE`（予約元で取り消された）の3つだけ。UUID v4 command で冪等にし、`channel_audit_events` に残す。`CONFLICT_CLEARED` は手動では受け付けない。担当は「担当する」で自分にする。
- incident: OPEN case ごとに `EXTERNAL_RESERVATION_CONFLICT`（subject は case）を開き、顧客対応が要るため最初から escalated にする。case が閉じた次の watchdog 実行で incident も閉じる。
- 競合を含む予約読取は既存の契約どおり完全性の証明にならず、その外部アカウントは `NEEDS_REVIEW` で隔離される。キューはその後のスタッフ対応の入口であり、隔離の解除は既存の復旧手順による。

### 反映時間の計測（`channel_propagation_measurements` / `_targets`）

- 作成: ある revision で外部予約がその occurrence で新たに active になったとき（新規、別 occurrence への移動、取消からの復活）に1件。`detected_at` はその revision を書いた時刻、`source_updated_at` は観測値のまま。
- target: 同じ商品の active な listing のうち、検知元の listing を除いたもの。0件ならその場で `NOT_REQUIRED`。
- 判定（watchdog、同じ advisory lock 内、1回最大500件）:
  1. 予約がその occurrence でもう active でなければ `ABANDONED`。
  2. target ごとに、desired が CLOSED で同期済み（observed CLOSED、desired/mapping 版一致）かつ `last_verified_at >= detected_at` なら `VERIFIED`。その listing・occurrence で検知後に VERIFIED になった最新の SET_CLOSED job の作成時刻と claim 時刻（`lease_started_at`）を記録する。
  3. この予約を反映する calendar outbox が処理済みのとき、desired が OPEN なら席が残るので `NOT_REQUIRED`。検知前に閉鎖を確認済みで desired が変わらなかった target も `NOT_REQUIRED`。outbox が未処理なら判定を保留する。
  4. 全 target が VERIFIED か NOT_REQUIRED になれば、VERIFIED が1件以上で `COMPLETED`（`closed_verified_at` は最大値）、なければ `NOT_REQUIRED`。
  5. 検知から24時間を超えたら `TIMED_OUT`。未確定の target は `UNVERIFIED`。`ABANDONED` の残りも `UNVERIFIED` にする。
- 「この予約を反映する outbox」は、書込み直後の provider の最大 outbox ID（`outbox_watermark_id`）以下で、すでに処理可能な（`available_at <= now`）未処理 event。時刻だけで比べると、同じ transaction で作った event をアプリとDBの時計差で見落とすため ID で区切る。
- 区間: 検知→他の販路で閉鎖を確認（`closed_verified_at - detected_at`、COMPLETED のみ）、検知の遅れ（`detected_at - source_updated_at`、値がある分だけ）、実行待ち（target の job claim − job 作成）。Admin の `propagationMetrics` は直近30日（最大1万件）を SQL の `percentile_cont` で集計し、status 別件数、p50/p95/最大、60分超の件数、検知元 site 別の件数と p95、未確定の件数と最古の経過時間を返す。未確定は30日で区切らない。

### 対象の限界

- 計測するのは同じ商品の他の listing だけである。会場・講師などの資源を共有する別商品の閉鎖は計測しない。
- target は listing が active かだけで決める。account の停止・隔離や capability 不足で自動では閉じられない listing は、閉鎖を確認できず `TIMED_OUT` になる。
- 確認は Studio の readback（`last_verified_at`）による。外部サイトで実際に予約が入らなかったことの証明ではない。
- pilot の目標値（反映時間など）は、このコードと合成テストだけでは達成済みとしない。実 Studio・実販路での計測結果で判断する。

## 予約者の情報（#194）

オーナー決定（2026-11-01）：「名前・人数・連絡先を保存して出す」。NIHO Experience をチャネルマネージャーにするため、どの OTA からどんな予約が来たかを `/host` とホストへの通知で分かるようにする。金額はこの決定に含まないため保存しない。

- **項目**：`guest` は任意で、中の項目もすべて任意。各サイトの reader は実画面で確かめた項目だけを入れ、確かめていない項目は入れない（推測しない）。
  - `name`：予約の名前（1〜200 字、前後の空白・制御文字なし）。
  - `partyBreakdown`：年齢区分ごとの人数。区分は `ADULT`・`SENIOR`・`YOUTH`・`STUDENT`・`CHILD`・`INFANT`（各 1 回）で、合計は `seats` と一致する。サイトの区分が当てはまらなければ入れない。
  - `email`（3〜254 字）、`phone`（数字・空白・`( ) . -` と先頭の `+`、32 字まで）、`language`（BCP 47、例 `en`・`en-US`）。
  - `bookingReference`：OTA の予約番号（英数字と `. _ -`、64 字まで）。ホストが OTA の画面で予約を探すために出す。
  - `notes`：予約者が OTA に書いたこと（1,000 字まで、改行とタブ以外の制御文字なし）。
  - これ以外の項目（金額・チケット・住所・cookie など）を入れた事実は、ページごと 400（worker は送る前に止める）。
- **保存**：`0036_external_reservation_guests.sql` の `external_reservation_guests`（外部予約 1 件に 1 行）。台帳・revision・receipt には入れない。
  - 台帳・window の事実・receipt の fingerprint は、どれも在庫の事実だけで計算する。名前や電話が後から読めても新しい revision にならない。7 年の監査に予約者の情報の digest も残らない。
  - そのため、同じ receipt の再送で予約者の情報だけが違うときは同じページとして扱い、最初に保存した内容を残す（worker は ACK を失ったときも同じ payload を送る）。
  - 同じ予約を読み直すたびに、読めた項目で上書きし、読めなかった項目は前の値を残す（サイトが日付の後に連絡先を隠すことがあるため）。
  - 正しい対象（商品・option・時刻が job と一致）の事実のときだけ保存する。要確認（`TARGET_MISMATCH`）や古い版（STALE）の情報では書き換えない。
  - `EXPERIENCE_OTA_GUEST_DETAILS_ENABLED`（既定 OFF）が off の間は、検証だけして捨てる。
- **ホストが読むもの**：`HostOtaBookings`（`packages/experience-store/src/host-ota-bookings.ts`）。
  - 読める人：提供者の OWNER（全商品）と、商品の運営者（担当の商品だけ。[商品限定運営者](product-operators.md)）。EDITOR・VIEWER は担当の grant が無ければ読めない。権限はサーバーで grant から決め、リクエストからは取らない。
  - 中身：出どころ（site）、体験、回、日時、状態、人数と内訳、OTA の予約番号、名前・メール・電話・言語・メモ、消去済みか、要確認か。
  - 出さないもの：外部 account ID、外部予約 ID、listing、calendar ID、金額。
  - 予約の取り違えを防ぐため、ホストへの手がかりは `host_ref`（台帳の行ごとの UUID）だけにする。push のリンクと画面はこれで予約を開く。
- **消去**：メール job（`POST /internal/experience-jobs/v1/drain`、#320）の段 `otaGuestErasure` が `ExternalReservationGuests.eraseGuestDetails` を呼ぶ。
  - 時期：このサイトの予約者と同じく、体験の終了から 1 年。取り消された予約は、取消を読んだ時から 1 年。
  - 例外：開いている要対応キュー（`external_reservation_conflict_cases` の `OPEN`）に入っている予約は、スタッフが連絡するかもしれないので、閉じるまで残す。
  - 消した行は `pii_erased_at` を持ち、trigger で戻せない。台帳・revision・在庫の snapshot は 7 年のまま。
  - flag が off でも段は動く（on の間に保存した分を消すため）。flag を on にするには `EXPERIENCE_GUEST_MAIL_ENABLED` が要る。

## ホストへの通知（#194）

OTA の予約の新規・取消・日時変更を、商品の OWNER と運営者へ push で知らせる。`EXPERIENCE_OTA_BOOKING_NOTIFICATIONS_ENABLED`（既定 OFF、`HOST_PUSH_ENABLED` が要る）。

- **いつ**：台帳の transaction で、正しい対象の revision が次のとき `outbox_messages` に `host.notify.ota_booking` を 1 行積む（重複キーは `host_ref` と local revision）。
  - 新規：この回で active になった（初めて読んだ、取消から戻った、要確認から回に結び付いた）。
  - 取消：active だった予約が `CANCELLED` になった。
  - 日時変更：active のまま別の回へ移った（`previousStartsAt` は前の source 時刻）。
  - 人数だけの変更、PENDING から CONFIRMED は知らせない。
- **知らせないとき**：
  - その listing の完全な読取りがまだ 1 回も無い（health の行が無い）。最初の完全な読取りは基準で、そこで見つかる予約は以前からあったものとして扱う。
  - 回がもう始まっている。
- **中身**：OTA の名前、体験、日時、予約者の名前、人数だけ。連絡先・金額・外部 ID は載せない（連絡先は PWA で見る）。
  - 名前は送るまでの間だけ payload にあり、push job が行を閉じるときに消す。送られないまま 48 時間たった行の名前は、メール job の消去が消す。
- **送り方**：既存の push job（`/internal/host-push/v1/drain`）。
  - 設定 › 通知の種類は、新規と日時変更が「新しい予約・申込」、取消が「予約の取消」。どちらも止められない種類なので、設定を読まずに送る。
  - 宛先は商品の OWNER と運営者の端末だけ（`HostPushSubscriptions.productRecipients`）。EDITOR・VIEWER・別の商品の運営者には送らない。
  - 題は「GetYourGuide で新しい予約」「Airbnb の予約が取り消されました」「じゃらん の予約の日時が変わりました」。本文は「体験 · 日時（変更は 前 → 後） · 名前 様 · 人数」。
  - タップで `/host/bookings?ota=<host_ref>&providerId=…`（画面は #194 の PR 2）。
- **メールはまだ送らない**：experience DB にはホストのメールアドレスが無い（アドレスは NIHO の正本）。宛先の取り方をオーナーが決めるまで、メールの topic は積まない。

## 保持・DB権限・配備順

初期保持期間はsource終了から7年とし、current ledger/tombstone、revision、read、receipt、inventory snapshotを同じ監査単位で保持する。active、未終了、未解決review、参照中snapshotは7年を過ぎても解決前に消さない。予約者の情報だけは上の「予約者の情報（#194）」のとおり 1 年で消す。台帳全体の自動削除jobはまだ無い。将来の削除jobは一つの外部予約に属する参照を監査単位で処理し、currentだけ、またはreceiptだけを先に消さない。

runtime DB roleはchannelのread/job/receipt/ledger/snapshotとcalendar outboxに必要な限定権限だけを持たせ、migration roleと分離する。公開CIは合成DBだけを使い、本番cookie・予約・顧客情報へ接続しない。

配備は次の順に行う。

1. `0014_external_reservations.sql` を先行適用する。
2. 新コードを配備するが、runtime flag、listing capability、adapter allowlistはfalseのままにする。
3. 合成PostgreSQL試験とstagingでreceipt再送、stale generation、取消tombstone、移動、共有resource競合、rollback、権限失効を確認する。
4. #237のreaderを対象adapter単位で受け入れ、`canReadReservations` を配備allowlist、listingの順に限定有効化する。
5. rollback時はcapabilityをfalseにして新規readを止める。既に受理したledgerと占有を削除せず、旧writerと同じ枠を二重販売しない。

予約者の情報と通知（#194）は次の順に行う。

1. `0036_external_reservation_guests.sql` を先に適用する（表を足すだけ。旧 writer は新しい表を読まず、`external_reservations` への INSERT は `host_ref` の既定値で通る）。runtime role に `external_reservation_guests` の SELECT・INSERT・UPDATE を付ける（`scripts/gcp/experience-db-grants.mjs`）。
2. 新コードを配備する。`EXPERIENCE_OTA_GUEST_DETAILS_ENABLED` と `EXPERIENCE_OTA_BOOKING_NOTIFICATIONS_ENABLED` は off のまま。メール job の消去の段はこの時点から動く。
3. `EXPERIENCE_GUEST_MAIL_ENABLED` を on にした環境で予約者の情報の flag を、`HOST_PUSH_ENABLED` を on にした環境で通知の flag を on にする（配備 workflow の機能のフラグ、[production-deploy.md](production-deploy.md)）。
4. reader が予約者の情報を送るのは、そのサイトの実画面で項目を受け入れた後だけ（[外部予約の定期照合](ota-reservation-read-plan.md)）。
5. rollback は flag を off にする。保存済みの予約者の情報は、消去の段が 1 年後に消す。
