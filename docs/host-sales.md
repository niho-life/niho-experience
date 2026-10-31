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

- **入金（payout）**：銀行口座への入金の予定と実績は Connect 口座の情報で、experience は持たない。「入金予定」「入金済み」は作らず、「Stripe で入金の明細を見る」へ案内する。
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

## 受入（flag を入れる前）

1. staging で、`0030`・`0031` まで適用した DB に合成の予約を作り、全額返金・一部返金・返金の失敗（取り消し）・確認待ちの支払いを通す。画面の売上・手数料・返金・受取額が Stripe（テストモード）の Connect 口座の残高の動きと合うことを確かめる。一部返金の手数料の戻りが Stripe の値と何円ずれるかを記録する。
2. 月末の 23 時台（日本時間）の支払いがその月に入ることを確かめる。
3. OWNER 以外（EDITOR・サブホスト）と、experience DB の membership が無い OWNER で、売上が出ないことを確かめる。
