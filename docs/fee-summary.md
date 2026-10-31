# 予約別の料金・精算

対象: Issue #134。Adminとホスト本人が、NIHO APIで選別された同じ予約別summaryを読み取るための公開可能な運用境界である。決済・返金・Transfer・台帳の正本や新しい操作をこのリポジトリへ作らない。

## 契約と接続

- 正本は `packages/api-client/contract/experience-fee-summary-api.openapi.json` v1.0.0。source commitは`291bc1fca9a9e21ebaeae4a9637379afc472aa61`、SHA-256は`c7b39ac5ae5331268915f4b9b2ded477a09f35eb333a291a9826e6b8f3a9d95e`、状態は`agreed-not-deployed`。
- Admin/Hostとも固定GET、queryなし、`private, no-store`。Adminは専用の現在ADMIN session、Hostは既存のsealed sessionとID token期限を要求する。本人scopeと両host kindの所有権はNIHO APIが判断する。
- `EXPERIENCE_FEE_SUMMARY_API_ENABLED` はHTTP modeだけで有効。各console/authが無効ならBFFは閉じたままである。`EXPERIENCE_FEE_SUMMARY_PREVIEW_ENABLED` はmock UIとPlaywright browser stub専用で、BFFや合成成功fallbackを開かない。
- 401/403では保持していた金額を消し、再認証を案内する。別予約・別actor・手動再取得の遅い応答はgenerationとAbortControllerで破棄する。自動pollingはしない。

## 表示の読み方

- 受付時の総額とNIHO利用料は予約受付時のsnapshotで、サポートOFFは10%、ONは15%。いずれも決済費用込み。通訳・補助人件費は別で、必要な場合はホストから担当者へ直接支払う。
- 顧客への成功返金と処理中返金、残存売上に対応する利用料、NIHO利用料の返還、決済費用の補填、ホスト残額を別々に表示する。AdminだけがNIHO入出金差額を見られるが、利益とは扱わない。Host向けではAPIとBFFが`netNihoCashYen`と内部照合コード`reason`を常にnullへ投影し、ブラウザへ値を渡さない。
- 閲覧対象の金額が`null`なら未確認として扱い、0へ補完しない。Host向けのNIHO差額・内部照合コードのnullは閲覧対象外を表し、表示しない。`hostRetainedAfterCreditsYen`と`netNihoCashYen`の負数はそのまま表示する。全額返金時のホスト負担0もAPIが0を返した場合だけ表示する。
- `LEGACY_NOT_RECORDED`、`PREPARING`、`PROCESSING_COST_PENDING`、`PROCESSING`、`RESULT_UNKNOWN`、`REVIEW_REQUIRED`、`SETTLED`を区別する。表示から支払済み・入金済みを推測せず、契約の汎用`reason`文字列は内部詳細として表示しない。

## このサイトで受けた予約（#285・#84）

experience DB の予約（[guest-booking.md](guest-booking.md)）は、上の NIHO API の summary を読まない。ホストの予約の詳細の「料金・精算状況」は、予約の pricing snapshot と返金の記録から画面で組み立てる（`siteFeeBreakdown`、`apps/web/src/host/bookings.ts`。flag も BFF も無い）。

- 受付時：サポートの ON/OFF と率（10%・15%、決済費用込み）、予約者の支払い（`totalAmount`）、NIHO の手数料（`platformFee.amount`、store が `floor(合計 × 率)` で固定）、受取額（`providerAmount` = 合計 − 手数料）。手数料の記録が無い予約（snapshot に無い）は面を出さない。
- 返金があれば：予約者への返金（完了＝Stripe が終えた額、処理中は別の行）、NIHO の手数料の返還、返金後の受取額。手数料の返還は Stripe が返金額に比例して戻す規則（`refund_application_fee`、オーナー決定 2026-10-31）で、売上の台帳と同じ計算（`refundedFeeShare`、四捨五入）。一部返金は「概算」と添え、Stripe の計算と ¥1 ずれうることを書く。処理中の返金は、終わるまで手数料の返還と受取額に数えない。
- 通訳・補助の人件費は含まない（上と同じ注記）。入金済み・精算済みは推測しない（入金は Stripe の画面。[host-sales.md](host-sales.md)）。
- mock のプレビューは `?mock=site-bookings` のログインで合成の予約を出す。単体テストは `site-bookings.test.ts`（売上の台帳の計算と一致することも確かめる）、e2e は `host-bookings.spec.ts` の「this site's bookings」。

## 受入と現在の制約

合成E2Eでは320/360/PC、キーボード/axe、両host kind、ON/OFF/legacy/free/full/partial/pending/unknown/needsReview/nullと0、malformed/対象ID不一致/401・403/遅い別予約応答/明示再取得を確認する。実ブラウザNIHOログイン、実DB、外部API、Stripe、配備、メールは対象外である。

ホストの実予約HTTP画面はまだ未接続である。SDK・Host固定BFF・独立パネルが存在しても三者実受入完了とはしない。NIHO側のAPI先行配備、Admin実接続、Host実予約導線、両actorの本番権限確認が完了した後にだけflagを有効化する。
