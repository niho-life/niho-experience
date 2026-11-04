# 予約支援操作の結果確認

対象: #121 / #128。新しい Experience 予約の取消・返金・連絡は既存の Experience Store / API で処理し、NIHO へ商品・予約の正本を追加しない。

## 画面が確認する結果

HTTP 200 だけでは完了扱いしない。既知の outcome と repeated、予約 ID 配列、返金 ID と既知の status を持つ応答だけを受け入れる。不正 JSON・未知 outcome・返金状態不明は、入力と同じ操作 UUID を保持して結果照合へ戻す。連絡では `CONTACT_SENT` を確認し、メール配信キューへの登録と配送成功を分ける。

route が閉じた404、rate limitの429、不正な拒否応答も、以前の実行が無かった証拠にはならないため同じcommandを保持する。型付きの400 `invalid_input` /409 `conflict` だけを業務拒否として扱い、入力・現在値の再確認へ戻す。401/403の機微情報消去は維持する。

送信済みの結果が不明な間は、内容の変更・別操作の開始・中止でその UUID を捨てない。確認ボタンは保存した同じ payload と UUID を再利用する。一部返金の応答が失われた後に金額だけを変え、新しい UUID でもう一件の返金を作る動作を防ぐ。

金融6操作は、入力後に `/admin/api/site-bookings/preview` で Experience Store の最新状態と台帳金額を読み、対象・今回返金額・処理後状態を表示してから実行する。preview と実行transactionは同じ決定的snapshotを使う。実行はpreviewの `expectedSnapshot` を必須とし、予約状態、受付時support同意、取消依頼、capture、既存返金（送信回数・closed・supersededを含む）のいずれかが先に変われば409で何も行わず、再previewを求める。同じcommand UUIDの完了結果照合はsnapshot再計算より先に行うため、自分の実行で状態が変わった後も既存結果を返す。

予約者への連絡は従来のmessages経路を使う。結果不明の `contactCommand` がある間は本文を編集せず、同じpayloadとUUIDだけを再送する。親画面は各パネルの安定owner IDとcommand UUIDを同期refの単一gateで照合するため、同じ予約が複数の返金行に出ても別パネルは操作を開始できない。金融フォームも開いた時点からこのgateを所有し、連絡と金融操作を相互に排他する。401/403では親子stateとgateを消去する。

この保持は現在のReact画面stateに限る。ブラウザーのreload・tab終了・端末再起動をまたぐdurable restoreは行わない。連絡本文はPIIになり得るため、URL、localStorage、sessionStorage、ログへ保存するレシートを今回追加しない。reload後に結果が不明な場合は、案件の操作履歴と配信状態を確認してから再操作する。

取消の保存と返金処理の進行は別々に表示する。

| API の返金状態 | 表示 |
| --- | --- |
| REQUESTED | Stripe への受付待ち。返金完了ではない |
| PENDING | Stripe で返金処理中 |
| FAILED | 失敗。返金状況の確認が必要 |
| 返された全件が SUCCEEDED | 今回の返金完了を確認 |
| 返金配列が空 | 取消／依頼の結果だけを表示し、返金完了や自動再送を推測しない |

返金を再送した同じ操作 UUID で返金配列が空になっても、別の自動処理が動作中とは断定しない。ジョブの稼働を検証していない環境で再送時刻を約束しない。401/403 は従来どおり機微な状態を消去する。

## 検証と有効化の境界

`site-booking-outcome.test.ts` と Admin site-bookings / case / notification の対象テストで、不完全な成功応答、返金状態の区別、現在 Admin、同 UUID、CAS、no-store を確認する。`settlement-reconciliation.test.ts` は Stripe 成功後に結果保存が失敗した場合の同 command 回復を確認する。

合成テストの成功は、本番返金・配送・三者受入の成功を意味しない。現在の環境では Admin console と新予約・公開・メールの feature 設定が未投入であり、NIHO の設定 PR はオーナー指示どおり Draft。固定 SHA 配備、現在権限、受付時 support snapshot、実 Stripe test mode・通知／履歴の機能受入は #121 / #128 に残す。実顧客への送信、実資金の課金・返金・送金を合成検証で発生させない。
