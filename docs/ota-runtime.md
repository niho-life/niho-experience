# OTA channel runtime

対象: #194、#196、#197、#198、#234、#235、#236、#240。外部掲載先の account/listing 対応表と、Studio executor が利用する耐久 job 契約を定義する。共有在庫は[OTA共有在庫](ota-inventory.md)、外部予約取込のserver契約は[OTA外部予約台帳](ota-external-reservations.md)に記録する。Host の開催枠詳細はこの read model を表示する。実OTA予約readerとGoogleへの枠制御出力は未実装である。本番の自動実行、scheduler、launchd、外部サイト接続も有効化しない。

## 既定で閉じるゲート

- Admin API は `apiMode=http` かつ `EXPERIENCE_CHANNEL_MANAGER_ENABLED=true` の場合だけ開く。NIHO がその時点で検証した Admin HTTP session が必要で、mock/preview cookie は利用できない。
- worker API は別の `EXPERIENCE_CHANNEL_RUNTIME_ENABLED=true` が必要である。人間用 cookie は認可に使わず、worker bearer を `Authorization` header だけで受け取る。
- DB 未設定は `503` とし、HTTP 失敗から mock へ切り替えない。両 flag の既定値は false である。
- 監視 endpoint は別の `EXPERIENCE_CHANNEL_WATCHDOG_ENABLED=true` と、audience・service account email の両方が揃う場合だけ開く（[監視・heartbeat・復旧](#監視heartbeat復旧)）。
- capability は account/listing 作成だけでは有効にならない。配備設定 `EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS` に明示された `site/adapter@version` の boolean だけを Admin が保存でき、claim/preflight/result でも同じ配備 allowlist を再確認する。未設定・不正設定は全 capability false となり、live job は claim されない。
- groups/resources の共有在庫基盤は [OTA共有在庫](ota-inventory.md) に実装したが、外部予約取込みと実OTAでの結合受入は未完了なので、配備 flag は引き続き有効にしない。

`EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS` は秘密ではない JSON で、例は `{"GetYourGuide/gyg-browser@1":{"canObserve":true,"canReadReservations":false,"canClose":true,"canOpen":true}}`。これは実装・受入済み capability の allowlist であり、サイト名だけから対応済みとは判断しない。`canReadReservations` は既定falseで、`canObserve`から暗黙に導出しない。

## Registry と権限境界

external account は provider scope に属し、site、外部 account ID、表示名、運用モデル 1〜4、委任期限・失効、version を持つ。active の既定値は false。運用モデル 2 を記録できるが、credential 共有や cookie 受け渡しは実装しない。private profile は Secret Manager 等の opaque reference だけを保存し、read DTO に値も参照も返さない。
同一の実 account を複数 provider の別 account として扱わないため、`site + external account ID` は全体で一意にする。provider をまたぐ将来の集約は、同じIDの複製ではなく別途権限設計が必要である。

listing は provider 所有 product と同じ provider の account だけを結ぶ。外部 product/option、Asia/Tokyo、adapter/version、connection mode と個別 capability を持ち、active と capability の既定値は false。同じ product を複数 site/account へ結べるが、同じ account の外部 product/option は重複できない。更新は `expectedVersion` 必須で、Admin mutation は UUID v4 command と fingerprint で冪等化する。actor user ID は、HTTP 境界が fresh Admin 検証から作った `ChannelAdminActor` だけを受け入れる。

account の site・外部 account ID・委任・失効・active・profile 変更、listing の target/capability/active 変更は version を上げ、QUEUED job を `SUPERSEDED` にする。account の site または外部 account ID を変えた listing は停止・capability false・mapping version 更新へ戻し、再確認前の設定を引き継がない。LEASED job の immutable target は書き換えず、preflight/result で current version と不一致になる。古い job を新しい target へ転送しない。

worker credential の初回 mint と account assignment 作成は `expectedVersion: null`、rotation・再 assignment と revoke は現在の正の version を必須とする。raw credential を再表示する idempotent replay は行わず、同じ mint command の再送は conflict とする。

listing を active にしただけでは外部操作を作らない。Admin の deterministic `reconcile`、または `calendar_outbox_events` consumer が現在の schedule から desired state を再構築する。
active mapping の開催時刻変更は、旧外部枠を確実に閉じてから新 target へ移す P2 の手順が未実装である。この slice は古い時刻の preflight/result を拒否して quarantine するだけで、外部 reschedule を対応済みとはしない。従って runtime flag は引き続き無効にする。

### Admin の掲載先設定

`/admin/channels` と `/admin/api/channel-workspace` は channel manager flag が有効で、fresh な Admin HTTP session を毎回確認できる場合だけ開く。提供者を選び、商品、external account/listing、会場・講師・備品、商品の予約単位と準備・片付け時間を設定する。担当者の招待は既存 `/admin/operators`、定員は host calendar を使う。

新しい account/listing/資源は停止、listing capability は false が既定である。保存の受領は接続・外部反映の成功ではなく、再照合も job の受付までとする。料金は掲載先ごとに管理し、この画面・runtime は読み取りも同期も更新もしない。password、cookie、bearer、private profile、worker credential の入力・表示・mint/revoke/recovery はこの画面に置かない。

## Desired state と calendar outbox

対象期間は Tokyo local date の当日を含む 56 日、1 dispatch 最大 2,000 occurrence。outbox row は transaction 内で `FOR UPDATE SKIP LOCKED` する。対象期間と listing/rule/occurrence の続き位置を保存し、上限に達したページも desired/job と同時にcommitする。全ページ完了時だけ `processed_at` を付けるため、36 listing × 56日を超えても同じ先頭ページを永久にrollbackしない。重複 outbox/reconcile は、listing + canonical occurrence の同じ desired/mapping version と job unique key により重複操作を作らない。連続編集では未 lease の旧 job を coalesce して `SUPERSEDED` にする。
worker の claim は、認証済みworkerに割り当てられたaccountのproviderだけを対象に、bounded outbox dispatch を同期完了してからjobを選ぶ。listing単位のtransaction advisory lockにより、同時dispatchとAdmin reconcileを直列化する。

desired は schedule rule、reschedule override、直交した sales state を `expandOccurrences` で展開し、`evaluateAvailability` で決める。CONFIRMED と有効な HOLD の席、booking cutoff、Google blocking の freshness/coverage/busy を毎回参照する。Google が stale、coverage 外、または failed の時に OPEN を作らない。manual Block は schedule の `CLOSED` であり、外部 observed state と別の列・表示で扱う。

## Lease と executor 契約

- credential は random 32 bytes 以上の bearer を mint 時に一度だけ返し、DB には SHA-256 digest、期限、失効だけを保存する。GET、job target、URL、log 用 DTO には含めない。
- worker は明示 assignment のある account だけを claim できる。claim時のassignment versionをleaseへ固定し、renew/preflight/resultで一致を確認する。失効後に同じworkerへ再付与しても、古いleaseは復活しない。browser claim は全体 concurrency 1、account exclusivity 1。transaction advisory lock、row lock、partial unique index を併用する。
- lease は 120 秒、job deadline は初回claimから 180 秒で、retryしても延長しない。executor は30秒以内の間隔でrenewし、serverは最後の更新から60秒を越えたrenewを成功させない。CLOSED は OPEN より優先する。
- expired lease は自動で lock を解放しない。account を quarantine し、古い job は `LEASED` のまま残す。認証済み executor が `stopped=true` を返すか、Admin が executor 停止を明示確認した recovery だけが lock を解放できる。期限後に届いた停止確認は成功表示に使わず、隔離を維持したまま当該jobを終了して、他accountの処理を再開できるようにする。
- manual recovery は supported `OBSERVE` capability を必須とし、まず OBSERVE job を作る。exact target の fresh readback が VERIFIED になるまで quarantine を解除せず、OPEN を再作成しない。

worker endpoints は次の versioned route だけで、すべて `POST`、JSON 16 KiB 以下、`private, no-store` である。

- `/internal/ota/v1/claim`
- `/internal/ota/v1/jobs/{id}/renew`
- `/internal/ota/v1/jobs/{id}/preflight`
- `/internal/ota/v1/jobs/{id}/result`
- `/internal/ota/v1/jobs/{id}/reservation-read`
- `/internal/ota/v1/jobs/{id}/reservations`

claim に対象がなければ body なし `204`。認証不備は `401/403`、version/lease/preflight の stale は `409`。lease token は worker envelope の直下にだけ置き、target model へ入れない。

resultを監査保存した場合は `200 {acceptedAsCurrent,repeated}` でreceiptを返す。`acceptedAsCurrent:false`は現在の反映成功ではないが、同じ記録済みresultを新たな操作として再送する理由にもならない。actor/lease認証失敗や不正入力は引き続きエラーにする。

## Preflight と結果

preflight は worker、assignment、lease/deadline、account active/delegation/revocation/version、listing active/capability/mapping version、商品公開状態、desired version、配備adapterをtransaction内で確認する。全actionで現在のoccurrence開始・終了がimmutable job snapshotと一致することを確認する。`SET_OPEN`と`SET_CLOSED`は予約席、cutoff、Google freshness/coverage/busy、現在のsales stateを再計算し、現在の販売可否とactionが一致するときだけ実行する。再開直後でoutboxが未消費の場合にも古いCLOSEを成功扱いしない。古い操作は`409`で止め、lease lockを停止確認まで保持する。authorityや時刻が失効した場合はaccountもquarantineする。`ENSURE`やmodel proseによる成功判定はない。

結果は `VERIFIED`、`AUTH_REQUIRED`、`NEEDS_REVIEW`、`UNKNOWN_AFTER_SAVE`、`RETRY_WAIT`、`SUPERSEDED`。VERIFIED は immutable target、occurrence ID、source開始・終了の完全一致、current authorityとlive availability、lease/deadline内、`stopped=true`、実行window内のreadback時刻が揃った場合だけcurrent observed/synced stateを更新する。readbackは外部のmanual block状態と実際のbookable booleanを別フィールドで返す。`SET_CLOSED`はmanual block済みかつbookable=false、`SET_OPEN`はmanual blockなし、かつbookable=trueを必須にする。例えばmanual block=falseでもcutoffによりbookable=falseならOPEN成功ではない。結果UUIDはworker・job・lease epoch/digest・payloadへ結び、同じreceiptの再送だけを冪等に受ける。古い結果は監査保存できるがgreenにしない。`AUTH_REQUIRED`と`UNKNOWN_AFTER_SAVE`は書込みを盲目的にretryせずquarantineする。`RETRY_WAIT`だけを最大5 attempts、初回deadline内のbounded backoffで再試行できる。

## 公開する read model

Admin の `/admin/api/channels` は action allowlist だけを受け、任意 query を中継しない。Host の `/host/calendar/channels?providerId=...` は確立済みの `HostActor` を使い、`listCalendarProductsForActor` が許可した商品だけについて occurrence/site ごとの desired、observed、label、last verified、coarse error を返す。member は provider 内の許可範囲、product operator は自分の商品だけであり、人数・予約者・provider-wide の Google 情報を加えない。外部 account ID、worker、credential、private profile は返さない。

`/host/calendar` はタブが表示中の間だけ20秒間隔でこの read model を読み、非表示時は停止する。provider・週・pollの切替では `AbortController` と sequence を併用し、古い応答を適用しない。UI は `label=SYNCED` のときだけ「反映済み」とし、古い `observed` や `lastVerifiedAtUtc` から成功を推定しない。`PENDING` は「反映待ち」、`HELD` は「保留中」、`UNVERIFIED` は「未確認」、`ERROR` と 403/503/通信断は「要確認」とする。複数販路の集約は ERROR > UNVERIFIED > HELD > PENDING > SYNCED の順で悪い方を表示する。`HELD` は反映成功ではない。flag OFF の404と状態0件を成功として表示しない。calendar mutation の保存ACKはこの外部反映表示と別に扱う。保存直後は旧い成功表示を外し、掲載先も読み直す。状態0件は「未確認」とし、掲載の有無を推測しない。

## 監視・heartbeat・復旧

対象: #240。[worker詳細設計](ota-studio-worker-design.md)「9. 監視、失敗、費用」の server 側を実装する。scheduler・通知先・本番 flag はこの slice で作成・有効化しない。

### heartbeat と新規OPENの保留

- heartbeat は worker の `claim` 時刻（`last_heartbeat_at`）である。前回から90秒を超えた claim、初回 claim、watchdog が検知した90秒超の停止は worker の `open_hold_since` を開始する。途絶後の claim は既存の保留があっても開始時刻をその claim 時刻へ数え直し、途絶前に終わった予約読取では解除しない。
- 保留開始時は、その worker が担当する予約読取の `next_due_at` を現在へ前倒しする（他の dispatcher が lock 中の行は飛ばす）。
- 保留の解除条件は、その worker の live かつ未隔離 account に属する、予約読取可能な全 listing が `open_hold_since` 以後に開始した読取を完了していること。判定は claim ごとに行う。
- provider に live な Studio（未失効 credential と assignment、active account）が1台でも保留中、heartbeat 未受信、または90秒超なら、その provider の新規 `SET_OPEN` は claim されず `QUEUED` のまま残る。attempt と deadline は消費しない。CLOSE、OBSERVE、予約読取は保留しない。claim 後 preflight までの数秒間の変化は再判定しない。
- Host の read model は、この保留中に未反映の desired OPEN を `HELD`、fresh な Studio が1台もない provider の未反映 CLOSE を `ERROR`（`WORKER_STALE`）とする。閉じる書込み手段がない状態を「反映待ち」と表示しない。
- NIHO直販の停止は既存の予約読取 freshness（[OTA外部予約台帳](ota-external-reservations.md)）に従う。heartbeat 途絶だけで直販を即時停止する処理は追加していない。

**Studio が止まった時に、既に外部で受付中の回が自動で閉じる保証はない。** Studio が応答なし・停止・未接続の間、Admin の稼働状況はこれと閉じられていない回の件数を明記し、「停止済み」とは表示しない。

### クラウド watchdog

`POST /internal/ota/v1/watchdog` は Cloud Scheduler（例: 1分間隔）から呼ぶ独立 job の入口である。

- 認証は Google 発行の OIDC ID token だけ。`EXPERIENCE_CHANNEL_WATCHDOG_AUDIENCE` と完全一致する audience、`EXPERIENCE_CHANNEL_WATCHDOG_SERVICE_ACCOUNT_EMAIL` と一致する verified email、Google issuer、未失効を必須とする。worker bearer、Admin cookie、session role は参照しない。guide admin と同じ検証部品（`apps/web/src/lib/google-service-identity.ts`）を使う。
- flag OFF・設定不足は `404`、token 不備は `401`、Google 署名鍵の取得障害は `503 identity_verification_unavailable`、DB 未設定・失敗は `503`。body は空か `{}`（1 KiB 以下）、query なしだけを受ける。応答は件数だけで `private, no-store`。
- 同時実行は transaction advisory lock の try-lock で1本にし、取れなかった実行は待たずに `skipped:true` を返す。同じ条件の incident は `dedupe_key` の部分 unique index で未解決1件に限る。
- watchdog が変更するのは incident、`channel_watchdog_state`、90秒超の worker の `open_hold_since` 開始、外部予約の要対応 case の自動解決と反映時間の計測（[OTA外部予約台帳](ota-external-reservations.md#要対応キューと反映時間の計測)）だけである。job、lease、quarantine、desired state、予約は変更しない。

| incident | 開く条件 | escalation |
| --- | --- | --- |
| `WORKER_STALE` | live な worker の heartbeat（未受信なら最初の assignment）が90秒超 | 停止60分超 |
| `SYNC_OVERDUE` | 配備済み action で実行可能な未反映 desired が、desired 変更から60分超（account 単位） | 開いた時点 |
| `RESERVATION_READ_OVERDUE` | 予約読取可能な listing の読取が halted、fresh 期限切れ、または作成後60分未読 | 開いてから60分超 |
| `ACCOUNT_QUARANTINED` | active account の隔離 | 隔離60分超 |
| `EXTERNAL_RESERVATION_CONFLICT` | 外部予約の要対応 case が OPEN（subject は case） | 開いた時点 |

未反映の判定は `desired_changed_at`（desired version を変えた時刻）を基準にし、観測・エラー記録で動く `updated_at` は使わない。退役 adapter など配備 allowlist で実行できない backlog は `SYNC_OVERDUE` にしない。incident は条件が消えた次の実行で `AUTO_RECOVERED` として閉じる。各種上限（500行）に達した種別は、その実行で自動解決しない。

detail は件数・経過秒・内部理由コードだけで、外部 account ID、旅行者情報、token を含めない。開始・escalation・解決ごとに `notified_*_at` を記録し、`ota_runtime_incident` の構造化ログを1行出す。通知はこのログを Cloud Logging の log-based alert で拾う。Admin は最終実行が5分より古い watchdog を「監視が止まっています」と表示する。

### 配備済みの監視資源（2026-10-31、オーナー指示）

stg（`niho-app-stg`）と本番（`niho-app-prd`）に同じ名前で用意した。通知先はオーナー指定の takahama.t@niho.life。

| 資源 | 内容 |
| --- | --- |
| サービスアカウント `experience-ota-watchdog@<project>.iam.gserviceaccount.com` | Scheduler の OIDC ID token 専用。ロールは持たない。stg の非公開 Cloud Run にだけ `roles/run.invoker` を付けた |
| Cloud Scheduler `experience-ota-watchdog`（asia-northeast1） | 毎分 `POST /internal/ota/v1/watchdog`、body `{}`、再試行なし。audience はサービスのベース URL（stg は固定 run.app URL、本番は `https://experience.niho.life`）。flag と DB が揃うまで **一時停止** |
| alert policy `experience-ota-runtime-incident` | `jsonPayload.event="ota_runtime_incident"` のログごとに通知（5分の rate limit）。件名に kind と transition |
| alert policy `experience-ota-watchdog-scheduler-failed` | watchdog job の実行失敗（1時間の rate limit） |

Cloud Run 側の値は配備 workflow だけが入れる。stg は repository variable `STG_CHANNEL_WATCHDOG_ENABLED=true`、本番は `PROD_CHANNEL_WATCHDOG_ENABLED=true` かつ `enable_host_calendar=true`（watchdog は体験 DB を使うため）のときだけ、`EXPERIENCE_CHANNEL_WATCHDOG_ENABLED/AUDIENCE/SERVICE_ACCOUNT_EMAIL` を付けて検査する。有効化の順序は、DB migration と runtime 権限 → 変数を true にして候補配備・昇格 → Scheduler を `gcloud scheduler jobs resume` → Admin の「監視」表示とアラートの受信を確認。止めるときは Scheduler を pause してから変数を戻す。本番では既存の `ops-critical-scheduler-http-failures` も全 job の HTTP 失敗を拾うため、未配備のまま resume しない。

### Admin の稼働状況と手動復旧

`/admin/channels` は選択中の提供者について、表示中だけ30秒間隔で `runtimeOverview` を読む。DTO は allowlist で組み立て、worker credential、private profile、外部 account ID、担当者の user ID を返さない。表示は Studio の状態（稼働中／応答なし／停止／未接続）と保留、閉じられていない回の件数、account ごとの未反映件数と予約読取、未解決 incident と担当である。

操作はすべて UUID v4 command で冪等化し、`channel_admin_commands` に監査記録する。同じ command を別の Admin が再送すると `409`。

- `pauseAccount`（停止して手動対応）: `expectedVersion` 必須。account を `MANUAL_HANDLING` で隔離する。スタッフが外部 profile を操作している間なので、OBSERVE を含む全 job を claim せず、手動対応前に貸し出された OBSERVE の確認でも隔離を解かない。lease 切れ・遅れて届いた結果などの自動の隔離は理由を `MANUAL_HANDLING` のまま残し、理由を書き換えられるのは停止と復旧の Admin 操作だけ。既存 lease は通常の停止確認付き復旧まで保持し、復帰は「停止を確認して照合」から行う。
- `recover`（停止を確認して照合）: 既存の observe-first 復旧。手動対応中で一度も実行していない account は、いちばん新しい待機中の job の listing・回から復旧用の OBSERVE を作り、その job は外部に触れていないので `SUPERSEDED` で閉じる。
- `confirmReauth`（再認証を確認して照合）: Studio 停止と掲載先への再ログインの両方の確認を必須とし、`AUTH_REQUIRED` の隔離だけを受ける。処理は `recover` と同じ observe-first で、`account.reauth` として別に監査する。password・cookie・session の入力欄は置かない。
- `retryReservationReads`（予約照合を再開）: halted かつ実行中 job のない listing だけ。account が active・未失効・委任期限内・未隔離で、listing が予約読取可能な場合に限り、停止を解いて即時 due にする。読取の健全性は更新しない。
- `acknowledgeIncident`（担当する）: 未解決 incident の担当を自分にする。incident を手動で閉じる操作は置かない。

### Viator の一時アクセス制限 hold

Viator の robot 確認、一時アクセス制限、または対象 document / availability 通信の 403・429 を検知した場合、driver は許可済み write guard を即時 freeze し、その専用 private profile に `.niho-access-hold.json` を永続化する。hold は version、有限の理由コード、検知日時だけを持ち、URL、本文、cookie、資格情報は保存しない。同じ profile の deterministic worker、手動 helper、別 process は session policy が `none` / `prepare` / `restore` のいずれでも Chrome 起動前に拒否される。別 profile には波及しない。壊れた hold や読取不能も fail closed とする。holdの保存待ちは2秒で打ち切り、書込みやfsyncが完了しなくても所有Chromeを止め、既存workerの停止journal・Cloudへの結果報告へ進む。遅れて保存が完了しても隔離は解除しない。

復旧は次の順序を崩さない。

1. 制限検知後は job を停止し、既に送信した write の独立 readback がない場合は `UNKNOWN_AFTER_SAVE` を維持する。制限を認証切れへ読み替えない。
2. worker の `stopped=true` と、worker が所有する Chrome process の停止を確認する。外部で受付中の回が自動で閉じたとは扱わない。
3. CAPTCHA 回答、自動 solver、stealth、UA / IP 変更などの回避を行わず、運用者が手動で Viator 側の確認とサイト側制限の解除を確認する。現在保留中の実Viator実証をこの手順だけで再開しない。
4. exact profile の hold は TTL や自動解除を持たない。上記確認後に運用者が明示的に hold を解除し、Admin の既存 `recover` から observe-first の独立照合を行う。Viator の session restore は有効化せず、既存受入済みの restore は Jalan だけとする。

この手順はログインの無期限維持、制限原因、または再発ゼロを保証しない。原因を JavaScript や操作速度だけと断定しない。

検証は合成データの実DB結合テスト、route・UI の単体テスト、stub した Admin 画面の E2E までである。Cloud Scheduler・通知の資源は用意したが一時停止中で、実Studio・実OTAでの停止／復旧の受入は未実施である。#240 はコードのマージだけでは close しない。

## 現時点の検証範囲

StudioではChrome 156 + Node 24のdeterministic browser driverでsynthetic 24 cases（通常20、stale、応答喪失、認証期限、誤product拒否）を確認し、model invocationは0回だった。実GetYourGuideはlocal UIの2往復に加え、Studioの専用profileでも5往復（停止・再読込・再開・再読込、計10書込み）に成功し、元の受付可能な状態へ復元した。指定以外の書込みは遮断した。実ID・ログイン情報・画面証跡は公開リポへ保存しない。

実DBの対象検証は9件、Webの境界検証は12件が合格した。認可の解除・再付与、再開直後の古いCLOSE、2,016 occurrenceの2ページ展開、期限後の停止確認、未対応adapterが先頭56件を占める場合、mapping変更直後の未確認表示も含む。独立read-onlyレビュー3件とGitHubレビュー3件のfindingを修正し、対応する実DB回帰テストで確認した。

これらはClaude end-to-endまたはP0完了の証跡ではない。Claude/Maxはweekly limit中（2026-11-03 13:00 JST reset）であり、有料API fallbackは使用しない。worker adapter統合と本番有効化は後続sliceである。

### 管理UIの受入境界（#235）

`/admin/channels` は専用Admin認証と `EXPERIENCE_CHANNEL_MANAGER_ENABLED=true` が必要。提供者ごとに外部アカウント・掲載設定・共有資源を扱い、担当者の招待は既存の `/admin/operators` を使う。価格は販路別に管理し、この画面では同期しない。開催回の人数上限はカレンダーで設定する。

`EXPERIENCE_CHANNEL_WORKSPACE_PREVIEW_ENABLED=true` はmockモードかつ合成AdminのUI検証専用。合成提供者だけを表示し、実APIの認可・DB保存・workerを有効にしない。E2Eはブラウザ応答をstubする。HTTPではこのpreview flagを無視する。

Adminの資源設定も既存のprovider inventory mutex・版・immutable command・calendar outboxを使う。商品への資源割当や予約単位は、未終了の確定予約/HOLDがあると変更を拒否する。資源自体の休止は既存どおり今後の空きを止め、既存予約を取り消さない。
