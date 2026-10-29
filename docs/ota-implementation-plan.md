# 統合カレンダーの残実装

2026-10-30。親 [#194](https://github.com/niho-life/niho-experience/issues/194)。オーナー承認の [ホスト画面モック](../idea/mock/host-channel-calendar-v1.html) を実装の基準にする。

## 合意

- PCは週の時間軸、携帯は日別予定。主操作は枠の追加・休止・再開。講師は担当する体験だけを扱う。
- 説明・補足は極力省く。掲載先の詳細は折りたたみ、判断に必要な失敗・不明な結果は短い状態表示にする。モックにだけある切替・架空の接続状態を製品へ入れない。
- NIHO保存と外部読戻しを分ける。現版・対象・時刻が確認できるまで反映済みにしない。通常時の同期目標は60分以内。予約照合は15分間隔から受け入れる。
- 価格はサイト別に設定する。金額差は同期エラーにせず、この機能では料金・手数料を読み替えたり書き換えたりしない。同期対象は開催日時と予約受付の状態とする。
- V1の接続対象はGetYourGuide・Airbnb・Viator（Tripadvisor）・じゃらん。Klook・KKday・アソビュー！・アクティビティジャパンは、オーナーの2026-10-30の指示でV2へ延期し、今回は接続しない。
- Claude Code / Maxの既存契約内で動かし、有料APIへfallbackしない。通常の決定的な操作で推論を必須にしない。
- NIHOapp側の関連PRはDraftを維持し、マージしない。Experience側は対象検証・レビュー・必須CIを通して順にマージする。NIHOapp未配備の契約に依存する本番flagは開かない。

## 実装単位と依存

| Issue | 内容 | 先行条件 | 完了の境界 |
| --- | --- | --- | --- |
| [#234](https://github.com/niho-life/niho-experience/issues/234) | 週/日カレンダー、枠の詳細、販路反映 | 既存カレンダー・権限・状態API | 実画面と合成E2E。本番pilotと分ける |
| [#235](https://github.com/niho-life/niho-experience/issues/235) | 外部account/listing台帳と資源設定の管理UI | 既存Store/API。運営者招待画面を再利用 | 実APIへの保存・版競合・認可の受入 |
| [#236](https://github.com/niho-life/niho-experience/issues/236) | 外部予約の正本と共有在庫への原子的取込み | 共有inventory mutex/outbox | 実DB・認証API・migration。実顧客取引を試験しない |
| [#237](https://github.com/niho-life/niho-experience/issues/237) | GetYourGuide/Airbnb予約読取りと15分照合 | #236、対応付け済み口座 | 完全性・認証・遅延を含むadapter受入 |
| [#238](https://github.com/niho-life/niho-experience/issues/238) | Google busyの資源別入力 | 共有資源、既存OAuth | 入出力分離・freshness・watch・失効の受入 |
| [#239](https://github.com/niho-life/niho-experience/issues/239) | Airbnb専用Google writerと独立readback | #238、Google/OTA対象対応 | Google ACKとAirbnb確認の区別、実空き回での復元 |
| [#240](https://github.com/niho-life/niho-experience/issues/240) | 常駐・heartbeat・監視・手動復旧 | 公開API/DB/認証の配備受入、#237/#239 | 1商品2販路pilot。コードのマージだけでcloseしない |
| [#241](https://github.com/niho-life/niho-experience/issues/241) | 新規回作成と日時変更の追跡 | 個別adapterの能力受入 | 既存回の開閉と別に証明する |

追加販路はそれぞれ独立して受け入れる。ViatorとじゃらんをV1の対象とし、残る4サイトはV2へ延期する。掲載アカウントや対象が無い間は対応済みと表示しない。

| Issue | サイト | 時期 |
| --- | --- | --- |
| [#242](https://github.com/niho-life/niho-experience/issues/242) | Viator / Tripadvisor（同じ販売在庫を重複登録しない） | V1 |
| [#243](https://github.com/niho-life/niho-experience/issues/243) | Klook | V2 |
| [#244](https://github.com/niho-life/niho-experience/issues/244) | KKday | V2 |
| [#245](https://github.com/niho-life/niho-experience/issues/245) | アソビュー！ | V2 |
| [#246](https://github.com/niho-life/niho-experience/issues/246) | じゃらん遊び・体験 | V1 |
| [#247](https://github.com/niho-life/niho-experience/issues/247) | アクティビティジャパン | V2 |

## 受入の順序

1. 現行APIへUIを接続し、既存の保存・競合・結果不明の回帰を確認する。
2. スタッフの対応表・資源設定をUIから保存できるようにする。
3. 外部予約の正本を実DBで受け入れ、予約読取り・定期照合を接続する。
4. 資源別Google入力とAirbnb出力を共通のdesired/versionへ結ぶ。
5. 公開API・認証・migrationを受け入れてから常駐・監視を有効化する。
6. 許可された空き回で停止・再開・復元を確認し、外部予約往復と無人運用の受入を分けて記録する。

未接続のサイトを合成画面で動かしただけでは個別adapterやpilotを完了にしない。実ID、cookie、credential、私用予定、顧客画面はGitへ保存しない。
