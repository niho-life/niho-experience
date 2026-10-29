# Viator・じゃらんの枠開閉の実証

2026-10-30。対象はオーナーがログインしたNIHOの既存アカウント。実ID・認証情報・顧客画面・通信原文は公開しない。関連: [Viator #242](https://github.com/niho-life/niho-experience/issues/242)、[じゃらん #246](https://github.com/niho-life/niho-experience/issues/246)。

## 確認済み

| サイト | 対象 | 操作 | 復元の確認 |
| --- | --- | --- | --- |
| Viator | 予約のない将来の1商品・1option・1日時 | 予約可能 → 完売 → 予約可能 | 同じ行の読戻しと再読込み後の同一日時 |
| じゃらん ACTIVITY BOARD | 予約のない将来の1プラン・1日時 | 販売 → 売止 → 販売 | 「最新の情報に更新」後の同じslot |

料金、手数料、予約受付方式、受付制限は変更していない。価格はサイトごとに設定する。金額の不一致は予約枠の同期エラーにせず、価格の同期もしない。

この実証は、ログイン済みブラウザから対象1回の開閉が成立することを示す。Studio workerからの無人実行、予約取込み、常駐監視、複数販路の60分以内の追従は未受入。adapter実装とそれぞれの受入が終わるまで対応済みにしない。

## Viator adapterへの要件

- `supplier.viator.com/availability/`。選択した日付と表示中の先頭日が一致するとは限らず、月初から行が読み込まれる。入力日だけで操作対象を判定しない。
- 対象行の「予約を表示」のリンクにある日付・商品・optionと、行の開始時刻を照合する。必ず一意な行に限定し、「すべてに適用」を使わない。
- 受付停止は「完売」、再開は「予約可能」。「催行なし」は予約・開催取消につながるため対象外。
- UIの更新要求は `/availability/update`。`availabilityKeys` は対象商品・option・日付・開始時刻の1件だけ、`isBulkUpdate=false`、状態は `AVAILABLE` / `SOLD_OUT` のみ。`prevAvailability` と現在の行を照合する。付随する表示状態も実画面のsnapshotに固定する。任意のJSONや複数回の更新を受け付けない。
- 保存直後には古いDOMが残る。ACKと同一対象の新しい読戻しを分け、価格や予約取消の要求をnetwork guardで拒否する。
- Tripadvisorの商品を同じViator在庫で販売する場合、別の在庫として二重登録しない。

## じゃらん adapterへの要件

- ログイン入口と販売管理画面のoriginが異なる。枠操作は `activityboard.jp/activityboard/bookingStockMgt/`。想定外のoriginや再ログインは停止して本人へ戻す。
- 日付inputの文字列を変えただけでは、販売カレンダーが更新されない場合がある。datepickerで選択し、表示日・プラン・時間帯・slotの対応まで確認する。
- 対象slotを1件だけ選び、選択数 `1/14` を確認する。販売ステータスだけを変える。受付制限・予約受付タイプは「変更しない」。日毎一括や臨時不催行は使わない。
- 可視DOMに対応する空き状況の読取りは `/stateful/schdl/client/summary`。表示日列と選択プラン・時間帯のslot配列、slotIdを突き合わせる。JSONP内の認証情報・入場照合コードは保存DTO・ログへ出さない。
- UIの更新要求は `/stateful/schdl/client/complete`。`groups=[]`、`slots` は1件だけ。変更を `frontOpenFlg` に限定し、slotとプランの版、予約方式、受付制限は直前snapshotと一致させる。料金など追加field、異なるslot、複数選択は拒否する。
- `KeyOPEN` と `frontOpenFlg`、予約方式、受付締切を区別する。売止解除のACKだけで実際に予約可能と断定しない。更新後は別の取得でslotを読み直す。

## 次の受入

1. 合成fixtureで対象取り違え・複数回・価格変更・取消操作を拒否する。
2. 専用profileと現行worker認証に接続し、lease/version/preflight/停止証明/独立readbackを通す。
3. サイトごとの予約読取りと完全性・遅延を検証する。未取得を予約ゼロと扱わない。
4. オーナーの許可した空き回でworkerから停止・再開・復元を実証する。
