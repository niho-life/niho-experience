# 予約ファネルのイベント（画面側）

[#14](https://github.com/niho-life/niho-experience/issues/14) のうち、画面が出すイベントの約束。計測ツール（GA4等）、同意の取り方、30日の実験計画、指標の分母・重複排除の定義は担当3と決める。実装は `apps/web/src/lib/analytics.ts`。

## 現状

- Umamiの方式は決定済み。本番のHTTPモード・正規origin・Website IDが揃った環境だけで送信する。実際の本番設定・受入とは区別する。
- プレビュー（mock）では、ブラウザ内の `window.__nihoEvents` に記録し、開発者ツールのconsoleにも出す。E2Eで内容を検証している。
- 確定予約・売上は数えない。Checkoutへ進んだことは売上ではない。確定予約と売上は、NIHO共通基盤の確定データ（webhook後の台帳）を正にする。

## イベント

| イベント | いつ | 値 |
| --- | --- | --- |
| `list_view` | 一覧を表示 | `theme`（テーマのAPI絞り込みはv1.2）、`date_filtered`、`result_count` |
| `experience_view` | 詳細を表示 | `experience`（slug）。v0.1のSSR詳細応答には残席がないため、availability は送らない |
| `slot_continue` | 日時・人数を選び「Continue」 | `experience`、`guests` |
| `booking_form_view` | 見積が取れて予約入力を表示 | `experience`、`guests`、`total_jpy` |
| `booking_unavailable` | 見積が取れず予約入力を出せない | `experience`、`error_code` |
| `checkout_start` | 画面側の入力確認を通り、Checkout要求を送る | `experience`、`guests`、`total_jpy` |
| `checkout_error` | 決済へ進めなかった | `experience`、`error_code`（`invalid_contact` / `slot_sold_out` / `unavailable` 等） |
| `host_view` | 提供者向けページを表示 | `signup_mode`（`pilot` / `open`） |
| `host_start` | 提供者の開始・問い合わせリンクを押した | `signup_mode` |

決済後の確認・復帰はNIHOが担当するため、このサイトでは支払結果のイベントを数えない。

## 個人情報を送らない仕組み

- イベントごとに許可した値だけを残し、それ以外は捨てる。
- 文字列は英小文字・数字・`-`・`_` の64文字以内のコードだけを通す（公開体験slugは大文字も許可）。氏名・メール・メモ等をイベントへ渡さず、自由文やURLの形の値も除く。
- 予約入力の値、見積ID、idempotency key、URLのquery はイベントに含めない。
- v0.1の公開APIは一覧のテーマ/日付絞り込みやSSR残席を返さないため、それらを実行した扱いのイベント値を作らない。
- 計測ツールを入れる時は、ページビューのURLから `/experiences/*/book` と `/booking/*` のqueryを取り除く。session replay（画面録画）は予約入力・決済復帰で使わない。
- 計測の失敗や拒否で予約が止まらない（送信は投げっぱなしで、例外を握りつぶす）。
- ホストの画面（`/host/*`。紹介ページの `/host` は除く）は計測しない。別の root layout で、計測の script も読み込まない（#84）。
- 送信直前にもDNTを確認する。読み込み待ちイベントは発生時の安全なURLを保持し、移動先の予約URLに付け替えない。待機中にDNTが有効なら送信せず破棄する。
- Umami payloadを公開ルート・固定のページ種別タイトル・Website ID・hostname・screen・language・originのみのreferrer・許可イベントで再構成する。生のtitle・distinct ID・tag・未知の追加項目は捨てる。未対応ルート、異なるorigin、認証情報・別portを含むURLは送らない。
- API契約のslug制約は3〜64文字。大文字やアンダースコアの体験も計測を止めない。それ以外の文字を含むslugは生の文字列を送らず、URLを `/experiences/_experience`（予約は末尾 `/book`）にまとめ、イベント自体は残す。

送信項目とhookは [Umami公式の送信仕様](https://docs.umami.is/docs/api/sending-stats) と [Tracker設定](https://docs.umami.is/docs/tracker-configuration) を参照。外部scriptの固定SHA-384やCSP、計測サービスの設定はこの変更で更新しない。

## 計測ツールを決めた後の作業

1. 計測ツール・同意方式・保存期間は [analytics-decision.md](growth/analytics-decision.md) で決定済み（広告タグや有料契約は別途授権後）。
2. `AnalyticsSetup`（`apps/web/src/components/Analytics.tsx`）は本番ドメイン・HTTP APIモード・`UMAMI_WEBSITE_ID` がそろう時だけUmamiを読み込み、previewは `window.__nihoEvents` への記録だけにする。
3. 自動click収集を止め、手動pageviewと許可済みファネルイベントだけを送る。`data-before-send` でイベント名・URLを検査し、クエリ・予約結果識別子・hash・リファラーのpath/queryを除去する。
4. CSPの `script-src` にscript取得先、`connect-src` に収集先を追加する（`apps/web/next.config.ts`）。Tracker scriptのSHA-384 SRIも更新時にレビューする。
5. 計測をブロックしても一覧→予約→決済が動くことをE2Eで確認する。
6. ファネルの分母と重複排除を決める。例：`booking_form_view` から `checkout_start` までの率は、同じ見積で重複を数えるか。確定予約は共通基盤のデータと突き合わせる。

## Experience公開設定（#70）

- GA4はNIHOapp #19255の `GET /api/public/experiences/site-settings` が返すExperience専用の公開設定だけを使う。`siteId`・承認origin・production-only gate・preview無効を閉じた形で検証し、未設定・不正・通信失敗なら読み込まない。
- GA4は承認originの安全なページビューだけを送り、既存の予約ファネルイベントや売上・確定予約は転送しない。page location/titleは既存Umamiと同じ公開ルートallowlistで再構築し、予約結果ID・query・hash・自由入力を送らない。DNT時はタグ自体を読み込まない。
- Search Console確認metaは本番のホームページだけに出す。DNS方式、未確認、無効設定では出さず、設定APIの解除後はSSRでmetaを返さない。
- GA4 web data streamでは、自動履歴pageviewとURLを送るEnhanced Measurementを無効にする。実際のGA4/GSC設定、ポリシー公表と本番HTMLの受入はEが行う。GA4 IDやSearch Console確認値が設定されるまでは公開タグは出ない。
