# 商品・集客（担当3）の作業文書

作成日：2026-10-19。対象Issue：[#13 最初の商品](https://github.com/niho-life/niho-experience/issues/13)、[#14 計測・集客](https://github.com/niho-life/niho-experience/issues/14)、[#12 SEO](https://github.com/niho-life/niho-experience/issues/12)の検索・原稿・情報設計部分。

## 触る範囲と依存

| 項目 | 内容 |
| --- | --- |
| 触るファイル | `docs/content/**`、`docs/growth/**` のみ。コード、package、lockfile、共通設定は触らない（担当1） |
| 依存するAPI版 | なし。公開API契約（[#7](https://github.com/niho-life/niho-experience/issues/7)）は未確定のため、項目名はNIHOappの既存企画ページで観測した公開項目を参考にした仮称 |
| 他担当への依頼 | 計測イベントの実装は担当1、確定予約・売上・流入情報の保存は担当2。依頼事項は各文書の「他担当への依頼」に記載 |

## 文書

| 文書 | 内容 | 主なIssue |
| --- | --- | --- |
| [product-ledger.md](product-ledger.md) | 最初の候補5件と予備3件の台帳。確認済みの事実と確認待ちを分ける | #13 |
| [registration-handoff.md](registration-handoff.md) | 5商品のテスト設定と本番登録前の確認表、担当1・2への引き渡し | #13 #12 #14 |
| [editorial-review.md](editorial-review.md) | 英語の提供者紹介、写真枠ごとのalt案と権利確認欄 | #13 #12 |
| [guides.md](guides.md) | ガイド記事（`/guides`）の原稿の書式・下書きの置き場所・公開手順 | #145 #147〜#151 |
| [copy-guidelines.md](copy-guidelines.md) | 英語原稿の構成・表現ルール・事実確認 | #13 #12 |
| [photo-requirements.md](photo-requirements.md) | 写真の技術要件・権利・同意・商品別の撮影リスト | #13 |
| [booking-conditions.md](booking-conditions.md) | 料金・日時・言語・取消・天候・最少催行・遅刻の標準案（未適用） | #13 |
| [operations.md](operations.md) | NIHOと提供者の運営分担を一枚にまとめたもの | #13 |
| [../growth/funnel-measurement.md](../growth/funnel-measurement.md) | 予約ファネルのイベント契約と指標定義 | #14 |
| [../growth/analytics-decision.md](../growth/analytics-decision.md) | 計測ツール・同意の方式・保存期間の決定案 | #14 |
| [../growth/launch-kit.md](../growth/launch-kit.md) | 30日検証の文案・UTM付きリンク・QRの仕様（未承認の下書き） | #14 |
| [../growth/pilot-30day-plan.md](../growth/pilot-30day-plan.md) | 30日間の流入検証計画 | #14 |
| [../growth/search-research.md](../growth/search-research.md) | 検索量・競合の測定設定と観測記録 | #14 #12 |
| [../growth/seo-content-policy.md](../growth/seo-content-policy.md) | URL・title・canonical・構造化データの情報設計案 | #12 |
| [../growth/privacy-copy.md](../growth/privacy-copy.md) | 決定済み計測内容の公開文案（未掲載） | #14 |

## 公開・非公開の置き場

このリポは公開されている。次の情報は置かない。

| 置かないもの | 置き場 |
| --- | --- |
| 提供者の連絡先、交渉状況 | オーナー管理の非公開保管先 |
| 契約書、写真の利用許諾書・同意書の原本 | 同上 |
| 広告アカウント、Keyword Planner・GSC・OTA管理画面の数値 | 同上。公開文書には測定設定と判断結果だけを書く |

公開文書で提供者を指すときは、掲載の許可を得るまでは商品コード（P-01など）と分野だけを使う。

### テストサイト用のpilot fixture（オーナー決定 2026-10-19）

P-01〜P-05は、オーナーが各事業者から掲載の許可を得ている。そのため、英語原稿と提供者の紹介を、[テスト設定](product-ledger.md#テストサイト用の設定値)のpilot fixtureとしてテストサイトに組み込む。

- 価格・日程・取消などはテスト設定で、販売条件として確定していない。後でオーナーがまとめて修正する。
- 写真は未入手のため仮素材を使う。レビュー・販売実績・実際の残席は入れない。
- 本番では、承認済みの原稿をNIHO共通基盤に登録し、そちらを正本とする。pilot fixtureは本番の表示に使わない。
- テストサイトで表示するには `MOCK_CATALOG=pilot` を設定する（`EXPERIENCE_API_MODE=mock` のとき。既定は架空の合成データ）。フッター最下部の1行のプレビュー表記（上部の帯から移した。オーナー判断 2026-10-20）が「体験と提供者は実在、日程・価格・写真は仮」と表示し、検索には出ない。
- 事業者への連絡とSNS等への投稿は、本番運用の開始後にオーナーが行う。

## 状態の表記

- **確認済み（公開情報）**：出典URLと確認日がある公開ページの記載。提供実態の確認ではない。
- **確認待ち**：オーナーまたは提供者の回答が必要。回答までは原稿・条件として使わない。
- **提案**：担当3の案。オーナー承認まで適用しない。
