# Google専用予定writerのHTTP protocol

更新日：2026-10-30。Issue #239 / #201 / #194 のうち、Google Calendar HTTP境界だけを実装した文書である。Googleへの接続、配送、Airbnb観測、本番有効化の完了を示すものではない。

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

合成testは、すでにabortしたbody streamと、上限超過後も終了しないbodyのcancelを確認している。ゼロbyteのまま停止するbodyを実時間のdeadlineまで待つtestではない。request signalはbody読取にも効くfetch境界へ渡しているが、そのdeadline実時間経過の証明は今回のtargeted testに含めない。

## typed result

- `GOOGLE_VERIFIED`: Google側の選別済みmetadata、`changed`、write ACK有無を返す。Googleだけの検証結果である。
- `ANCHOR_MISSING`: OPEN対象のeventが404。受付再開やAirbnb反映の成功ではない。
- `TOMBSTONE` / `CANCELLED_EVENT` / `STATUS_MISMATCH` / `ALL_DAY_EVENT` / `FOREIGN_EVENT` / `MAPPING_MISMATCH` / `TIME_MISMATCH` / `VISIBILITY_MISMATCH` / `STALE_INTENT`: write前に安全に変更できないため停止した結果。
- `PRECONDITION_FAILED`: ETag競合。新しいintentを読み直すserver処理が必要である。
- `WRITE_UNCERTAIN`: writeが届いた可能性はあるが独立GETで確定できない。追加writeではなく配送journal側で隔離・再判断する。

このunionにAirbnbの`SYNCED`や既存browser adapter用の`manualBlocked=true`はない。Google ACKや`GOOGLE_VERIFIED`だけで旅行者へ受付停止・再開の反映済み表示を出してはならない。

## 未接続・未受入

合成HTTP試験に加え、localhostの合成サーバーがヘッダー送信後に本文を返さない場合も、実際のfetchが10秒deadlineで中断し、追加writeなしの読戻しへ進むことを試験する。実Googleへの障害試験ではない。

今回作っていないもの：server setup、DBのoutbound dispatch journal、job executor、15分dispatcher、専用calendarの作成・listing対応付け、API caller、OAuth接続UI、Airbnb observer、production flag。本番calendar、credential、network、Airbnb画面を使った受入も行っていない。

今後のserver設定では、Airbnb制御用のGoogle書出しcalendarをprovider・資源のbusy入力から必ず除外し、自己書込による永久busy循環を防ぐ必要がある。過去dispatchが存在しないことの証跡、Google専用calendarをAirbnb対象listingへ接続できること、同じlisting/occurrenceの実際の停止・再開は、それぞれDB journalとAirbnb observer・実画面で別に確認する。したがって本変更は#239の一部であり、#239 / #201 / #194を完了させない。
