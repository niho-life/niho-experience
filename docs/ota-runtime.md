# OTA channel runtime

対象: #194、#196、#198。外部掲載先の account/listing 対応表と、Studio executor が利用する耐久 job 契約を定義する。この slice は基盤のみであり、product operator の招待・権限、resources/groups、外部予約取込、Google 予定変更、管理 UI は実装しない。本番の自動実行、scheduler、launchd、外部サイト接続も有効化しない。

## 既定で閉じるゲート

- Admin API は `apiMode=http` かつ `EXPERIENCE_CHANNEL_MANAGER_ENABLED=true` の場合だけ開く。NIHO がその時点で検証した Admin HTTP session が必要で、mock/preview cookie は利用できない。
- worker API は別の `EXPERIENCE_CHANNEL_RUNTIME_ENABLED=true` が必要である。人間用 cookie は認可に使わず、worker bearer を `Authorization` header だけで受け取る。
- DB 未設定は `503` とし、HTTP 失敗から mock へ切り替えない。両 flag の既定値は false である。
- capability は account/listing 作成だけでは有効にならない。配備設定 `EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS` に明示された `site/adapter@version` の boolean だけを Admin が保存でき、claim/preflight/result でも同じ配備 allowlist を再確認する。未設定・不正設定は全 capability false となり、live job は claim されない。
- groups/resources による共有在庫の安全確認が未実装なので、現時点では配備 flag を有効にしない。

`EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS` は秘密ではない JSON で、例は `{"Airbnb/browser-v1@1":{"canObserve":true,"canClose":true}}`。これは実装・受入済み capability の allowlist であり、サイト名だけから対応済みとは判断しない。

## Registry と権限境界

external account は provider scope に属し、site、外部 account ID、表示名、運用モデル 1〜4、委任期限・失効、version を持つ。active の既定値は false。運用モデル 2 を記録できるが、credential 共有や cookie 受け渡しは実装しない。private profile は Secret Manager 等の opaque reference だけを保存し、read DTO に値も参照も返さない。
同一の実 account を複数 provider の別 account として扱わないため、`site + external account ID` は全体で一意にする。provider をまたぐ将来の集約は、同じIDの複製ではなく別途権限設計が必要である。

listing は provider 所有 product と同じ provider の account だけを結ぶ。外部 product/option、Asia/Tokyo、adapter/version、connection mode と個別 capability を持ち、active と capability の既定値は false。同じ product を複数 site/account へ結べるが、同じ account の外部 product/option は重複できない。更新は `expectedVersion` 必須で、Admin mutation は UUID v4 command と fingerprint で冪等化する。actor user ID は、HTTP 境界が fresh Admin 検証から作った `ChannelAdminActor` だけを受け入れる。

account の委任・失効・active・profile 変更、listing の target/capability/active 変更は version を上げ、QUEUED job を `SUPERSEDED` にする。LEASED job の immutable target は書き換えず、preflight/result で current version と不一致になる。古い job を新しい target へ転送しない。

worker credential の初回 mint と account assignment 作成は `expectedVersion: null`、rotation・再 assignment と revoke は現在の正の version を必須とする。raw credential を再表示する idempotent replay は行わず、同じ mint command の再送は conflict とする。

listing を active にしただけでは外部操作を作らない。Admin の deterministic `reconcile`、または `calendar_outbox_events` consumer が現在の schedule から desired state を再構築する。
active mapping の開催時刻変更は、旧外部枠を確実に閉じてから新 target へ移す P2 の手順が未実装である。この slice は古い時刻の preflight/result を拒否して quarantine するだけで、外部 reschedule を対応済みとはしない。従って runtime flag は引き続き無効にする。

## Desired state と calendar outbox

対象期間は Tokyo local date の当日を含む 56 日、1 dispatch 最大 2,000 occurrence。outbox row は transaction 内で `FOR UPDATE SKIP LOCKED` する。対象期間と listing/rule/occurrence の続き位置を保存し、上限に達したページも desired/job と同時にcommitする。全ページ完了時だけ `processed_at` を付けるため、36 listing × 56日を超えても同じ先頭ページを永久にrollbackしない。重複 outbox/reconcile は、listing + canonical occurrence の同じ desired/mapping version と job unique key により重複操作を作らない。連続編集では未 lease の旧 job を coalesce して `SUPERSEDED` にする。
worker の claim は、認証済みworkerに割り当てられたaccountのproviderだけを対象に、bounded outbox dispatch を同期完了してからjobを選ぶ。listing単位のtransaction advisory lockにより、同時dispatchとAdmin reconcileを直列化する。

desired は schedule rule、reschedule override、直交した sales state を `expandOccurrences` で展開し、`evaluateAvailability` で決める。CONFIRMED と有効な HOLD の席、booking cutoff、Google blocking の freshness/coverage/busy を毎回参照する。Google が stale、coverage 外、または failed の時に OPEN を作らない。manual Block は schedule の `CLOSED` であり、外部 observed state と別の列・表示で扱う。

## Lease と executor 契約

- credential は random 32 bytes 以上の bearer を mint 時に一度だけ返し、DB には SHA-256 digest、期限、失効だけを保存する。GET、job target、URL、log 用 DTO には含めない。
- worker は明示 assignment のある account だけを claim できる。claim時のassignment versionをleaseへ固定し、renew/preflight/resultで一致を確認する。失効後に同じworkerへ再付与しても、古いleaseは復活しない。browser claim は全体 concurrency 1、account exclusivity 1。transaction advisory lock、row lock、partial unique index を併用する。
- lease は 120 秒、job deadline は初回claimから 180 秒で、retryしても延長しない。executor は30秒以内の間隔でrenewし、serverは最後の更新から60秒を越えたrenewを成功させない。CLOSED は OPEN より優先する。
- expired lease は lock を解放しない。account を quarantine し、古い job は `LEASED` のまま残す。認証済み executor が `stopped=true` を返すか、Admin が executor 停止を明示確認した recovery だけが lock を解放できる。
- manual recovery は supported `OBSERVE` capability を必須とし、まず OBSERVE job を作る。exact target の fresh readback が VERIFIED になるまで quarantine を解除せず、OPEN を再作成しない。

worker endpoints は次の versioned route だけで、すべて `POST`、JSON 16 KiB 以下、`private, no-store` である。

- `/internal/ota/v1/claim`
- `/internal/ota/v1/jobs/{id}/renew`
- `/internal/ota/v1/jobs/{id}/preflight`
- `/internal/ota/v1/jobs/{id}/result`

claim に対象がなければ body なし `204`。認証不備は `401/403`、version/lease/preflight の stale は `409`。lease token は worker envelope の直下にだけ置き、target model へ入れない。

## Preflight と結果

preflight は worker、assignment、lease/deadline、account active/delegation/revocation/version、listing active/capability/mapping version、商品公開状態、desired version、配備adapterをtransaction内で確認する。全actionで現在のoccurrence開始・終了がimmutable job snapshotと一致することを確認する。`SET_OPEN`と`SET_CLOSED`は予約席、cutoff、Google freshness/coverage/busy、現在のsales stateを再計算し、現在の販売可否とactionが一致するときだけ実行する。再開直後でoutboxが未消費の場合にも古いCLOSEを成功扱いしない。古い操作は`409`で止め、lease lockを停止確認まで保持する。authorityや時刻が失効した場合はaccountもquarantineする。`ENSURE`やmodel proseによる成功判定はない。

結果は `VERIFIED`、`AUTH_REQUIRED`、`NEEDS_REVIEW`、`UNKNOWN_AFTER_SAVE`、`RETRY_WAIT`、`SUPERSEDED`。VERIFIED は immutable target、occurrence ID、source開始・終了の完全一致、current authorityとlive availability、lease/deadline内、`stopped=true`、実行window内のreadback時刻が揃った場合だけcurrent observed/synced stateを更新する。readbackは外部のmanual block状態と実際のbookable booleanを別フィールドで返す。`SET_CLOSED`はmanual block済みかつbookable=false、`SET_OPEN`はmanual blockなし、かつbookable=trueを必須にする。例えばmanual block=falseでもcutoffによりbookable=falseならOPEN成功ではない。結果UUIDはworker・job・lease epoch/digest・payloadへ結び、同じreceiptの再送だけを冪等に受ける。古い結果は監査保存できるがgreenにしない。`AUTH_REQUIRED`と`UNKNOWN_AFTER_SAVE`は書込みを盲目的にretryせずquarantineする。`RETRY_WAIT`だけを最大5 attempts、初回deadline内のbounded backoffで再試行できる。

## 公開する read model

Admin の `/admin/api/channels` は action allowlist だけを受け、任意 query を中継しない。Host の `/host/calendar/channels?providerId=...` は `hostActor` と現在の experience membership を両方確認し、occurrence/site ごとの desired、observed、label、last verified、coarse error だけを返す。外部 account ID、worker、credential、private profile は返さず、product operator scope へ拡張しない。

## 現時点の検証範囲

StudioではChrome 156 + Node 24のdeterministic browser driverでsynthetic 24 cases（通常20、stale、応答喪失、認証期限、誤product拒否）を確認し、model invocationは0回だった。実GetYourGuideはlocal UIの2往復に加え、Studioの専用profileでも5往復（停止・再読込・再開・再読込、計10書込み）に成功し、元の受付可能な状態へ復元した。指定以外の書込みは遮断した。実ID・ログイン情報・画面証跡は公開リポへ保存しない。

実DBの対象検証は9件、Webの境界検証は12件が合格した。認可の解除・再付与、再開直後の古いCLOSE、2,016 occurrenceの2ページ展開も含む。独立read-onlyレビューの3 findingを修正し、対応する実DB回帰テストで確認した。

これらはClaude end-to-endまたはP0完了の証跡ではない。Claude/Maxはweekly limit中（2026-11-03 13:00 JST reset）であり、有料API fallbackは使用しない。worker adapter統合と本番有効化は後続sliceである。
