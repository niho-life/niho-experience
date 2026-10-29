# Airbnb体験とGoogle Calendarの接続・受入設計

更新日：2026-10-29。Issue #201 / 親 #194。**Google UIからの停止・再開は実証済み。以下のNIHO自動出力、資源別入力、typed receipt、接続切替は未実装の設計**である。[現在の実装範囲](ota-runtime.md)と区別する。

## 1. 実証で確認した範囲

オーナー指定の元のAirbnb体験で、予約のない既存回だけを使った。

| 操作 | 確認結果 |
| --- | --- |
| 既存の連携Googleカレンダーに検証予定を作りbusyにする | 対応回がAirbnbで予約不可になる |
| 同じ予定をfreeにする | 元の予約可能な状態へ戻る |
| 自分が作った検証予定を削除する | 検証予定が残っていないことを確認 |

既存の連携設定、他の予定、予約、価格は変更していない。実ID、ログイン情報、画面証跡は非公開で保管する。この1往復から一般的な反映時間・安定性・予約発生後の残枠停止を保証しない。

Airbnbの公式説明でもGoogleのbusy予定がブロックに使われ、free予定はブロックに使われない。全体験・選択した体験・体験ごとの同期が案内されている。ただし、その説明だけでは「NIHO名義の複数商品に、それぞれ独立した入力Googleカレンダーを同時接続できる」とは確認できない。[Airbnb公式](https://www.airbnb.com/help/article/2822)

現画面の追加の読み取りでは、対象体験に対応する既存接続1件と解除操作を確認した。2本目の入力追加は未確認で、既存接続を解除する実証は行っていない。宿泊用ICSの同期頻度を体験へ流用しない。

## 2. 最初に実現する操作

PWAで**既存回を休止・再開**し、NIHOがGoogleの専用予定を変更し、StudioがAirbnbで結果を確認する。Googleに予定を作るだけではAirbnbの開催回は作れない。回の新規作成、日時変更による旧回の停止・新回の作成は別能力として管理する。

初期の1回1組は、外部商品もその販売条件と一致してから有効化する。公開の人数制商品を、NIHO内だけ1組制へ変えた状態では受入完了にしない。実予約が入った回の変更・取消を、今回の空き枠検証の許可に含めない。

## 3. 入力と出力を分ける

| 役割 | 含めるもの | NIHOの扱い |
| --- | --- | --- |
| 入力Googleカレンダー | 講師の不在、会場利用など | 空き時間だけを読み、講師・部屋などの資源に対応付ける |
| NIHO予約の出力 | NIHO直販で確定した予約の予定 | 任意の表示用。入力へ戻さない |
| Airbnb用の専用出力 | NIHOの判定がCLOSEDとなった対象回のブロック | 対象listingへ明示的に対応付ける。FreeBusy入力から除外する |
| AirbnbからGoogleへの予約出力 | Airbnb側の予約予定 | 自分のブロックの根拠へ混ぜず、外部予約取込み #200 で扱う |

FreeBusyは予定IDを返さないため、同じカレンダーを入力と出力に使って「NIHOの予定だけ除く」方式は採らない。閉鎖を出力し、それを新しいbusyと判断し続ける循環を避ける。

provider全体のbusyを講師全員へ広げない。講師Aの入力はAを使う商品、同じ部屋の入力はその部屋を使う商品へ適用する。個人の予定名・連絡先・予定IDは商品運営者のDTOに出さない。入力の取得失敗、coverage外、OAuth失効時は再開を保留する。busyが消えても、予約・手動休止・他資源の占有があれば閉じたままとする。

## 4. OAuthと専用カレンダー

既存packageは `calendar.events.freebusy`、`calendar.calendarlist.readonly`、`calendar.app.created` を要求する。第一案はNIHOが作成する専用カレンダーへの出力である。`calendar.app.created` を、既存の私用カレンダー全体への書込権限とは扱わない。既存カレンダーへ書く案を採る場合は、対象と追加scope、新しい同意を別に受け入れる。[Google公式scope一覧](https://developers.google.com/workspace/calendar/api/auth)

接続の保存では、OAuth本人、対象provider、出力カレンダー、対象listing群、入力資源、mapping versionを非公開で結ぶ。表示名だけで対象を推測しない。NIHO運営者招待は、Googleの私用予定へのアクセス許可を兼ねない。

## 5. 配送とGoogle予定の更新

以下は追加する契約案で、現行 `ChannelRuntime` のreadbackへ未検証の値を入れて互換扱いにしない。

1. PWAの保存と同じtransactionでoutboxを作る。共有在庫の判定をGoogle経路にも共用する。
2. jobにaccount/listing/mapping/desiredのversion、対象回の時刻、専用カレンダーのopaque参照を固定する。
3. 初期pilotはGoogle書込とAirbnb観測を直列に処理する限定executorとし、Google tokenをモデルやブラウザページへ渡さない。同一account/listingへ直接Airbnb writerも並行起動しない。
4. Google予定は対象回に対する決定的なIDを持たせ、private metadataでNIHO所有・mapping versionを識別する。予定には顧客情報、招待先、ゲストを付けない。
5. CLOSEDは専用予定をbusy、OPENはfreeにする。稼働中のanchorは再開のたびに削除・再作成しない。GoogleイベントIDにはGoogleの文字種制約を守る既存のhash変換を再利用する。
6. 既存予定の変更は取得したetagと`If-Match`を使う。412なら現状と現在のdesiredを読み直し、古いOPENをそのまま再送しない。新規insertには条件付き変更が使えないため、決定的IDの衝突時は所有markerと現状を確認する。[Googleの条件付き変更](https://developers.google.com/workspace/calendar/api/guides/version-resources)、[予定作成](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
7. 保存直前のpreflight、account排他、deadline、失効・mapping変更時の隔離、応答不明時の書込み停止は既存workerと同じ基準にする。etagだけでNIHO側の権限失効まで防げるとは扱わない。
8. GoogleのACKを保存した後、Airbnbを読み取って対象・時刻・実際の予約可否を確認する。実行後の読戻しが取れない場合は、Google再書込みではなく観測を再試行する。

Googleの成功、Airbnbの成功を同じbooleanにしない。新しいreadbackは `GOOGLE_BUSY` という制御方式と、Google予定の所有marker・時刻・transparency・etag、独立したAirbnb観測時刻と予約可否を区別して持つ。現行browser adapter用の `manualBlocked=true` をGoogle経路で捏造しない。

## 6. 画面の状態

| 状態 | カレンダーで示す文言 | 次の処理 |
| --- | --- | --- |
| desired保存済み・配送待ち | 反映待ち | jobを処理 |
| Google保存済み・Airbnb未確認 | 確認中 | Airbnbの読戻し |
| 現version・対象・時刻・予約可否が一致 | 反映済み | 通常運用 |
| ログイン切れ・結果不明・対象の食い違い | 要確認 | 詳細で対象サイトと必要な操作だけを示す |

講師は日付と休止・再開だけを操作する。OAuth scope、etag、lease、Google予定IDは通常画面へ出さない。初回接続と障害復旧の手順はスタッフ向け設定へ分ける。外部未確認を「空きあり」と緑表示しない。

## 7. 既存接続からの切替

優先するのは既存入力を保ち、専用出力を別に接続する案。ただしAirbnb側の追加可否・影響範囲を実画面で受け入れるまでは有効化しない。

1. 元の接続対象・入力用途・対象商品・元の受付状態を非公開で記録する。無関係な商品の一覧も比較対象にする。
2. 追加接続できない場合は、既存busyを独立入力として読み、その判定結果を専用出力へ集約する案を選ぶ。元の会場busyを失う単純な差替えはしない。
3. 対象と復元手順を提示してから接続切替を行う。writer停止→現状照合→mapping変更→再照合の間は、二重writerを起動しない。
4. 対象の空き回で停止・再開・復元を確認し、無関係な体験が閉じていないことも確認する。失敗時は元の接続へ戻す。
5. 継続した観測ができてからpilotを有効化する。Airbnbで確認できるまでGoogleへの書込ACKだけで受付再開を案内しない。

## 8. 実装順と受入

| 段階 | 必要な証明 |
| --- | --- |
| 資源別Google入力 | 講師A/B・共用部屋の分離、timezone・終日・準備片付け、freshness/coverage失敗時に再開しない |
| 専用予定writer | 所有marker違いを変更しない、重複insert、etag競合、応答喪失、古いOPEN、失効を合成HTTPで試験 |
| typed delivery/observer | Google ACKのみでは反映済みにならず、Airbnbとの不一致・観測失敗を保持する |
| 実NIHO接続 | NIHO認証、専用DB・限定DML・migration・Google OAuthを先にstgで受け入れる |
| 実Airbnb pilot | 許可された空き回だけでPWA→NIHO→Google→Studio読戻しを確認し、元へ復元 |
| 外部予約との統合 | #200 の正規予約取込み後、別販路の予約・取消・変更と1組制が一致する。空き回試験で代替しない |

この文書の追加だけで #201 / #194 はcloseしない。Google UIでの実証を、自動出力・複数商品の独立接続・本番PWA結合の完了へ広げない。
