# ホストの売上（このサイトで受けた予約）

[#91](https://github.com/niho-life/niho-experience/issues/91)（Epic #84）の http mode の設計。[ADR 0002](adr/0002-experience-domain-ownership.md)（2026-10-27）で取引の正本が experience に移ったので、このサイトで受けた予約（[guest-booking.md](guest-booking.md)、#285）の売上を、提供者の OWNER が `/host/sales` と `/host/home` で experience DB の台帳から読む。読むだけで、台帳への書き込みは決済の webhook と返金（#285 第2〜7b段）が行う。

## 何を読むか

- **台帳**：`payment_ledger_entries`（`0001`）のうち、このサイトの予約（`booking_guests` のある予約で、ホストに見せる状態 `CONFIRMED`・`PAYMENT_REVIEW`・`CANCELLED`）の行。
  - 入金（`PAYMENT_CAPTURED`）：予約者の支払い。確認待ち（`PAYMENT_REVIEW`）の支払いも、販売者の口座に入っているので売上に入れる（明細は「確認待ち」）。
  - 返金（`REFUND`、負の額）：Stripe が受けた返金（処理中・済み）。Stripe がまだ受けていない返金（`REQUESTED`）は台帳に無いので入れない。
  - 返金の取り消し（`ADJUSTMENT`、`refund-reversal:{返金 ID}`）：受けたあとで Stripe が失敗にした返金。お金と手数料が戻る。
  - それ以外の `ADJUSTMENT`・`DISPUTE`：今は書く経路が無い。現れたら「調整」として額のまま出し、手数料は動かさない。
- **NIHO の手数料**：予約の pricing snapshot の `platformFee.amount`（予約を受けた時点の率。サポート OFF 10%・ON 15%、決済手数料込み）。Checkout の `application_fee_amount` と同じ値。
  - 入金：手数料をそのまま。
  - 返金：Stripe は返金額に比例して手数料を戻す（`refund_application_fee: true`、オーナー決定 2026-10-31）。戻る額は「返金のあとの累計 × 手数料 ÷ 入金」から「返金の前の累計 × 手数料 ÷ 入金」を引いた額（それぞれ四捨五入、整数で計算）。全額返金は手数料の全額が戻り、何回に分けても返し切れば手数料は 0 になる。一部返金は Stripe の計算と 1 円ずれうるので、明細に「（見込み）」、集計の下に注記を出す。
  - 返金の取り消し：戻した分をまた取る。
  - 手数料が分からない（snapshot に無い、入金が snapshot と違う通貨）ときは null。0 で補わない（[fee-summary.md](fee-summary.md) と同じ考え方）。
- **受取額**：各行の「額 − 手数料」の合計＝売上 − 手数料 − 返金 + 調整。販売者の Connect 口座の残高に入る額（Direct charge。決済手数料は NIHO の手数料に含む）。
- **月**：日本時間の暦月。台帳の `occurred_at`（Stripe のイベントの時刻）が `YYYY-MM-01T00:00+09:00` 以上、翌月 1 日 0 時未満の行（日本は夏時間が無いので常に +09:00）。月を動かせる範囲は、その提供者の最初の行の月から今月まで。範囲の外の `?month=` は今月を開く。
- **通貨**：集計は円だけ。円以外の行は明細に通貨のまま出し、「集計に含めていません」と注記する（このサイトの商品は円だけ。確認待ちの支払いで起こりうる）。

## 出さないもの

- **入金（payout）を台帳から作ること**：銀行口座への入金の予定と実績は Connect 口座の情報で、experience の台帳は持たない。このサイトの集計には「入金予定」「入金済み」を入れない。入金は下の「この口座への入金」として、Stripe から読んだものを別に出す。
- **NIHO で売っている商品の売上**：まだ NIHO で販売している体験の売上は NIHO の台帳にあり、ここには混ぜない。画面の上に「このサイトで受けた予約の売上です。NIHO で販売している体験の売上は含みません。」、ホームのカードに「このサイトで受けた予約の分」。
- 予約者のメールアドレス、Stripe の ID（入金・イベント・返金・口座）。行のキーは `payment:{予約 ID}`・`refund:{返金 ID}`（このサービスの ID）などで、Stripe の ID はブラウザに渡らない。予約者の名前は保存期間（体験の 1 年後）までで、消したあとは体験名だけ。

## 誰が読むか

予約の画面と同じ二重の確認：NIHO がそのアカウントを提供者の OWNER と言い（コンソールの提供者一覧）、experience DB にも現役の OWNER membership があり、NIHO の役割の上限で下げられていないこと（`requireBookingsOwner`）。EDITOR・サブホスト・商品限定運営者は今までどおり売上の画面が無い（404）か、ホームに売上のカードが無い。store が OWNER を認めなければ今までの画面（準備中）のまま。

## 経路

- store：`GuestBookingRepository.listGuestSalesForHost(actor, { from, to })`（`packages/experience-store/src/host-sales.ts`）。窓は 92 日まで、1 回で 5,000 行まで（超えたら読み込みの失敗にする。切り詰めた集計は出さない）。index と migration は足さない（提供者ごとの行が少ないうちは `(provider_id, booking_id, occurred_at)` の index で足りる）。runtime role の権限も増えない。
- 画面：`apps/web/src/host/site-sales.ts`（集計と文言。純粋な関数）と `site-sales-server.ts`（読み込み）。`/host/sales` は「売上・手数料・返金・（調整）・受取額」と明細、`/host/home` は今月の「売上・返金・受取額・支払い」。
- 状態：読込中（OWNER の確認のあとで月を Suspense で流し、その間は「売上を読み込んでいます…」。`loading.tsx` は使わない：先に 200 で流し始め、OWNER 以外の 404 が返せなくなるため）、空の月（「この月の売上はまだありません」と 0 円）、読めなかった（「売上を読み込めませんでした。…」／ホームのカードは「今月の売上を読み込めませんでした。」）。受取口座が準備できていないときは、今までどおり上に案内と「口座を設定」。
- flag：`HOST_SALES_LEDGER_ENABLED`（http mode と `HOST_CONSOLE_ENABLED=true` が要る。既定 `false`）。`EXPERIENCE_DATABASE_URL` が無ければ準備中のまま。予約の flag（`EXPERIENCE_GUEST_BOOKING_ENABLED`）とは独立：このサイトでの販売を止めたあとも売上は読める。
- mock mode：今までの合成の台帳（NIHO の形：入金予定・入金済みつき）のまま。プレビューの `?mock=site-sales` のサインインだけ、合成の台帳（`apps/web/src/host/mock/site-sales.ts`）でこの画面を出す（e2e：`apps/web/e2e/host-sales.spec.ts`）。

## この口座への入金（`HOST_SALES_PAYOUTS_ENABLED`）

mock の「入金予定・入金済み・口座入金」に当たるものを、Stripe から読んで出す。

- **何を読むか**：提供者の Connect 口座の残高（`GET /v1/balance`）と、着金日（`arrival_date`）がその月の入金（`GET /v1/payouts`、1 回 100 件まで）。どちらも `Stripe-Account` を付け、プラットフォームの鍵 `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY` で読む。GET だけで、Stripe に何も書かない（`readConnectedPayouts`、`packages/experience-payments`）。
- **どの口座か**：experience DB で、その提供者の「このサイトで売る商品」（販売条件のある商品）の `stripe_connect_account_ref` と、このサイトの予約の seller snapshot の口座（`listPayoutAccountsForHost`。OWNER の確認つき、5 口座まで）。ふつうは 1 口座。2 口座以上なら合計し、「Stripe の口座が N つあり、その合計です。」と注記する。
- **見せ方**：この口座には NIHO で売った分の入金も入るので、このサイトの集計・明細の下に、見出し「この口座への入金」の別の区画として出す。区画の先頭に「Stripe の口座に入る入金です。NIHO で販売している体験の分も同じ口座に入るため、このサイトの売上・受取額とは一致しません。」。
  - 今月：「入金予定」（Stripe の残高の available と pending、送金中の入金の合計）と「入金済み」（今月に着金した入金）。今月は、来月に着く送金中の入金も明細に出す。
  - 前の月：「入金済み」だけ。
  - 明細：着金日（日本時間）ごとに「口座入金」（負の額は「口座からの引き落とし」、赤字）、状態は「送金中」（`pending`・`in_transit`）・「入金済み」・「入金できず」・「取消」。Stripe は入金済みのあとで失敗にすることがあり、読んだ時点の Stripe の状態を出す。
  - 円以外は明細に通貨のまま出し、集計に入れない（注記）。100 件を超える月は「一部だけ」と注記する。
- **失敗・遅いとき**：区画だけを別に Suspense で流す。このサイトの集計・明細は先に出て、Stripe の失敗で消えない。読込中は「この口座への入金を Stripe から読み込んでいます…」。
  - Stripe の 1 回の要求は 3.5 秒・再試行 1 回、全体で 8 秒まで。過ぎたら「Stripe の応答が遅いため…」。
  - 口座が見えない（権限・接続が無い）ときは NIHO サポートへの案内、ほかの失敗は「時間をおいて、もう一度お試しください」。どちらも「Stripe で入金の明細を見る」を添える。
- **出さないもの**：Stripe の ID（口座・入金。行のキーは入金 ID の SHA-256 の先頭 16 桁）、銀行の情報、明細の表記、失敗の理由の文。ログは失敗の種類（`StripeConnectionError` など、`unreachable`）だけで、Stripe の応答・メッセージは出さない。
- **flag**：`HOST_SALES_PAYOUTS_ENABLED`。http mode で `HOST_SALES_LEDGER_ENABLED=true` と `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY` が要り、無ければ起動失敗。既定 `false`（区画は出ない）。mock mode はプレビューの `?mock=site-sales` だけ、合成の入金（`MOCK_SITE_PAYOUTS`）で出す。

## 受入（flag を入れる前）

1. staging で、`0030`・`0031` まで適用した DB に合成の予約を作り、全額返金・一部返金・返金の失敗（取り消し）・確認待ちの支払いを通す。画面の売上・手数料・返金・受取額が Stripe（テストモード）の Connect 口座の残高の動きと合うことを確かめる。一部返金の手数料の戻りが Stripe の値と何円ずれるかを記録する。
2. 月末の 23 時台（日本時間）の支払いがその月に入ることを確かめる。
3. OWNER 以外（EDITOR・サブホスト）と、experience DB の membership が無い OWNER で、売上が出ないことを確かめる。
4. この口座への入金（`HOST_SALES_PAYOUTS_ENABLED`）：staging の Stripe テストモードで、テストの Connect 口座（日本の口座は銀行番号 `1100000`・口座番号 `0001234` で入金が成功、`1111116` などで失敗）に入金を作り、入金予定・入金済み・送金中・入金できずが Stripe のダッシュボードと合うことを確かめる。鍵が口座を読めないとき（別のプラットフォームの口座）に「NIHO サポートへ」の案内になること、Stripe の ID がページの HTML・RSC の payload・ログに出ないことを確かめる。日本の口座の既定の入金スケジュールは手動なので、自動の入金が無い口座では入金予定が残高だけになる。
