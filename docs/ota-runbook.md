# OTA 運用 runbook（骨子）

対象: #194 の OTA（他販路の枠管理）を、stg・本番で有効にして運用するときの手順。**今は実環境で何も有効にしていない**（flag はすべて既定 OFF）。この文書は、有効にする前に読み、有効にしたあとに手元で使うためのもので、**実機で決める値は「【実機で決める】」の空欄のまま**です（決めたら埋める）。コードの仕組みは各設計書が正で、ここでは手順と、止める・戻す方法をまとめる。

| 見たいもの | 正の文書 |
| --- | --- |
| 仕組み・状態・監視 | [OTA runtime](ota-runtime.md) |
| Studio の worker・初回 login・固定 SHA | [OTA worker](ota-worker.md)、[Studio worker 設計](ota-studio-worker-design.md) |
| 外部予約の取込み・要対応・保持 | [OTA 外部予約台帳](ota-external-reservations.md) |
| Airbnb×Google | [Airbnb 公式 Google 経路](ota-airbnb-google-bridge.md)、[Google 出力](ota-google-output-protocol.md) |
| flag の配備 | [production-deploy.md「機能のフラグ」](production-deploy.md#機能のフラグ84) |

## 1. 前提（この運用でしないこと）

- **Studio が止まっても、外部で受付中の回が自動で閉じる保証はない。** 止まっている間は、NIHO 側の新しい OPEN だけが保留され、外部の既存の受付中の回は、実行機かスタッフが閉じるまで残る。Admin の稼働状況は「停止済み」とは表示しない（[OTA runtime](ota-runtime.md#監視heartbeat復旧)）。
- 価格・口座・契約・返金・予約取消・顧客へのメッセージは、worker は拒否する。実予約の取消や課金を試験に使わない。
- Max の契約内だけを使い、API キーへの切替や追加課金で上限を回避しない。
- 実アカウント ID・資格情報・画面・cookie は公開リポへ置かない（Git・Issue・PR・公開ログ）。

## 2. 有効にする前の確認

順序は [production-deploy.md](production-deploy.md#機能のフラグ84) の「OTA の flag」の注記が正。ここでは確認項目だけを挙げる。

1. 体験 DB の migration が、有効にする機能の分まで適用済み（外部予約は `0014_external_reservations.sql` から。[OTA 外部予約台帳](ota-external-reservations.md#保持db権限配備順)）。
2. **watchdog を先に有効にする**（`STG_` / `PROD_CHANNEL_WATCHDOG_ENABLED=true`）。runtime は watchdog と manager を必須とする（新しい OPEN の保留を watchdog が行うため）。
3. Cloud Scheduler `experience-ota-watchdog`（毎分）を**再開**する。今は一時停止中。再開前に、通知の alert policy 2つ（`experience-ota-runtime-incident`、`experience-ota-watchdog-scheduler-failed`）と通知先があることを確認する。【実機で決める：通知先の最終確認、当番】
4. Studio 側: 専用の OS ユーザーと private ディレクトリ、固定 SHA、専用 profile での初回 login（人が会社情報と空き枠を確認して Chrome を終了）、`healthcheck`（[OTA worker](ota-worker.md#private-config-と初回-login)）。【実機で決める：常駐の方法（LaunchAgent か LaunchDaemon）、OS ユーザー名、private ディレクトリ、再起動後に必要な操作】
5. 最初は adapters を「読取りと開閉」だけにする（`create` を付けない）。有効化は変数を変えて配備するだけ（候補を作り、確認してから昇格）。

## 3. 通常の見方

- **ホスト**（`/host/calendar`）: 反映済み／反映待ち／保留中／未確認／要確認の5つ。`反映済み` は `SYNCED` のときだけ。Google への書込みが済んだだけでは、Airbnb の反映済みとは表示しない。
- **スタッフ**（`/admin/channels`）: Studio の状態（稼働中／応答なし／停止／未接続）、保留、閉じられていない回の件数、account ごとの未反映件数と予約読取、未解決 incident と担当。表示中は30秒ごとに読み直す。
- **通知**: incident の開始・escalation・解決ごとに、Cloud Logging の `ota_runtime_incident` から通知が出る。件名に種別と状態が入る。

| incident | 意味 | まずすること |
| --- | --- | --- |
| `WORKER_STALE` | Studio の heartbeat が90秒超。新しい OPEN は保留中 | §4.1 |
| `SYNC_OVERDUE` | 未反映の希望が60分超（account 単位） | §4.2、§4.3 |
| `RESERVATION_READ_OVERDUE` | 予約読取が止まっている（60分超） | §4.2。復旧後に「予約照合を再開」 |
| `ACCOUNT_QUARANTINED` | account が隔離された | §4.3 |
| `EXTERNAL_RESERVATION_CONFLICT` | 2つの販路で同じ枠に予約が入った | 外部予約台帳の「要対応キュー」の手順（[OTA 外部予約台帳](ota-external-reservations.md#要対応キューと反映時間の計測)）。実予約の取消はこの運用の外 |

## 4. 障害別の手順

### 4.1 Studio が止まった・応答がない
1. Admin で、閉じられていない回の件数と、未反映の account を確認する。
2. **外部で受付中の回を、スタッフが外部サイトの管理画面で手動で閉じる。**（自動では閉じない。）手動で閉じる間は、同じ account の worker と同時に編集しない（Admin の「停止して手動対応」で account を隔離してから行う）。
3. Studio を再起動する。再起動しても古い OPEN は再送されない（現状を照合してから復帰する）。
4. 復旧後、Admin の「停止を確認して照合」（`recover`）で observe-first の照合を行い、手動で変えた状態を取り込んでから再開する。【実機で決める：Studio が再起動後に自動で立ち上がるか、スタッフが操作するか】

### 4.2 予約読取・反映が遅れている
1. Studio の稼働と、account の隔離の有無を確認する。
2. 認証切れなら §4.3。画面の変更（DOM のずれ）なら §4.5。
3. 原因を直したら、Admin の「予約照合を再開」（`retryReservationReads`）。halted で実行中の job のない listing だけが対象。

### 4.3 認証が切れた・再ログインが必要
1. worker は `AUTH_REQUIRED` で停止し、`worker-halt.json` が残る（再起動だけでは再試行しない）。
2. 専用 profile で人が再ログインする（CAPTCHA・2FA は人が行う。回避・自動化しない）。
3. Studio の停止と再ログインの両方を確認し、Admin の「再認証を確認して照合」（`confirmReauth`）。
4. 照合が済んだら、運営者が `worker-halt.json` を明示的に退避または削除して再開する。

### 4.4 Max の利用上限に達した
- worker は `RATE`（`NEEDS_REVIEW`）で停止し、`worker-halt.json` が残る。サイトの認証切れとは区別して扱う。
- **追加課金や API キーへの切替で回避しない。** 上限が回復するまで待ち、回復後に `worker-halt.json` を退避して再開する。待つ間に新しい OPEN が必要なら、スタッフが手動で扱う。
- 決定的な操作だけで動かす方式では、モデルを呼ばないので、この停止は起きない。

### 4.5 画面の変更・結果が確認できない
- 画面が変わって対象の ID が一致しない場合は、worker は別商品へ進まず停止する。`UNKNOWN_AFTER_SAVE`（保存後に通信が切れた）は、読み戻して確認できるまで成功にしない。
- 画面・SDK・モデルの版が変わったときは、そのサイトの接続を停止し、再受入する（§7）。

### 4.6 Viator の一時アクセス制限
- 検知したら job を止める。robot 確認の回避はしない。運営者が手動で確認し、解除してから、hold を明示的に解除し、`recover`（[OTA runtime](ota-runtime.md#viator-の一時アクセス制限-hold)）。

## 5. 止める・戻す

軽い順。**どの段階でも、すでに受理した予約と占有は消さない。旧 writer と同じ枠を二重販売しない。**

1. **1つの account だけ止める**: Admin の「停止して手動対応」（`pauseAccount`）。全 job の claim が止まる。
2. **Studio（worker）を止める**: 停止してプロセスを終了する。外部で受付中の回は残る（§1、§4.1）。
3. **Airbnb×Google の出力を止める**: 既存の Admin の pause を使う（出力の無効化の操作は、今は作っていない）。**Airbnb 側で、元の Google 連携に戻す手順**は、接続する前に記録した元の接続対象・用途・受付状態を使って、人が行う（[Airbnb 公式 Google 経路](ota-airbnb-google-bridge.md#7-既存接続からの切替)：writer 停止 → 現状照合 → 対応の変更 → 再照合。二重 writer を起こさない）。
4. **flag を OFF にして配備し直す**: 変数（`STG_` / `PROD_` の `CHANNEL_RUNTIME_ENABLED` など）を消すか `false` にして、新しい候補を作り、昇格する。依存の逆順に戻す: Airbnb×Google の各段 → RUNTIME → MANAGER。**WATCHDOG は最後まで残す**（Studio が止まる間の保護のため）。
5. **外部予約の取込みを止める**: adapter の `canReadReservations` を false にする（配備の allowlist → listing の順）。受理済みの台帳と占有は削除しない。
6. **Cloud Scheduler の `experience-ota-watchdog` を一時停止する**のは、flag を OFF にしたあと、または監視自体を意図して止めるときだけ。止める間は通知が出ないことを関係者に伝える。

## 6. 認証情報と証跡

- **認証情報の交換・失効**: worker の credential は、Admin から発行・回転・失効できる（失効すると以後の claim は拒否される）。外部サイトの資格情報は専用 profile だけに置き、パスワード・cookie の値を Admin やチャットへ入れない。【実機で決める：定期交換の周期、交換の担当、交換後の再受入の範囲】
- **証跡の保存**: 実アカウント ID・顧客情報・画面・cookie は非公開に置く（Git へ入れない）。公開してよいのは、機密を除いた集計だけ。【実機で決める：非公開の保存先、保存期限、削除の方法。debug 用の画面保存の削除期限】
- **台帳の保持**: 外部予約の台帳・版・受領・在庫のスナップショットは、初期は source の終了から7年。未終了・未解決・参照中のものは、7年を過ぎても解決前に消さない。予約者の情報だけは別の期限（[OTA 外部予約台帳](ota-external-reservations.md#予約者の情報194)）。
- **incident のログ**: `ota_runtime_incident` の構造化ログは、件数・経過秒・内部の理由コードだけで、外部の account ID・旅行者情報・token を含まない。

## 7. 再受入が必要な変更

次のどれかを変えたら、そのサイトの接続を停止し、合成画面と実機の限定的な確認をやり直してから有効に戻す。

- worker の実行 SHA、Node、SDK、browser、driver、adapter、model の版
- 外部サイトの画面（対象の ID・書込みの経路が変わった場合）
- adapters の allowlist（新しい能力を足す。特に `create`）
- Studio の OS・常駐の方法・profile の場所

確認は [OTA worker](ota-worker.md#staged-enable) の段階（合成 → 読取り1回 → 限定した開閉の往復 → 元の状態へ復元）に従う。検証用の回と販売条件は、**単に未来の日時だからテスト用、とはみなさず**、事前に決めたものを使う。

## 8. 実機で決める値（空欄）

| 項目 | 決めること | 値 |
| --- | --- | --- |
| 常駐の方法 | LaunchAgent か LaunchDaemon。画面ロック・再起動・FileVault の前後で必要な操作 | 【実機で決める】 |
| 実行ユーザー・private ディレクトリ | 専用 OS ユーザー名、`privateDir` のパス | 【実機で決める】 |
| 通知先と当番 | alert の宛先、通知を受ける人、夜間・休日の扱い | 【実機で決める】 |
| 再ログインの担当 | 認証切れ・CAPTCHA・2FA のとき誰が人の操作をするか | 【実機で決める】 |
| 認証情報の交換 | 周期、担当、交換後の再受入の範囲 | 【実機で決める】 |
| 証跡の保存 | 非公開の保存先、保存期限、削除の方法 | 【実機で決める】 |
| 最初の有効化の対象 | 最初の account・商品・検証用の回・販売条件 | 【実機で決める】 |
| 外部を閉じる手順 | 各サイトの管理画面で、手動で閉じる・開く手順（サイトごと） | 【実機で決める】 |

## 9. この runbook がまだ検証していないこと

- 実 Studio・実 OTA での停止・復旧の演習（Studio 停止、通信断、OS 再起動、認証切れ、画面変更）。各手順は、設計書と実装の記述から書いたもので、**実機で通して確かめていない**。最初の有効化のときに、演習として一度ずつ通し、食い違いを直す。
- 反映時間の集計、費用・予算の計測、Google 出力の接続の巻き戻しの操作は、今は作っていない（オーナー判断 2026-11-07：UI/UX に必須でないため）。必要になったら、新しい Issue で設計から行う。
