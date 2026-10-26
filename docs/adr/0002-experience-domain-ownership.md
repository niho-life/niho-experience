# ADR 0002: 体験業務の正本を niho-experience に置く

決定日: 2026-10-27。対象: #84、#109 と旧 NIHO 連携契約。オーナー決定に基づく。新しい experience API は v1 として設計し、NIHO の公開 API 1.0〜1.2 は移行元とする。

## 決定

体験コンテンツ、開催枠、予約、体験取引の状態・返金記録、体験提供者の権限は niho-experience が所有する。提供者は `experience.niho.life/host` で体験とカレンダーを管理する。Google Calendar は予定の表示と新規受付停止の入力であり、体験枠の正本ではない。確定予約は、提供者が選んだ専用 Google Calendar に書き込める。旧 `niho.life/experiences/provider` の編集画面はデータ移行後に撤去する。

NIHO アカウントを共通の本人確認に使う。既存の一度きりのコードによる `/host` ログインを維持し、NIHO の安定した user ID と experience 側の host/provider ID をサーバー側で結ぶ。NIHO の会員プロフィール・アカウント停止は NIHO が正本、体験提供者の操作権限は experience が正本とし、両方を確認して操作を許可する。NIHO アプリのアカウント設定から `/host` へ移動できるようにする。NIHO の cookie と experience の cookie は共有しない。

Stripe Connect のプラットフォームと、すでに接続された提供者口座を NIHO アプリと共用する。NIHO は販売者口座の本人確認・接続・状態の正本を持つ。experience は NIHO が確認した販売者口座の参照と readiness をサーバー間契約で受け取り、体験の価格、申込、席確保、Checkout、webhook、返金、取引台帳を所有する。支払先・販売者・手数料・取消条件を各予約に snapshot する。既存の Direct charge を維持する案を優先し、NIHO が同じ口座の体験取引を誤処理しない webhook 境界を受入で確認する。販売条件や資金責任を変える場合は charge 方式を改めて決める。

公開 Git リポジトリ `niho-experience` に画面、サーバー API、非同期処理、選別した契約、DB migration と合成テストを置く。初期は既存の Next.js サーバーの Route Handler を体験 API として使い、運用上の必要が出たときだけ独立サービスへ分離する。リポジトリの公開は本番の実行環境、顧客データ、資格情報の公開を意味しない。体験専用 DB、Secret Manager、サービス ID、バックアップを NIHOapp の業務 DB から分離する。初期 pilot の GCP project は共有でも、本番の体験データを保存する前に専用 project への移行を評価する。

体験固有の開催枠・予約・決済正本を `niho-app` に追加しない。NIHO 側の変更は共通アカウントの導線と、本人・販売者口座の限定された参照契約に絞る。秘密を保存する目的で private Git リポジトリを作らない。公開できない業務コードや非公開契約が具体的に発生した時のみ、体験専用の private リポジトリを追加する。外部配布が必要になるまで、同じリポ内の契約 package は npm SDK として公開しない。

## コードと実行境界

| 場所 | 正本と権限 |
| --- | --- |
| `apps/web` | 公開 SSR、ゲスト予約画面、`/host` の UI とサーバー Route Handler。価格・在庫・権限はサーバーで確定する |
| `packages/experience-store` | NIHO の認証済み user ID と体験 host のひも付け・体験権限、商品、繰り返し枠、予約と在庫の原子的更新、取引台帳 |
| 非同期 job（初期は同じ image の別起動） | Google busy 同期、確定予約の予定反映、通知と再試行。入力は冪等に処理する |
| `packages/experience-domain` | 日程・例外・予約可否の純粋な規則。web の表示と API の判定は同じ契約を使うが、最終判定は API のトランザクション内で行う |
| NIHO 共通アカウント・販売者口座 | ログイン・アカウント停止、Stripe Connect の口座接続と readiness。NIHO への変更は狭い契約を先行配備する |
| 体験専用 DB・Secret Manager | 体験と予約の実データ、Google OAuth 資格情報、体験用の限定された Stripe・Google の秘密、暗号鍵。Git・公開CI・fixture に置かない |

Google の私用予定の件名・説明・参加者は公開 API、検索、計測、ログ、予約レコードに出さない。busy 判定に必要な時間帯だけを保持する。接続が失効したり同期が古い時は、Google で塞ぐ設定の枠を安全側に止める。既存の確定予約は自動取消しせず、衝突を提供者に知らせる。

支払い完了のリダイレクトだけで予約を確定しない。Stripe webhook の署名を検証し、同じイベントの再送・順序違いでも予約と在庫・売上を二重に更新しない。過去の予約の支払い参照、販売者、金額、条件は移行時の snapshot として保持する。

## CI と配備

公開 PR は合成データだけを GitHub-hosted runner で検証する。本番の鍵・DB・Google 接続先を渡さず、fork PR のコードを self-hosted runner で実行しない。保護された `main` のレビュー済み固定 SHA を鍵なしで build し、別の配備 job だけが OIDC と最小権限の配備 ID を受け取る。配備後は同じ image digest を昇格する。API 実行、非同期 job、DB migration は個別の配備権限を使い、migration は先行互換の順に適用する。

## 移行と公開ゲート

1. 旧データを棚卸しし、NIHO user ID・体験 provider ID・販売者口座、商品、繰り返し枠・例外、予約、支払い・返金を対応付ける。接続済み口座の再利用は NIHO の本人・口座状態確認と提供者の同意を経る。
2. 新旧を合成データと staging で比較し、同じ開催回を両方の checkout で売らない切替手順と切戻しを作る。
3. 新しい認証・Google OAuth 同意・Stripe 構成、バックアップ、監査、返金・障害対応の受入が終わるまで本番受付を開かない。
4. 旧編集画面を read-only にして最終差分を移し、公開・受付を experience 側へ切り替える。旧予約の照会・返金責任が解決してから旧 API 依存を削る。

既存の `docs/architecture.md`、`docs/api-contract.md`、`AGENTS.md` と #84・#109 は以前の NIHO 正本設計を記録している。この ADR の決定が後発である。各移行 PR で現行状態と目標状態を明示し、旧契約を削除するまで混在を隠さない。
