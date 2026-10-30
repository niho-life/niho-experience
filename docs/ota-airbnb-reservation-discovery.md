# Airbnb予約取込みの実画面調査（#312）

2026-10-31 JST。対象は許可済みの既存ホスト口座。Mac Studioの専用Google Chromeで本人確認と通常UIの読取りを行った。予約readerは未実装・未有効であり、本資料は実装済みの空き状況の照合と、未確認の予約取込みを区別する。

## 実装済みの範囲

[PR #306](https://github.com/niho-life/niho-experience/pull/306)でGoogleへの現在の配送を再確認し、[PR #310](https://github.com/niho-life/niho-experience/pull/310)でAirbnbへの反映待ち、Studioからの再照合、ホスト画面の状態表示を接続した。最初の配送確認から最大60分、約5分おきに新しいOBSERVEで確認し、期限を延長し続けない。画面は既存の掲載先の中に「反映待ち」「確認中」「反映済み」「要確認」を表示する。

Studioではレビュー済みSHA `db6df2d8189e280481c2a993d7daab30169b1119` による、実Chrome・実Airbnb・本物のclaim parser／executor／journalを通した読取りを確認した。対象と時刻の一致、受付可／不可および期待と異なる状態の振分け、結果送信前の停止、ACK後のjournal消去を確認した。Airbnbへの書込みとモデル呼出しは0回だった。

この検証のGoogle応答とNIHO cloud jobは合成である。実GoogleカレンダーからAirbnbまでの伝播、常駐運転、1時間以内という目標の達成、外部予約の自動取込みを受け入れた証跡にはしない。既存Studioの稼働版・設定・有効化flagは切り替えていない。

## 通常UIで確認した読取り元

本人のprofileを照合した後、画面に存在するリンクと操作から調査した。未観測の予約URLやAPIを推測して本番readerへ登録していない。

| 画面・応答 | 確認した構造 | 予約取込みに不足する根拠 |
| --- | --- | --- |
| 体験・サービスのカレンダー | `XSCalendarEventsQuery` の `ActivityHostCalendarContainer.iCalendarItemsConnection`。`ActivityListingCalendarInstance` は掲載・開始終了・人数・定員・受付可否等を持つ | 開催回の情報であり、個別の予約ID・取消状態・更新順序ではない |
| 開催回のカード | 通常UIでは「予約可能な席数を編集する」が開く。日時・料金・人数・保存・削除等の操作がある | 空き枠の編集画面を予約詳細と取り違えない。保存・削除は実行していない |
| `/hosting` の「今日」「今後」 | 初期表示のJSONに `presentation.hostReservationRequests` と `presentation.hostReservationTab` がある | 非空の予約行とその型は観測できていない。予約ゼロや完全取得の証明にはしない |
| `hostReservationTab` | `nowReservationEvents`、`nextReservationEvents`、`followUpReservationEvents`、`reservationListButton` の構造 | 取消済み・過去を含む期間指定、次ページ、全状態を取得し終えた証明は未確認 |
| `HostReservationsTabFiltersModalQuery` | ホスト画面が通常のGETで呼び出すことを確認 | フィルターの有効な内容と全状態の網羅性は未確認 |

カレンダーの `isAvailable=false` や `numGuests`、画面の空表示から外部予約を合成しない。`reservationEvents=null` も「全ページを取得した空配列」と解釈しない。Googleのbusy区間にも予約ID・人数・取消状態の根拠はない。

Airbnbの公式案内でも、体験予約の概要は[Todayから確認する](https://www.airbnb.com/help/article/3151)一方、[カレンダーは開催枠の追加・編集を行う](https://www.airbnb.jp/help/article/2645)ものとされている。[予約の仕組み](https://www.airbnb.jp/help/article/1560)には、体験の詳細に参加者セクションがあること、本人確認が完了しない予約が自動取消になる場合があることも記載されている。したがって、確定人数だけで受付中や取消を置き換える設計にはしない。これらのヘルプは導線の参考であり、未観測のAPI fieldやenumを確定する根拠には使わない。

## 読取り時の境界

- 本人の口座と対象掲載を確認した、専用profileのChromeだけを使う。
- 通常UIの調査では業務書込みを転送せず、WebSocketも接続しない。調査用のGET許可は本番予約readerのallowlistへ流用しない。
- deadlineと停止処理を維持し、読取り終了後は所有するbrowserを停止した。価格・定員・予約・取消・メッセージ・入金先は変更していない。
- 公開成果物にはschema名・field名・検証結果だけを残す。実口座ID、予約ID、顧客情報、header、raw応答、非公開カレンダーの内容は含めない。fixtureは合成データだけにする。

## #312の実装・有効化条件

予約実績の有無と、存在する場合の予約詳細への導線をオーナーへ確認中。予約を作成・取消して検証用データを増やす操作は行わない。

1. 通常UIの非空行で、外部予約ID、対象掲載・option、正確な開始終了とtimezone、人数、現在状態を確認する。更新時刻・revisionが存在する場合はその意味も確認する。
2. 過去の余白を含む対象期間、全状態、ページ送りを確認する。明示取消と日時変更を読めなければ、欠落を取消へ変換しない。
3. 実際に観測したquery・変数・field・状態だけを固定readerへ実装する。本人／掲載の照合、認証失効、未知の型・状態、deadline、停止失敗は成功にしない。
4. 既存の[期間read・manifest・page receipt・health](ota-reservation-read-plan.md)に接続し、合成の新規・変更・取消・欠落・順序逆転・部分取得・ACK喪失・再起動と、実DB・localhost Chromeで確認する。
5. 許可済み口座で非空予約、取消・変更、期間と全ページの完全性を受け入れてから、Studioの `reservationReaders` とserverの `canReadReservations` を段階的に有効にする。それまでは既定OFFを維持する。

Airbnbと他販路で掲載時刻が異なる場合の対応付けも、別途オーナー確認を待つ。同じ回かどうかをタイトルや日付だけで推測しない。NIHOapp側のDraft PRと、V2の掲載先には変更を加えない。
