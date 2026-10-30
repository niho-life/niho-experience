# Google資源入力とAirbnb出力の設計判断（#238/#239）

根拠（2026-10-30確認）:
- Airbnb体験・サービスのGoogle同期: https://www.airbnb.jp/help/article/2822 。busyの予定がブロックとして入り、確定予約がGoogleへ戻る。空きの予定はブロックされない。宿泊の3時間ICS同期の説明を体験へ流用しない。
- Freebusy: https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query 。calendarごとのbusy/errorを返し、終端はexclusive。複数calendarを既存queryGoogleBusyで平坦化すると資源別由来が失われるので、選択したcalendarごとに照会するかkey保持の選別APIを追加する。
- Events watch: https://developers.google.com/workspace/calendar/api/v3/reference/events/watch 。既存events.freebusy scopeで監視を要求できる。
- Push: https://developers.google.com/workspace/calendar/api/guides/push 。HTTPS受信、channel ID/resource ID/token照合、期限更新が必要。通知は現在状態そのものではないため必ずfreebusyを再取得し、通知欠落をpollで補う。

## #238（入力）
- 既存provider単一busy互換を維持。選択した資源に別のGoogle busy calendarを割当てられるようにする。provider全体の設定は従来どおり、資源指定はその資源を使う体験だけ止める。
- OAuth tokenの正本は既存provider_google_connections。接続version/epochを追加し、refresh/保存/disconnect/再接続が競合した場合に旧syncが新設定を上書きしない。ネットワーク中にDB transactionを保持しない。sync前snapshot→外部照会→provider mutex下でepoch/calendar/resource設定版照合→保存。
- 資源別configurationはprovider+resource複合FK、busy calendar IDはserver専用。lastAttempt/freshUntil/coverage/statusと選別busy区間を保存。件名・参加者・event本文は取得・保存しない。未設定資源は従来どおり。
- stale/failed/coverage不足は割当資源を使う商品だけ新規受付不可。mutex内の同じinventory evaluatorでguest HOLD/host/OTA desired/preflight/resultを判定し、expiry outboxも生成。
- 切断で空きへ戻さない。意図的にブロックを外す操作はownerの別の明示設定変更として扱う。Google失効時の再接続表示を短く保つ。
- OWNERだけがcalendarを選択・変更する。OPERATORには予定ありの区間と判定だけを出し、calendar ID/name/token/私用予定を出さない。Adminは資源設定を扱うが、本人のOAuth同意を代理で作らない。
- watch通知の意味はdirty。ランダムなsecret tokenのdigest、resource ID、channel ID、接続epochを照合し、期限切れや旧epoch通知は受理しても再計算へ昇格しない。通知本文/メタデータを予約事実にしない。
- 既存worker pollを使う耐久DB taskでsync dueを起こし、別のCodex automation/cronは作らない。watchは遅延削減、通常pollと期限検査が完全性を担う。

## #239（出力）
- listingごとに専用のapp-createdカレンダーを使い、Google app.created scopeの範囲に限定する。予約書出し、私用busy、Airbnbへの制御出力は別々のcalendar ID。
- 出力calendarはproviderをまたいで一つのlistingだけへ固定し、全providerのprovider/資源busy入力・booking calendarとして選ばせない。Airbnbが確定予約を戻しても自己書込による永久busy循環を起こさない。
- deterministic event ID = provider/listing/occurrenceのhash、private visibility、opaque、件名は短い固定値。料金/顧客/他の予定を入れない。
- CLOSEDは対象時間のNIHO所有eventを作成または`opaque`へ変更。OPENは同じeventを`transparent`へ変更し、繰り返す開閉では削除しない。決定的IDの削除後再作成・tombstoneに依存しない。自分のIDでもownership marker/current mapping/version/ETag不一致なら触らず、外部/手動作成eventは変更しない。
- GETの404/410だけでAirbnbの受付再開を成功とせず、対象と現在desiredを照合。POST409は既存eventをGETして同一内容を検証する。送信前とreadback時にcurrent target/versionを再確認する。専用カレンダーをAirbnbへ接続できることは実画面で別受入し、既存カレンダーを書けない理由だけでOAuth scopeを広げない。
- GoogleへのACKはGOOGLE_WRITTEN。Airbnbで同じ掲載/実施回の停止/受付を独立に再確認するまでOTAのSYNCEDにしない。GoogleとAirbnbの伝播は60分程度を許容するが、timeoutは成功でなく要確認。
- Googleのbusy予定でAirbnb枠そのものは作れない。NIHO新規回/時刻変更は#241で別能力・受入とする。まず既存回だけ。
- writerのcredentials、Google secret、Airbnb sessionはいずれもCloud/Studioの指定私用領域に限定。本番のOAuth同意/実サイト変更は実際の画面で別受入。

## #238 の実装境界（2026-10-30）

- `0015_resource_google_busy.sql` は接続の単調なgeneration、OWNERだけが読めるcalendar inventory、資源設定、選別UTC busy区間、watch metadata、15分due/lease/receiptを追加する。資源設定は `(provider_id, resource_id)` 複合FKで、接続削除には連動削除しない。
- `evaluateStoredInventories` は商品に割り当てた資源ごとにprepare/cleanupを含む半開区間を評価する。enabled資源の接続generation不一致、STALE/FAILED、freshness切れ、coverage不足は `RESOURCE_GOOGLE_UNAVAILABLE`、重なりは `RESOURCE_GOOGLE_BUSY`。未設定資源とprovider全体の従来Google判定は独立して残す。
- OWNER BFFはfreshなhost actorと現在のExperience OWNERを二重確認し、Googleから取得した10分以内のcalendar inventoryだけを選択可能にする。予約出力calendarは一覧から除外する。OPERATOR/COHOST DTOにはcalendar ID・name・tokenを含めない。commandはUUID v4、expectedVersion、fingerprintを保存し、同じ再送だけACKする。
- Studio workerは既存の認証済みoutbound pollから `/internal/ota/v1/google-sync` を最大25秒で呼ぶ。cloudは毎回worker credentialとprovider assignmentを確認し、一要求を1provider・1資源のcalendarに限定し、あるcalendarの権限エラーを別資源へ広げない。calendar IDはworkerへ返さない。flag OFFや旧cloudの404は既存OTA jobを止めない。
- syncはDB外でrefresh/freebusyを行い、provider inventory mutex内でconnection generation、settings version、calendar ID、claim/lease epochを再確認してからだけ保存する。busy区間は資源ごとの一括INSERTで保存し、区間数に比例するDB往復を避ける。成功は15分後due・25分freshness、失敗/失効はbusyを空にせず受付を保留する。busy変更、失敗、freshness期限のcalendar outboxは同じtransactionで作る。
- watchはHTTPSのchannel ID、Google resource ID、token digest、有効期限、単調message number、connection/settings epochを検証し、通知をdirty化するだけである。本文を読まず、必ず次のfreebusyで状態を確定する。watch登録はpollと並行し、失敗しても15分pollが完全性を担う。
- watch登録後に同期保存がSUPERSEDEDになったchannelは永続metadataへ採用せず、通知ではbusyを変更できない。外部channelはGoogle側TTLで失効し、pollが完全性を維持する。

## 未受入・既定OFF

- `EXPERIENCE_RESOURCE_GOOGLE_ENABLED` と `EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED` は既定false。watchはさらに本番HTTPSの `EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL` がなければ作らない。mock/previewはresource設定routeを404にし、browser stubだけをUI検証に使う。
- 合成テストはOAuth接続、本番calendar、本番worker assignment、webhook到達を証明しない。本番OAuth consent、watch URL配備、実資源calendar、runtime flag有効化、Studioからのpoll、接続解除/再接続は親の別受入で確認する。
- #270でGoogle出力writerのimmutable binding journal、resource単位の未解決intent fence、operation CAS、server executor、内部API、stop-confirmed OBSERVE leaseからのGET-only再照合まで実装した。再照合は保存済みGoogle targetの証拠だけで、現在desiredやAirbnbの成功にはしない。専用calendarの本番provisioning、Google同意/Airbnb接続、#237 Airbnb reader、PWA通し、60分実測は未完了である。NIHO料金・決済・予約取消・V2 OTAサイトの契約は変更しない。
