# ホスト設定の接続と受入

対象は #84、#109、旧 consumer PR #170、#379。Experience の現在のセッションと membership を正本とする。本作業は実装・対象検証・PRまでで、本番配備、実データの変更、flag の有効化は含まない。

## 調査で確認した状態（2026-11-08）

| 機能 | 既存実装 | 不足・原因 | 運用上の条件 |
| --- | --- | --- | --- |
| 通知設定 | migration 0020、`ProviderNotificationSettings`、server action、設定画面、Push の設定参照 | factory は flag OFF または DB 未設定で `null`。`loadHostConsoleData` は旧 NIHO session を持つ場合だけ読取を呼び、native session では呼ばない。OWNER 不足も準備中へ混同。メール producer は予約・取消・OTA のみで任意通知3種が未接続 | repository の GitHub 変数 `PROD_HOST_NOTIFICATION_SETTINGS_ENABLED` は未登録。配備テーブルでは未登録を OFF と扱う。Cloud Run の実値・DB の実レコードまではこの確認に含めない |
| チーム | `HostOperatingTeamPanel` と旧 NIHO provider operations v1 consumer | native session は旧 consumer が拒否。DB と native provider 一覧には COHOST がなく、flag のみでは完成しない | native 用 migration・コードの配備後に独立 flag を有効化して合成データで受入が必要 |
| 販売者表示 | `/host/seller` の NATIVE / EXTERNAL / WITHDRAWN、本人同意、version、結果不明 command の再送 | 設定に古い URL 入力と無効な「NIHO のページに表示する」が残り、専用画面と二重の導線 | 専用画面の既存正本・同意契約をそのまま使う。新しい代理表示や本番データ変更は不要 |

GitHub 変数は必要な boolean 名だけを読み取った。`PROD_HOST_ACCOUNTS_ENABLED` と `PROD_HOST_MAIL_ENABLED` は `true`。秘密、メールアドレス、顧客情報、口座、DB接続情報は証跡に含めない。

## 変更の不変条件

- 通知の変更は現在の OWNER だけ。GUEST_MESSAGE / DAY_BEFORE_SUMMARY / NEW_REVIEW だけ変更でき、必須4種は常に有効。通知先の確認とログインメールは別の仕組みのまま維持する。
- COHOST は開催枠・予約参照・ゲスト返信を担当する。本文・料金・販売者・口座・売上・法的同意・公開/停止/再開・チーム・通知設定・取消/返金は OWNER が行う。既存 EDITOR と商品限定 OPERATOR の権限を自動で広げない。
- チーム操作は現在の OWNER と対象の ACTIVE Experience account を transaction 内で確認する。OWNER はチーム API から変更・解除できない。既存 EDITOR / VIEWER を COHOST に上書きしない。
- チーム変更は version と UUID command で扱い、結果不明時は同じ送信内容だけを再送する。解除後の古い追加 command で再付与しない。
- 未登録の人は既存の ops 事前登録手順を案内する。完全一致の確認に上限を設け、任意の一覧・部分検索・無制限照会を提供しない。
- 権限解除は各 API と DB の再確認に反映する。開いた画面は定期・復帰時の再検証で私的な内容を消す。他の提供者の利用まで止める全セッション失効は使わない。
- 販売者の専用保存 API、同意版、CAS、撤回、公開読取境界、過去予約 snapshot は維持する。設定のプロフィール保存で販売者表示を迂回更新しない。

`HostNav.tsx`、`HostShell.tsx`、UI 整理モック、体験編集全体は今回の変更対象外。UI 側は通知・チームの部品と契約、販売者専用画面への導線を再利用する。

## 検証記録

実装前の対象 unit（通知 settings server、通知表示ルール、旧 provider operations server、host mail templates）: 4 files / 29 tests 成功。

実装後の対象検証:

- Web unit: 15 files / 289 tests 成功（native 通知の読取・保存・再読込、失効、DB障害、チーム API/契約/遅延応答、メール配信設定、配備フラグ）。
- PostgreSQL: 対象11 files / 118 tests 成功、skip 0（チーム CAS・実行者/送信内容の結合、OWNER/COHOST/EDITOR、別提供者、失効、必須通知、メール producer、商品限定運営者、取消/返金、runtime grants）。`createIsolatedDatabase` の合成データだけを使用。
- Playwright: 実コンポーネントを使う合成ブラウザ4件が成功。StrictMode の再マウント後の失効検出、提供者切替後の古い mutation 応答の無視、変更内容を確認できない200/503後の同一 command 再送、変更成功後の古い一覧による版番号の巻き戻し防止を検証した。テストは `e2e/host-settings-access.spec.ts`。外部への実通信・認証・メール送信はしない。
- メール関連4 files / 10 tests を追加確認（上記DB対象との重複あり）。ネイティブ受信者が停止された後は宛先を返さず、新しいメールも enqueue しない。
- Store/Web の型検査は成功。Web lint はエラーなし。今回発生した未使用変数を除去し、既存の `_operation` 未使用の警告は対象外として維持する。

## UI 整理側が使う接続先

- 通知: `HostNotificationPanel` / `notificationPanelView`、既存 `saveNotificationSettings`。3項目の変更だけを送る。状態は `live` / `disabled` / `unavailable` / `forbidden` / `expired` / `error`。保存成功は server の結果だけで判断する（明示的 mock preview は別）。
- チーム: `HostOperatingTeamPanel` の `mode="native"`。`/host/api/team/{providerId}/members` の GET、`/resolve` の POST、`/{hostAccountId}` の PUT/DELETE。`team-contract.ts` の厳密 decoder と、`commandId` + `expectedRevision` を使う。同意前に開催枠・予約者情報・返信へのアクセス範囲を示す。
- 失効: console layout の `HostMembershipGuard` と `renderedHostAccessFingerprint`。部品を配置し直す場合も、私的な画面全体を guard の children に置き、provider/role をまたぐ古い応答を再使用しない。
- 販売者表示: provider を維持した `/host/seller` へのリンク。既存専用フォームの公開同意・version・結果不明 command を使う。設定のプロフィール保存から URL を更新しない。

## 配備時に残る条件

レビュー済み SHA を固定し、migration `0068_host_team.sql` と更新済み runtime grants を先に適用する。native team は `EXPERIENCE_HOST_TEAM_ENABLED`（配備変数は `HOST_TEAM_ENABLED`）、通知は既存 `HOST_NOTIFICATION_SETTINGS_ENABLED` が必要。team は host console・DB・Experience host accounts を前提とする。通知メールは既存 host mail と job、確認済み宛先を使い、前日まとめは Push が OFF でも mail job が生成する。

staging の合成データで現行セッション・別提供者・権限解除・再送・任意通知 OFF/必須 ON を受け入れ、その後に本番で有効化する。本作業ではどちらの環境にも配備・flag 変更・実レコード変更を行っていない。

本文・料金・公開の編集は既存 OWNER 境界を維持した。別 worktree の体験編集画面と重複しないよう、native COHOST は開催枠・予約参照・返信に限定する。権限不足を機能の「準備中」と表示しない。

## 実装ルーティング記録

高難度・多量として固定 `exec-hard`（Sol high、profile の model は `gpt-5.6-sol`）の worker 1体へ委任。レビュー再修正は1回。本体が最終の権限比較・スコープ整理とブラウザ回帰テストを実施した。worker累計は input 34,314,157 / cached input 33,591,680（input の内数）/ output 120,128 tokens。CLI の非cached input + output 表示は842,605。レビューで、失効判定の基準時点、遅延応答、金融情報の DTO、実行者と再送内容の結合を修正した。次回は設定の各機能を短い実装 batch に分け、diff の反復で文脈を膨らませない。
