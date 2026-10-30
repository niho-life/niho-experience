# Google専用予定writerのHTTP protocol

更新日：2026-10-31。Issue #270 で HTTP 境界に加え、既存 `ChannelRuntime` の job/lease/preflight を正本とする専用binding、永続配送journal、server executor、内部配送API、GET-only再照合を実装した。Issue #273 で OTA worker からこの内部配送APIだけを呼ぶ caller を接続した。Issue #275 で OWNER 本人が専用calendarを1個作成し、inactive bindingとして保存するdefault-off backendを追加した。Issue #278 でそのinactive calendarへ決定的な初期anchorを最大1回insertし、結果不明時をGET-onlyで照合するdefault-off backendを追加した。PR #291 と Issue #302 で同一lease内のGoogle/Airbnb typed receiptとその現在権威検証を追加し、Issue #306 で後続leaseが現在intentをGET-onlyで再証明するserver operation `observe` を追加した。Airbnbの読取り専用observerはPR #301で別途実装・単体実サイト検証済みである。Issue #307 では typed receipt が確認した既知の伝播不一致を最大60分GET-onlyで追うbackend待機状態とclaim連携を追加した。Googleへの本番実接続、#307 DTOを使うworker caller、本番有効化は未完了である。

公式根拠：

- [Events: insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
- [Events: patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)
- [リソースの条件付き変更](https://developers.google.com/workspace/calendar/api/guides/version-resources)

## 境界

`@niho-experience/google-calendar` の `applyGoogleManagedBlock` は、サーバーが渡す専用出力calendarとaccess tokenを使い、NIHO所有の単一eventを制御する。ブラウザ入力、Google accountのemail、顧客情報、料金、招待先は受け取らない。既存scopeは広げず、tokenを結果へ返さない。

targetはprovider・listing・occurrenceのopaque ID、mapping version、単調なdesired version、24時間以内のcanonical UTC半開区間、`OPEN | CLOSED`だけを持つ。event IDは3つのopaque IDから決定的に作り、mapping version、desired version、OPEN/CLOSEDでは変化しない。private extended propertiesには固定kind、対象・時刻・mapping versionのbinding hash、mapping version、desired versionだけを保存する。件名は固定短文で、eventはprivateとする。

`CLOSED`は`opaque`、`OPEN`は`transparent`である。OPEN時にeventを削除・再作成せず、同じanchorを条件付きPATCHする。targetの時刻はミリ秒3桁と`Z`を持つcanonical UTCに限定する一方、Google responseのRFC3339 `dateTime`は`Z`または妥当なnumeric offsetをUTCへ正規化して比較する。timezoneなし、日付だけ、不正offsetは拒否する。Googleの既定transparency欠落は`opaque`として読めるが、終日event、時刻違い、missing/foreign marker、mapping違い、cancelled event、tombstone、privateでないevent、現在intentより新しいdesired versionは変更しない。

既存NIHO anchorの正常statusは`confirmed`であるため、status欠落・未知値・`tentative`は安全側に停止する。`tentative`を受付制御へ採用する要件はなく、意味を推測してconfirmed相当にはしない。GETの部分応答には`start.date` / `end.date`も含め、終日eventである証拠を欠落させない。

繰り返し予定の親・個別instanceも`RECURRING_EVENT`で停止する。初回の時刻と所有markerだけではシリーズ全体への変更を防げないため、部分応答で`recurrence`・`recurringEventId`・`originalStartTime`を取得して確認する。変更後の読戻しで繰り返しに変わっていた場合は`WRITE_UNCERTAIN`とし、Google検証済みにはしない。[Googleの繰り返し予定](https://developers.google.com/workspace/calendar/api/guides/recurringevents)

## リクエスト順序と競合

1. server実装の必須`assertCurrent`で、現在target・version・leaseを確認する。
2. 固定Google API originの対象calendar/eventだけをGETする。部分応答はID、ETag、status、start/end dateTime、transparency、visibility、private markerに限定する。返却DTOにもこの制御metadata以外を残さない。
3. 同じdesired version・状態ならwriteせず、最後の`assertCurrent`後に`GOOGLE_VERIFIED`を返す。
4. writeが必要なら直前にもう一度`assertCurrent`する。既存eventはGETしたETagを`If-Match`へ付け、transparencyとprivate markerだけをPATCHする。CLOSEDかつGET 404の場合だけ、決定的ID、private、opaqueのeventをinsertする。どちらも`sendUpdates=none`であり、1呼出しのbusiness writeは最大1回である。
5. 2xx ACKだけでは成功にしない。別のGETで所有、時刻、mapping/desired version、transparency、新しいETagを確認し、最後の`assertCurrent`後にだけ`GOOGLE_VERIFIED`を返す。

insertの409は成功扱いせず、追加writeなしのfresh GETで完全一致した場合だけGoogle検証済みにする。insertが拒否された409 collisionのfresh GETは、foreign eventなどの初回停止理由を保持できる。PATCHの412は`PRECONDITION_FAILED`で停止し、自動再適用しない。500、timeout、body読取失敗、ACK喪失後も盲目的に再writeせず、fresh GET 1回で適用済みと確認できなければ`WRITE_UNCERTAIN`とする。2xx write後のfresh eventがforeign、mapping違い、時刻違いの場合も、変更なしを示す`changed=false`にはせず、`changed=null`と保存済みACK有無を持つ`WRITE_UNCERTAIN`にする。変更前と同じETag、古いdesired marker、404/410も成功にしない。

HTTPはredirectを追わず、request deadline、応答byte数、JSON depth/node数、ETagと入力文字列長を制限する。条件付きPATCHには引用符を持つstrong ETagだけを使い、wildcardやweak ETagを拒否する。calendar/event IDは固定originのpath componentとしてencodeする。Googleのerror bodyやraw eventは結果・例外へ含めない。

合成testは、すでにabortしたbody streamと、上限超過後も終了しないbodyのcancelを確認している。さらにlocalhostのzero-byte ACK bodyで実時間のdeadlineも確認するが、socket listenを禁止するsandboxではその1件だけ実行できない。request signalはbody読取にも効くfetch境界へ渡す。

## typed result

- `GOOGLE_VERIFIED`: Google側の選別済みmetadata、`changed`、write ACK有無を返す。Googleだけの検証結果である。
- `ANCHOR_MISSING`: OPEN対象のeventが404。受付再開やAirbnb反映の成功ではない。
- `TOMBSTONE` / `CANCELLED_EVENT` / `STATUS_MISMATCH` / `ALL_DAY_EVENT` / `FOREIGN_EVENT` / `MAPPING_MISMATCH` / `TIME_MISMATCH` / `VISIBILITY_MISMATCH` / `STALE_INTENT`: write前に安全に変更できないため停止した結果。
- `PRECONDITION_FAILED`: ETag競合。新しいintentを読み直すserver処理が必要である。
- `WRITE_UNCERTAIN`: writeが届いた可能性はあるが独立GETで確定できない。追加writeではなく配送journal側で隔離・再判断する。

このunionにAirbnbの`SYNCED`や既存browser adapter用の`manualBlocked=true`はない。Google ACKや`GOOGLE_VERIFIED`だけで旅行者へ受付停止・再開の反映済み表示を出してはならない。

配送APIは `AVAILABILITY`、`Airbnb`、`GOOGLE`、`airbnb-google-busy@1` の既存leaseだけを受ける。provider/listing/occurrence/mapping/desired/UTC区間と出力calendarはrequestから受けず、server DBから導出する。dispatch前のjournalにはaccount version、binding version、connection generation、calendar IDとgrant scope集合のdigest、worker/lease/assignment、operation nonceを不変snapshotとして保存する。callbackと結果保存は同じsnapshotとoperation nonceを現在値へ照合し、認可取得失敗・別worker/job・古いHTTP応答・後続reconciliationがある場合は更新しない。

同じprovider/listing/occurrenceに `DISPATCHING` / `UNCERTAIN` が一つでも残る間は、desired・mapping・jobが別でも新しいwriteを開始しない。同じintentの既存結果もbinding identityが完全一致する場合だけ再利用する。出力calendarはproviderをまたいで一つのlistingに限定し、全providerのprovider busy・resource busy・booking calendarとの共用を入力側と出力側の両方で拒否する。

`reconcile` は通常のSET leaseでは実行できない。明示的なstop確認で元jobが `NEEDS_REVIEW` 終了し、同じaccount/listing/occurrence・mapping・時刻・bindingの新しい `OBSERVE` leaseがfull preflightを通った場合だけ、journalに保存した過去targetを現在authority contextから分離してGETする。旧desiredを再送せず、元dispatchが生存中の並行reconcileも許可しない。mapping・時刻・binding・owner/assignmentが変わった場合は自動回復せず手動確認に止める。GET一致は過去Google intentの証拠だけで、現在desiredやAirbnbを成功に更新しない。
再照合の設定不足・scope不足・token更新失敗では、元の書込み結果が不明な記録を `UNCERTAIN` に保つ。Googleを読めていない段階では未確認のfenceを解除せず、障害復旧後のGET-only再試行を残す。
内部endpointはHTTP mode、既存channel runtime flag、`EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED=true` の3条件が揃うまで404であり、新flagは既定falseである。

OTA worker caller も `googleDeliveryEnabled` が既定falseである。ON時だけ固定originの内部配送APIへ `dispatch` または `reconcile` を1回送り、Googleへ直接接続せず、browser・Claude・任意adapterへfallbackしない。callerのdeadlineはjob期限内かつ最大60秒で、送信開始後に確定DTOを受け取れない場合は再送せず `UNKNOWN_AFTER_SAVE` として隔離する。`GOOGLE_VERIFIED` はGoogle予定だけの確認であり、Airbnb observerが未接続のため worker結果は `NEEDS_REVIEW` / `AIRBNB_OBSERVATION_REQUIRED` のままとする。

serverのtyped result受付は `EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED=true` に加え、HTTP modeと既存delivery flagがONの場合だけ開く（既定false）。同じ現在job・worker・lease・assignmentで直前に `GOOGLE_VERIFIED` になった `DISPATCH` または `OBSERVE` をUUIDで指定し、別系統のAirbnb観測が同じcanonical UTC枠を1名で予約可能／不可能と確認した場合だけ、`EXACT_SLOT_V1` receiptを既存result receiptへ保存できる。Google metadata、binding、connection generation、3 scopeのdigest、現OWNER、desired/live inventory、入力calendar非衝突、未解決delivery不在、Google検証時刻から観測時刻までを同一transactionで再確認する。calendar ID、scope、token、raw responseはworker入力やresult receiptへ保存しない。

`DISPATCH` receiptは従来どおりoriginal job・worker・lease・assignmentが現在leaseと完全一致するときだけ使える。後続leaseでは、journalの`updated_at`や過去のGoogle成功だけでは証明にならない。`observe` は現在の `AVAILABILITY` leaseが `SET_OPEN` / `SET_CLOSED`、または将来の同一intent `OBSERVE` の場合だけ使え、current occurrence、desired state/version、mapping、UTC区間、live shared inventory、予約reader health、canObserve、account/assignment、OWNER、scope、grant generation、binding digestを再確認する。現在SET jobの短い再leaseは、旧leaseがimmutable resultで`stopped=true`を保存済みの場合に限る。手動recoveryはdesired versionを増やす既存仕様のままで、古いintentのjournalを再利用する近道にはならない。

`observe` は毎回新しいoperation nonce/epochを発行し、Google I/O前に`operation_verified_at`をNULLへ戻してから、`inspectGoogleManagedBlock`のGETだけを行う。404・metadata不一致は`NOT_MATCHED`、token・設定・読取失敗は`STOPPED`であり、insert/PATCH/deleteへfallbackしない。成功時だけserver clockで`operation_verified_at`を記録し、最初の成功時刻`first_verified_at`は`COALESCE`で保持する。typed receiptは`operation_verified_at >= current lease_started_at`かつAirbnbの`observed_at`以下を要求するため、準備時の`updated_at`更新や過去leaseの証拠は通らない。同じcurrent leaseでの明示retryも新nonceで再GETし、遅れて戻った旧GETは保存できない。

同じleaseのDISPATCHが検証済みの場合も、追加writeなしでGET再確認できる。現在intentの確認はquarantineのないaccountだけを対象とし、手動停止中はGoogle読取りとtyped receiptの両方を止める。通常の手動復旧・過去intentのreconcileによる認可境界は保つ。

`RECONCILE`は結果不明writeのhistorical journalを読む手動回復経路であり、`STORED_JOURNAL_ONLY`の過去事実に留まる。`RECONCILE`だけの`GOOGLE_VERIFIED`はtyped receiptへ直接使えず、現在intentの成功には新しい`observe` GETが必要である。このleafでは保守的に、最後のoperationが`RECONCILE`のjournalをobserve seedとして再利用しない。

## GoogleからAirbnbへの伝播待機（Issue #307 backend）

`google_airbnb_propagation_waits` は `google_channel_deliveries.id` ごとに1行だけ持つ。予約起点の他掲載先反映時間を測る `channel_propagation_measurements` / `channel_propagation_targets` とは目的もidentityも別であり、desired stateや在庫の新しい正本にはしない。保存するのはprovider/account/listing/occurrence、desired・mapping・account version、canonical UTC区間、target、binding・connection・scopeのdigest、固定worker assignment、最初のGoogle検証時刻、期限、次回時刻、pending job、状態と短いreasonだけである。credential、calendar ID、Google/Airbnb raw response、顧客情報は保存しない。

既存の `RETRY_WAIT` に3 field固定の `googleAirbnbProof` があり、同じlease内のfresh Google operationと、1名のAirbnb観測が現在desiredのちょうど反対を示す場合だけ、既知の伝播不一致として受け付ける。`VERIFIED` は従来どおりdesired一致だけである。proofのないretry、時刻・枠・target違い、matching stateの`RETRY_WAIT`、`stopped=false`、期限後、flag OFF、古いversion、quarantine、OWNER・scope・binding・connection・assignment・live inventoryの不一致、入力calendar衝突、未解決writeは `WAITING` にしない。immutable result ID replayの挙動は変えない。

最初の不一致では元jobを `FINISHED/RETRY_WAIT` としてleaseを解放し、accountをquarantineせず、現在desiredの `last_error` を `GOOGLE_PROPAGATION_PENDING` にする（旧日時停止warningがあれば保持する）。期限は `google_channel_deliveries.first_verified_at + 60分` で固定し、再観測でも延長しない。次回は `min(DB now + 5分, deadline)` とする。期限境界では新jobを発行せず `NEEDS_REVIEW` とし、現在desiredだけに短いreview errorを残す。

due処理は認証済みworkerの固定assignment内だけを有限件走査し、provider inventory mutexの後にjob/waitをlockする。毎回、current occurrence、shared live availability、desired/mapping/account/target、非quarantine、現OWNER、3 scope、binding version、connection generation、calendar digest、自己入力非衝突、未解決writeなしを再確認する。変化があれば発行前に `SUPERSEDED` または `NEEDS_REVIEW` へ止める。発行するのは最大3分かつ伝播期限内の新しい `AVAILABILITY/OBSERVE` jobで、`google_propagation_delivery_id` を持つ。同じwaitのlive jobは1件だけであり、通常AVAILABILITYの一意identityからは除外する。claim DTOに追加するのは検証済みmarker jobの `googleDeliveryOperation: "observe"` だけで、delivery IDは渡さない。

marker jobのpreflight、Google GET前後の既存repository fence、result保存はすべてwaitの `CHECKING/pending_job_id` と現在権威を再確認する。Google側は `prepareObservation` / `inspectGoogleManagedBlock` のGETだけを使い、伝播再確認からinsert/PATCH/deleteを行わない。再び反対状態なら元の `first_verified_at` / deadlineを保って `WAITING` に戻し、一致したtyped `VERIFIED` だけを `MATCHED` として既存desired観測更新へ通す。通常失敗、認可失敗、stop喪失はlinked waitをreviewへ止め、自動account回復や `completeRecoveryObserve` を呼ばない。queued期限切れは安全に終了するが、leased jobはstop-confirmed resultなしに強制解放せず、既存watchdog/quarantine規則を維持する。

このbackendは既存 `googleAirbnbObservationEnabled` がtrueのruntimeでだけdue jobを作り、既定OFFを変えない。OTA worker側のclaim parserと `googleDeliveryOperation` caller接続、実Google/Airbnb・実credentialによる受入、flag有効化、activation、UIは後続範囲である。

この受付は日単位のunavailable表示、枠欠落、従来のboolean-only Google結果を成功にしない。独立observerを使うworker caller、wait queue・scheduler・job作成、60分pending表示、UI、flag有効化は含まない。既存flagは既定OFFのままであり、次段ではcallerとlive scopeでSET再lease／将来OBSERVEを実際に起動して受入する。

## 未接続・未受入

### Issue #275 のsetup backend

`/host/calendar/google-output` のGET/POSTはHTTP mode、host console、`EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED=true`、fresh NIHO session、Experience OWNER、同じNIHO userが作成した現行Google接続をすべて満たす場合だけ開く。入力はprovider/listing、期待mapping version、UUIDv4 commandだけで、calendar ID、名称、token、actorは受けない。商品がDRAFTでも現在のAirbnb/GOOGLE/`airbnb-google-busy@1` listingとaccountが有効なら準備できるが、配送は開始しない。

serverは商品名から200文字以内のplainな名称を作り、既存scope `calendar.app.created` による固定 `POST /calendar/v3/calendars` で`Asia/Tokyo`のsecondary calendarを作る。booking calendar作成helperとは分離し、名前検索や既存calendarの採用・置換は行わない。作成前に`PREPARING`、Google POST直前に`CREATING`を永続化する。`CREATING`後のtimeout、5xx、ACK喪失、権限・mapping・接続generation・scope変更、保存失敗は`UNCERTAIN`で止め、盲目的に再作成しない。成功時も`google_channel_output_bindings.active=false`であり、OWNER DTOにcalendar ID、nonce、token、scope、Google responseを返さない。

入力calendarの通常保存経路とsetup finishは、provider inventory mutexの後にopaque calendar ID順の共通advisory lockを取る。これによりprovider busy、resource busy、booking calendar、active/inactive output bindingをprovider横断で同時採用できない。lockは設定transactionだけに限定し、Google通信中は保持しない。

作成前の`PREPARING`で処理が中断した場合は、同じPOSTへ`operation: "cancel_preparing"`を明示する。現在のOWNERかつGoogle接続本人と元commandのfingerprintを照合し、nonceを変更してから`FAILED_BEFORE_CREATE` / `PREPARATION_CANCELLED`へ終了する。Google通信は行わず、新commandで作成を開始できる。元mappingが変わった後も元commandの未送信状態は安全に終了できるが、`CREATING` / `UNCERTAIN`はこの操作で解除しない。

このbackendに含めないもの：初期anchor、Airbnb側への実接続、bindingのactive化、setup UI、observerとtyped receipt、予約reader、本番flag有効化、PWA通し、伝播SLO実測。これらの受入が終わるまで専用calendarは配送対象ではない。

### Issue #278 の初期anchor backend

Issue #275 が正常完了したinactive bindingに対してだけ、OWNER本人が対象回の決定的anchorを1件準備できる。endpointはsetupと同じHTTP mode・host console・既定OFF flagで閉じる。入力はprovider/listing/occurrence、期待mapping/desired version、UUID v4 command、`initialize | inspect`だけで、calendar ID、時刻、状態、token、actorは受けない。応答もcommand/listing/occurrence/stateと固定reasonだけに選別する。

`initializeGoogleManagedBlock` は通常配送writerと分離したinsert-only helperである。最初のGETが現intentと完全一致ならwriteせず成功し、所有marker、時刻、mapping/desired version、OPEN/CLOSEDのいずれかが違う既存eventはPATCH・DELETEしない。404のときだけ、決定的ID、固定件名、private visibility、OPEN=`transparent` / CLOSED=`opaque`、private markerを持つeventを最大1回POSTする。409、ACK喪失、5xxでも二度目のinsertはせず、独立GETが完全一致したときだけGoogle検証済みにする。通常の`applyGoogleManagedBlock`は変更せず、OPEN 404では引き続き`ANCHOR_MISSING`で停止する。

serverはprovider inventory mutexを各transactionの最初に取り、外部通信中はDB lockを保持しない。毎回、現在OWNERかつGoogle接続本人、activeな数値Airbnb対象、未失効・非quarantine account、既存3scope、#275の`READY_FOR_CONNECTION`と一致するinactive binding、provider横断の入力calendar非衝突、live canonical occurrence、既存desired rowとshared inventoryの一致、未解決の通常配送がないことを再検証する。desired rowやoccurrenceを初期化処理から作らない。

journalは`PREPARING`の後、Google event I/O前に`INITIALIZING`を保存する。provider/account/listing/occurrence/actor/command、account・mapping・binding・connection generation、calendar/scope digest、desired state/version/UTC区間、operation nonce/epochだけを保持し、credential・calendar ID・raw bodyは保持しない。同じcommandの再送はinsertせず、`INITIALIZING` / `UNCERTAIN`の明示`inspect`だけが新しいnonce/epochを取得してGET-only照合する。missing・読取失敗・設定/token失敗では`UNCERTAIN` fenceを残し、別commandや自動initialize retryで回避できない。古いcallbackはnonce/epoch CASで新しいinspection結果を上書きできない。

`PREPARING`で中断したcommandの明示`inspect`は、Google通信をせずnonce/epochを更新して古い実行を無効化し、`FAILED_BEFORE_INITIALIZE` / `PREPARATION_CANCELLED`へ安全に終了する。その後は新しいcommandで準備できる。現在OWNERかつGoogle接続本人は、元desired・時刻・listing設定が変わった後も、GETから未送信準備と安全終了済みの最小状態・command IDを取得できる。カレンダー作成前のPREPARINGも同じ読取原則を使う。`INITIALIZING`以降はこの未送信扱いを適用せず、結果不明のfenceとGET-only照合を維持する。

この段階ではbindingをactiveにせず、Airbnb接続・activation・UI・scheduler・readerを追加しない。Google側のanchor確認だけでAirbnb反映済みとは扱わない。

実DBを使う結合testは、実 `ChannelRuntime` / repository / `applyGoogleManagedBlock` / `inspectGoogleManagedBlock` と合成fetchを接続し、ACK喪失、duplicate write抑止、stop-confirmed OBSERVEからのGET-only再照合、binding/desired失効、operation fencing、cross-provider calendar衝突を永続状態とwrite回数で確認する。token refresh/configだけを合成注入し、実Google・実Airbnb・実credentialは使わない。helperにはlocalhostでzero-byte ACK bodyの10秒deadlineを確認するtestもあるが、socket listenを禁止するsandboxではその1件を実行できない。

今回も作っていないもの：専用app-created calendarの本番provisioning（backendはdefault-offの合成検証まで）、Google同意とAirbnb側接続、OAuth接続UI、Airbnb observerとそのtyped receipt、production setup・flag有効化、PWA通し、伝播SLOの実測。本番calendar、credential、daemon/runtime config、NIHOapp Draft、network、Airbnb画面を使った受入にも触れていない。

Airbnb制御用のGoogle書出しcalendarはbooking/provider busy/resource busy入力から除外し、自己書込による永久busy循環を防ぐ。Google専用calendarをAirbnb対象listingへ実接続できること、Airbnb browser observerのtyped acceptance、PWA通し、停止・再開それぞれの最大60分伝播実測は別受入である。NIHOapp Draftと本番flagは変更していない。したがって本変更は#239の一部であり、#239 / #201 / #194を完了させない。
