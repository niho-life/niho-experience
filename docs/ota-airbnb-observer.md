# Airbnb カレンダー read-only observer

Issue #295 では、`packages/ota-worker` に Airbnb 体験カレンダーを読むための **standalone factory** `createAirbnbCalendarObserver` を追加した。これは supervisor、driver registry、worker loop、Google caller、production flag のいずれにも接続していない。運用開始、定期実行、60分の durable propagation wait、later-lease proof は #281 以降の別受入である。

## 対象と返す事実

対象は現在の `Airbnb` / `GOOGLE` / `airbnb-google-busy@1` mappingだけで、account ID と product ID は正の10進文字列、option ID は空、timezone は `Asia/Tokyo` に固定する。JavaScriptの数値には変換しない。read-only observer は fresh lease の `SET_OPEN` / `SET_CLOSED` / `OBSERVE` jobを受けるが、SETでも保存・入力は行わない。SETのcloud preflightはjobの`desiredState`と一致させ、OBSERVEは現在の`OPEN` / `CLOSED`のどちらも受ける。reservation purposeは対象外である。

`observeTarget()` は呼ぶたびに次のcycleを最初から行う。

1. 現行jobのlease・deadlineとcloud preflightを確認する。
2. `https://www.airbnb.jp/users/profile/about?context=host` を通常遷移で開き、`main` の「自己紹介」と「編集」buttonを確認する。
3. buttonを通常clickし、SPAが遷移する完全一致の表示URL `…/users/profile/about?context=host&editMode=true` から、そのcycleで発生した pinned `UserProfileQuery` GETだけを読む。要求accountの `User` と `owner.isViewerProfileOwner === true` を確認し、公開profileが読めるだけでは本人証明にしない。追加・重複query、別のedit path、form/saveは許可しない。
4. 対象日の `/multicalendar/experiences-and-services/YYYY-MM-DD/week` を通常遷移で開き、そのcycleで発生した pinned `XSCalendarEventsQuery` GETを読む。
5. decoded listing IDまたはAirbnbの正規share linkが対象listingを名乗るrowを完全検証し、対象区間・listing・share linkが一致する可視rowが一意であることを確認する。他listingとprivate calendar rowは内容を返さず破棄する。対象を名乗る競合・不完全rowは停止し、再度cloud preflightとlease・deadlineを確認する。

各cycleはjob deadlineとlease expiryの早い方で独立して打ち切る。preflightやresponse bodyが未完了でも期限時にbrowser stopを開始し、元のPromiseの完了を待ってfactを返さない。

成功時に返すのは次の選別済みfactだけである。response原文、他listing、非公開予定、price、title、連絡先、calendar/event IDは返さず保存しない。

```json
{
  "occurrenceId": "cloud jobから受けた値",
  "sourceStartAtUtc": "2099-01-01T04:00:00.000Z",
  "sourceEndAtUtc": "2099-01-01T05:00:00.000Z",
  "observedAtUtc": "観測・本人性・post-read preflight完了後の時刻",
  "bookable": true,
  "evidence": "EXACT_SLOT_V1",
  "partySize": 1
}
```

`bookable` は `isAvailable === true` かつ `remainingCapacity >= 1` のときだけtrueである。`isAvailable === false` でcapacityが残るrowも明示的なnot-bookableとして扱う。一方、row欠落、重複、部分response、型drift、範囲不足、非表示、account不一致は **CLOSEDに変換せず停止** する。`bookable: false` から手動block、予約数、予約ゼロ、理由を推定しない。

## 通信境界

- browserが通常画面操作で発生させたGETだけを使い、既知requestの合成・replayや別transportへのfallbackを行わない。
- Airbnb本体は `https://www.airbnb.jp`、assetは `https://a0.muscache.com` の完全一致originだけである。suffix一致や追加domainを許可しない。
- `/api/v3/<operation>/<64文字lowercase hash>` は公開済みのpinned read operationだけを許可する。primary queryは `operationName, locale, currency, variables, extensions` の5個ちょうどで、補助queryだけは通常UIの空variables省略も受ける。重複・追加・hash不一致を拒否する。
- profileとcalendarのprimary queryはvariablesも完全固定する。補助queryはpinned operation/hashと有界JSONに限定する。
- 実際のprofile表示で発生する `POST /api/v2/client_configs` と `GET /api/v2/get_travel_guides_by_user` は、本人・対象回の証拠に不要なため送信せず破棄する。これらの破棄だけでは必要な読取りを停止しない。別path・methodへこの例外を広げない。
- POST / PUT / PATCH / DELETE、mutation名、unknown API、websocket、subscription、service worker、popup、downloadを許可しない。接続前の`routeWebSocket` interceptionが使えないbrowserはread前に拒否する。userinfoまたはfragmentを持つrequestはforwardしない。telemetryは送信せず、必要なUI readを壊さない範囲でnon-fatal abortできる。未知の業務requestはfail closedにする。
- responseはHTTP 200、JSON content type、最大2 MiB、calendar最大512 rowsに制限する。GraphQL errorやpartial responseを受理しない。
- observerには入力・保存・`applyDesiredState` がなく、guardの`writes`は常に0である。

## profile と設定

Airbnbは `siteAccountProfiles.Airbnb` の専用mappingだけを使う。pathはprivate directory配下の `profiles/airbnb/<正の10進account ID>` に固定し、GetYourGuideの `accountProfiles` へfallbackしない。

この追加では秘密情報、credential、production config例、session復元を追加しない。session restorationは従来どおり明示受入済みのJalanだけであり、Airbnb browserは常に`none`で起動する。ログイン済み専用profileの準備・保管・実サイトpilotはコード外のowner作業である。

## 検証と未接続範囲

focused unit testは、大きな10進IDの文字列保持、canonical base64、本人owner、OPENと明示CLOSED、欠落・重複・partial・型drift・link/time/capacity/UTC/coverage/filter、pinned GET guard、mutation・未知request・追加originの拒否、private profile namespaceを対象にする。localhost browser testは、実Chromeで通常のprofile clickとweek navigation、2回目のfresh cycle、account/auth/preflight/deadline失敗、body上限、悪性POSTの未到達、停止確認を対象にする。

合成fixtureは実サイト互換性、認証profileの健全性、継続稼働、同期SLAの証拠ではない。parent review後の実サイトread-only pilotと、将来のcaller・durable wait統合が完了するまで、本番同期済み・予約ゼロ・Airbnb在庫の正本とは表示しない。
