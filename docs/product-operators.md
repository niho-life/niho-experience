# 商品限定運営者

Issue #196 の商品限定運営者は、NIHO の provider member とは別の Experience 内認可である。NIHO は毎回、現在のアカウント identity と host API の接続状態を検証する。Experience はその後に `(provider, product, NIHO user)` の有効な grant を検証する。`OPERATOR` はExperience内のカレンダー用区分であり、NIHO の `HostProvider`、OWNER / EDITOR / COHOST、通常の provider-wide API を拡張しない。

## 招待

- Admin は DB にある商品と100字以内の内部用担当名を選び、7日以内の招待を作る。メール送信とNIHO user ID入力は行わない。
- token は32 byte乱数を base64url にし、作成レスポンスの URL fragment で一度だけ返す。DBには SHA-256 digest だけを保存する。同じ command の再送でtokenを再表示しない。
- `/host/invitations/<uuid>#<token>` は最初の inline script でfragmentをmemoryへ移してURLから消す。prepare POSTは権限を付けず、purpose分離した10分以内のHttpOnly cookieへ移すだけである。
- accept POSTだけが、freshなNIHO identityへgrantを束縛する。同じ本人の再送は同じgrantを返し、別人、期限切れ、失効、別UUID cookieを拒否する。

## カレンダー境界

calendar read/write は共通の商品predicateを使う。mutationのlock順は provider inventory mutex、membershipまたはgrant row `FOR SHARE`、過去command、product/ruleである。grant revokeとinvite accept/revokeも同じprovider mutexから始めるため、revoke commit後の新規writeと過去receiptの返却を拒否する。

operator response は許可商品だけを返す。予約人数、空席数、Google busy interval、外部account/calendar IDを返さない。日時変更可否は内部の予約状態から `canReschedule` として返し、availability判定はproviderと同じinventory evaluatorをサーバー内で使う。予約、CSV、通知、売上、返金、Google管理、商品原稿は従来どおりprovider membershipを必要とする。

grant失効は新しいcalendar変更を止めるだけで、providerが所有する既存枠、予約、channel jobを削除しない。external account/listingの委任解除とversion fenceは別の台帳契約として維持する。

現在のNIHO provider一覧にない運営者と、NIHOで権限を下げられた担当者には、サーバーで `calendarScope=OPERATOR` を設定する。この値はリクエストから採らず、Storeの全カレンダー認可でもprovider所属を根拠に使わない。Experience側に古いOWNER行が残っていても担当外商品へ広がらず、カレンダー以外のStore操作も拒否する。

## 配備

`0011_product_operators.sql` をAPIより先に適用する。migrationは数値prefixだけでなく完全なファイル名で識別し、名前順で適用する。既存の `0010_guide_body_media.sql` と `0010_shared_inventory.sql` は独立した2ファイルであり、両方必要になる。適用済みファイルの改名・再実行はしない。

runtimeにはinvitation/grantのSELECT・INSERT・UPDATEと、command/auditのSELECT・INSERTだけを付ける。command/auditのUPDATE・DELETEやprovider所属の権限変更は付けない。初期bootstrap scriptは0001〜0004だけを対象にするため、それを実行済みであっても新しいmigration・DML権限の受入を省略しない。HTTPの既定OFF flag、NIHO認証連携、本番切替のゲートは維持する。
