# OTA 共有在庫

Issue #197 の共有在庫基盤を記録する。外部予約の取込み・取消、商品限定operator、支払・税・通知の再設計、資源管理UI、本番runtimeの有効化は含まない。

## 在庫モデル

- 未設定商品は従来どおり `SEAT`（席数制）である。`PRIVATE_GROUP` を明示した商品だけ、人数とは別に1予約を1組として扱う。定員を1へ書き換えないため、1組6名の申込みにも既存の人数上限と料金計算がそのまま働く。
- `VENUE`、`INSTRUCTOR`、`EQUIPMENT` はprovider所有で、同時に使えるのは1組である。商品割当には準備・片付け分を持ち、占有区間は半開区間 `[start, end)` とする。終了と次の開始が同じなら競合しない。
- 資源と割当の外部キーは常に `(provider_id, id)` の複合キーである。同じ会場をNIHO共通で利用する場合も、現段階では別providerから共有・参照できない。将来共有する場合は、所有者とは別の明示的grantと監査を追加し、この制約を迂回しない。
- 予約時のmode、資源kind、準備・片付け、占有開始・終了はimmutable snapshotとして保存する。資源を無効化しても確定予約のsnapshotは残り、以後の新規受付だけを止める。`CONFIRMED` と未失効の `HOLD` だけが現在の占有となり、期限後に届いた支払の `PAYMENT_REVIEW` は資源を再取得しない。

## 書込みとロック

在庫に関係するtransactionは最初に `provider-inventory:{providerId}` のtransaction advisory mutexを取る。その後は、既存のcommand/idempotency、商品、開催回、予約rowの順でロックする。資源単位の複数ロックや人工sleepは使わない。OTAのpreflightとresultも、worker認証後にproviderを特定し、job rowより先に同じmutexを取る。結果受理とHOLDを直列化し、dispatcherとの逆順ロックを作らない。この順序により、別商品の同室・同講師を含むHOLD競合をprovider内で直列化する。

`OWNER` / `EDITOR` のtyped Store操作は、資源作成・更新と商品mode/割当設定にUUID v4 commandとexpectedVersionを要求する。同じcommandと同じ入力は再送結果を返し、異なる入力、version不一致、他provider資源、将来の確定予約・active HOLDがある商品の設定変更は競合として拒否する。設定・在庫変更と `calendar_outbox_events` は同じtransactionでcommitする。

## 共通判定とoutbox

直販HOLD、ホストカレンダー、OTA reconcile、preflight、resultは共通のinventory evaluatorを使う。判定は手動休止、cutoff、席数、private group数、資源の有効性・重複、Google freshness/coverage/busyを合成する。内部reasonは `GROUP_RESERVED`、`RESOURCE_INACTIVE`、`RESOURCE_BUSY` として型付けするが、ホストUIは既存の「満席」「休止」「予定あり」の短い表示へ写像する。

予約HOLD作成、確定・`PAYMENT_REVIEW`、HOLD失効、Google busy/failure/freshness、資源・割当変更は通知用 `outbox_messages` ではなく、専用 `calendar_outbox_events` に再計算を保存する。HOLD期限とGoogle freshness期限は `available_at` にも再計算を予約する。同一command/idempotencyの再送では追加しない。未消費outboxがあってもpreflightとresultは現在DBから同じ判定をやり直すため、古いOPENをVERIFIEDにしない。

## 時間経過の再計算

workerのclaim pollは、認証済みworkerに割当済みでactive listingがあるproviderだけを対象に、次の順で処理する。

1. `enqueueDueReconciliationTicks(worker, 20)`
2. `consumeCalendarOutbox(50, worker)`
3. `claim(worker)`

providerごとのtickはDBに1件だけ置き、pending commandがある間は増殖させない。outboxの最終ページが成功commitした時だけpendingを解除し、`next_due_at` を1分後へ進める。展開範囲はTokyo当日から56日、1transaction最大2,000 occurrenceで、既存のdurable cursorを引き継ぐ。新しい外部cronやCodex automationは追加しない。

本実装後も `EXPERIENCE_CHANNEL_RUNTIME_ENABLED` などのruntime flagは既定OFFのままである。外部予約取込みと実OTA受入が終わるまで、本番対応済みとは扱わない。

## 配備と検証

`0009_shared_inventory.sql` を先に反映し、このスキーマを参照するAPIを配備する。既存商品は設定未登録の席制を保つ。source codeの実装と本番有効化は分けて受け入れる。

実PostgreSQLで、2名／6名の同時HOLD、同室・同講師と準備片付け、別室／隣接、保存失敗のrollback、失効後の実支払によるPAYMENT_REVIEW、古いOPENの拒否、並行HOLDとOPEN resultの受理順、tick/cursor/通知outbox分離を確認した。結果受理中にHOLDがDBのロック待ちになることと、receipt保存→HOLD作成の順序を実DBで確認する。
