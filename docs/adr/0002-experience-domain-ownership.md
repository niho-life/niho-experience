# ADR 0002: 体験業務の正本を niho-experience に置く

> 2026-11-07: ホストの本人確認を NIHO アカウントで行うこと、NIHO を Connect 口座の正本とすること、Admin の認証を NIHO で行うことは、[ADR 0003](0003-experience-independence.md) で置き換えた。体験業務の正本を experience に置く決定はそのまま。

決定日: 2026-10-27、簡素化更新: 2026-11-04。対象: #84、#109、#330、#369 とNIHO共通契約。初期の「旧NIHO体験データを移す」前提は取り消し、商品と予約の移行はしない。

## 決定

体験コンテンツ、開催枠、予約、体験取引の状態・返金記録、体験提供者の権限は niho-experience が所有する。OWNER本人が `experience.niho.life/host` で商品を作り、公開・編集・停止・再開する。Google Calendar は予定の表示と新規受付停止の入力であり、体験枠の正本ではない。確定予約は、提供者が選んだ専用 Google Calendar に書き込める。旧 `niho.life/experiences/provider` は利用者がいないためデータ移行せず、Experienceの商品販売・予約経路から撤去する。

2026-11-04 追記（#330 / #369）: 提供者と体験の事前承認は廃止し、必要条件を満たした OWNER が同意して自分で公開・停止・再開する。通常の保存で掲載停止・再審査へ戻さない。公開版、公開条件の検証、運営停止はExperienceが所有する。NIHOは共通アカウントの本人と、その本人が使うConnect口座の状態だけを提供する。旧体験販売の利用者はいないため、商品移行・予約移行・二重販売切替を実装しない。公開版が無い商品は販売できず、Checkoutは有効なExperience公開版だけを使う。販売者と受取先は同一で、コミュニティディナーはいずれもPanasonic。「NIHOkamakura」はConnect口座の表示名である。詳細は [本人による商品作成と公開](../host-publication.md)。

NIHO アカウントを共通の本人確認に使う。既存の一度きりのコードによる `/host` ログインを維持し、NIHO の安定した user ID と experience 側の host/provider ID をサーバー側で結ぶ。NIHO の会員プロフィール・アカウント停止は NIHO が正本、体験提供者の操作権限は experience が正本とし、両方を確認して操作を許可する。NIHO アプリのアカウント設定から `/host` へ移動できるようにする。NIHO の cookie と experience の cookie は共有しない。

Stripe Connect のプラットフォームと、OWNERの販売者口座をNIHOアプリと共用する。NIHOは口座の接続・本人確認・readinessの正本を持つ。Experienceは、現在のログイン本人と同じ販売者の口座をサーバー契約で受け取り、価格、申込、席確保、Checkout、webhook、返金、取引台帳を所有する。支払先・販売者・手数料・取消条件は各予約にsnapshotする。コミュニティディナーはPanasonicが販売者かつ受取先で、Stripe表示名は販売者の別名として扱わない。NIHOが同じ口座の体験取引を誤処理しない webhook 境界は受入で確認する。

公開 Git リポジトリ `niho-experience` に画面、サーバー API、非同期処理、選別した契約、DB migration と合成テストを置く。初期は既存の Next.js サーバーの Route Handler を体験 API として使い、運用上の必要が出たときだけ独立サービスへ分離する。リポジトリの公開は本番の実行環境、顧客データ、資格情報の公開を意味しない。体験専用 DB、Secret Manager、サービス ID、バックアップを NIHOapp の業務 DB から分離する。初期 pilot の GCP project は共有でも、本番の体験データを保存する前に専用 project への移行を評価する。

体験固有の開催枠・予約・決済正本を `niho-app` に追加しない。NIHO 側の変更は共通アカウントの導線と、本人・販売者口座の限定された参照契約に絞る。秘密を保存する目的で private Git リポジトリを作らない。公開できない業務コードや非公開契約が具体的に発生した時のみ、体験専用の private リポジトリを追加する。外部配布が必要になるまで、同じリポ内の契約 package は npm SDK として公開しない。

## NIHO 企画ページと Experience の予約を分けて扱う（2026-11-08、最新決定）

オーナーは、NIHO アプリの企画ページからの予約は NIHO 内の予定・予約として扱い、Experience からの予約は Experience で扱うと明示した。同じ体験のコンテンツページが NIHO と Experience の両方にあってもよい。ページの併存を理由に、予約受付・在庫を統一したり、NIHO の受付を閉じたり、予約入口を Experience へ強制的に切り替えたりしない。

Experience のホストカレンダーに表示する予約は Experience の予約である。開催枠・在庫・Google Calendar 連携も Experience 内で完結し、NIHO アプリの枠へ書き戻さない。Google の予定を表示・空き判定に使う場合も、外部の予定として扱い、NIHO の予約を Experience の予約に複製・再分類しない。

NIHO 側の予定・予約・決済・確認・取消／返金は NIHO に残す。Community Dinner の併売承認と、既存 NIHO・GetYourGuide の停止や在庫同期を Experience の受付開始条件にしない決定は維持する。NIHO の企画ページの予約が NIHO 内の予定へ登録される経路の実装・受入は、Experience カレンダーへの統合とは別に扱う。

先に記録した「NIHO の Dinner 受付を Experience へ統一する」案は、この最新決定で撤回する。[NIHO #19966](https://github.com/niho-coliving/niho-app/issues/19966) と [PR #19968](https://github.com/niho-coliving/niho-app/pull/19968) は保留とし、PR は Draft のままマージ・配備しない。受付統一の変更は本番に反映していない。

## 記事の責任分界（2026-11-03、#251 / #254 / #255）

記事本文・画像・下書き・版・公開操作はEditorクラウドへ統一する。NIHOは現在の記事ライター権限と記事連携の招待・同意・取消、Experience Storeはカテゴリと現在の提供者OWNER・公開中体験を所有する。writer grantをExperienceへ複製せず、旧台帳へfallbackしない。Experienceの旧`/editor`認証・書込を閉じ、保存済みデータは保持する。

公開版の関連体験と体験側の関連記事は、現在のNIHO権限とStoreのOWNER・掲載状態を表示のたびに合わせて確認する。失効時は関連表示を止め、本文を削除・自動停止しない。記事ライターの同意は商品・予約・顧客・売上の権限を与えない。[記事連携契約](../editor-article-authority.md)を参照する。

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

支払い完了のリダイレクトだけで予約を確定しない。Stripe webhook の署名を検証し、同じイベントの再送・順序違いでも予約と在庫・売上を二重に更新しない。予約には作成時の支払い参照、販売者、金額、条件をsnapshotする。

## CI と配備

公開 PR は合成データだけを GitHub-hosted runner で検証する。本番の鍵・DB・Google 接続先を渡さず、fork PR のコードを self-hosted runner で実行しない。保護された `main` のレビュー済み固定 SHA を鍵なしで build し、別の配備 job だけが OIDC と最小権限の配備 ID を受け取る。配備後は同じ image digest を昇格する。API 実行、非同期 job、DB migration は個別の配備権限を使い、migration は先行互換の順に適用する。

## 自己公開の受入

1. NIHOの現在の認証本人、OWNER権限、同じ販売者のConnect口座・readinessを、サーバーからのみ得る。ユーザー入力のID・Stripe口座参照を権限判断に使わない。
2. OWNERが商品、販売条件、開催枠、写真をExperienceに作成し、サーバー検証後に公開する。保存時は有効な公開版を維持し、停止・再開は本人の明示操作とする。
3. 合成データで作成・公開・通常編集・停止・再開・予約条件snapshot・同slugの重複公開・開催枠の二重在庫拒否を受け入れる。
4. NIHOの本人・Connect契約が欠落・期限切れ・不整合の場合は公開・Checkoutを閉じる。古いNIHO商品・予約をExperienceへコピーしたり、旧販売を開き直したりしない。

以前の移行・切替案は [retired cutover note](../experience-sales-cutover.md) に記録し、実装経路から削除する。記事・Google Calendar・OTAの独立機能はそれぞれの契約を維持する。
