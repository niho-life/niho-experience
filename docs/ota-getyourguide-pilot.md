# GetYourGuide：予約枠の開閉経路の実機確認

確認日：2026-10-29。関連：[#195 PoC](https://github.com/niho-life/niho-experience/issues/195)、[#199 Studio worker](https://github.com/niho-life/niho-experience/issues/199)、[#194 Epic](https://github.com/niho-life/niho-experience/issues/194)。

## 確認した範囲

オーナー指定のログイン済みBraveで、指定商品にある未予約の開催回を1件選び、受付中→停止→再読込→受付再開→再読込を1往復した。最終状態は元の受付中へ復帰した。定員、締切、価格、予約、商品原稿を変更していない。

これはCodexからのブラウザ操作による管理画面の経路確認である。Studioでの専用セッション、Claude SDK、クラウドjobの受信・返却はまだ通していない。#195の合成画面20回・実サイト5往復・障害試験を完了したものではない。

実アカウントのメール、外部ID、検証日時、画面画像は公開Gitへ保存しない。オーナーへの報告と非公開の検証記録で対応付ける。

## 画面から分かったこと

- `Manage → Availability` に日付、商品、option、状態のフィルタがある。
- 同じ商品に複数optionが存在する。商品タイトルだけで操作先を決められない。
- 開催回はoptionと現地日時で区切られ、各回に `Block` のswitchがある。
- switch操作は直ちに保存される。変更後に別の一括保存ボタンを押す方式ではない。
- 停止後は `aria-checked=true` と `Not Bookable`、再開後は `aria-checked=false` と `Bookable` を確認できた。どちらもページ再読込後に確認した。
- 締切による `Not Bookable` もあり、同じ回で `Block=false` のままの場合がある。**Bookableラベルだけから手動停止状態を推測しない**。
- 定員を変える `update` と締切を変える `update` が別にある。枠開閉adapterはこれらを操作しない。
- DOMに `toggle-accept-bookings-{optionId}-{localDateTime}` 形式の `data-testid` と、その中の `role=switch` があった。API保証された識別子ではないため、将来の変更時は停止する。

## 最初のadapterの契約

1. 登録されたaccount・商品・option・timezone・日時を入力として受け取る。モデルや画面の文章に別の対象を選ばせない。
2. 日付で絞り、option＋日時の一意な行と商品リンクを照合する。0件／複数件／異なる商品は保存しない。
3. switchの `aria-checked` と予約・定員・締切の表示を読む。`0 / N` 等の数字は意味を接続時に固定し、将来の表示変更を残席へ勝手に変換しない。
4. 希望する停止状態と現在値が一致すれば変更しない。不一致の場合だけ保存直前preflightを通す。
5. `SET_CLOSED` はBlockをtrueへ、`SET_OPEN` はfalseへ設定する。既にtrueの状態へ反転クリックを再送しない。通常コードで識別・設定できる箇所ではLLMを呼ばない。
6. 操作後に再読込し、同じ対象のswitchと販売可否・閉鎖理由を観測する。操作直後の画面だけでは成功にしない。
7. timeoutで保存結果が不明なら `UNKNOWN_AFTER_SAVE`。読取から再開し、状態を確認するまで再クリックしない。

OPENの成功には「手動Blockを解除した」状態と「実際に予約可能」の区別が必要。締切、満席、他の在庫接続、掲載停止等が残っていれば、クラウドへその観測理由を返す。UIは短い状態ラベルを出し、必要な操作だけ表示する。

## 次に実証すること

- Studioの専用profileで同じ権限を利用できること。今回のBraveのcookieを開発用profileから抽出・複製しない。
- site別の書込み対象をdriverで限定し、別商品・定員・価格・予約取消へ進まないこと。
- job認証、lease、保存直前preflight、結果返却の往復。
- 予約成立・取消による在庫復元、他の接続方式との優先関係。
- 1回1組の販売単位と現在の商品optionが適合すること。既存の参加人数制を1組制とみなさない。
- ログイン切れ、画面変更、保存後通信断、Studio再起動からの復旧。

上記の成立後に、対象を限定して無人運用へ進める。管理画面の1往復だけで全販路対応・常時稼働を保証しない。
