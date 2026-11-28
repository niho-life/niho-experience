# ホストの売上の受け取り方（設計・Epic #700 段階3）

オーナー決定 2026-11-28。用語は [用語集](glossary.md)。今の販売プランは [体験ごとの販売プランと精算](experience-sales-plans.md)。

## 決めたこと

お金の流れを 2 つだけにする。

| | NIHO が受けて、あとで送る | 本人の Stripe で直接 |
| --- | --- | --- |
| プラン | サポート 15%（ホストが販売者、NIHO が代わりに受け取る） | 独立 10%（ホストが販売者） |
| 始めるのに要るもの | Stripe は要らない。最初の売上を受け取る前に、受取口座（Stripe Express）を登録する | 本人の Stripe アカウント（Standard。本人が Stripe のダッシュボードを持つ） |
| 決済 | NIHO の Stripe で受ける（プラットフォームの決済） | ホストの口座で直接（Direct charge。今の作り） |
| ホストへのお金 | 体験が終わったあと、予約ごとに受取口座へ Transfer。銀行への入金は Stripe の入金スケジュール（月 1 回） | すぐホストの Stripe 残高に入る。入金は本人の設定 |
| 返金・異議申立ての損失 | NIHO。体験の前は送金前なので、返金は NIHO の手元から | ホスト本人（本人と Stripe の契約） |
| Stripe の決済手数料 | NIHO が料率の中から払う | 本人の口座で引かれる（独立 10% は、今どおり NIHO が Transfer で補う。料率の見直しは別に判断） |

- **おまかせ 20%**（NIHO が販売者）は、今の作り（NIHO の決済と、月末締め・翌月末払いの手での銀行振込、`managed_provider_compensations`）のまま変えない。提供者のログインも Stripe も要らない前提を守る。受取口座への Transfer に寄せるかは、3b のあとで別に判断する。
- 受取口座は Stripe の **Express**（`controller.losses.payments=application`、`fees.payer=application`、`requirement_collection=stripe`、`stripe_dashboard.type=express`）。本人確認と銀行口座は Stripe が扱い、Experience は身分証も口座番号も持たない。**Express の口座では決済を作らない**（Stripe はプラットフォーム負担の Express に Direct charge を推奨していない）。
- 独立 10% の本人の口座は **Standard**（`stripe_dashboard.type=full`、`losses.payments=stripe`、`fees.payer=account`）。Direct charge は Stripe が Standard に推奨する組み合わせ。
- 今のホストの口座と決済の方式（15%・10% の Direct charge）は変えない。新しい作りは、新しい販売プランの版から使う。
- ADR 0003 §2 の「新しい販売者の口座は Express」は、この文書の 2 つの流れに改める（3a の PR で ADR に追記する）。

### 前提（NIHO 側の作業）

- Stripe のダッシュボードで、プラットフォームが損失を負うことの確認と同意。プラットフォームは NIHO と共有なので、Connect の設定（Express の機能・Stripe から Express の利用者へのメール・ブランド）は niho-app にも効く。口座ごとの controller と capability は、API で口座ごとに指定する。
- 本番の Experience 専用キーに、Accounts・Account Links の書き込み（3a）、Transfers と Transfer reversal の書き込み（3b）の権限を足す。
- Connect の料金（口座ごとの月額・入金ごとの料金）は NIHO の負担になる。日本の料金を確かめる。
- 法務の確認（3b）：サポート 15% で、ホストが販売者のまま NIHO が代金を受け取る（代理受領）ことを、ホスト規約に入れる。下の「3b」の論点を弁護士に確かめる。

## 段階

| 段階 | Issue | 内容 |
| --- | --- | --- |
| 3a | #710 | 受取口座（Express）を、ホスト画面から自分で登録する |
| 3b | #725 | サポート 15% を NIHO で受け、体験のあとに予約ごとに送る |
| 3c | #726 | 独立 10% で、本人の Stripe アカウント（Standard）をつなぐ（3b に依存しない） |

flag `EXPERIENCE_HOST_CONNECT_ONBOARDING_ENABLED`（既定 OFF）。**本番では 3b が入るまで OFF のまま**にする（3a だけでは、登録した口座でお金を受け取れないため）。

## 3a 受取口座（Express）の登録

### 誰に出すか

- 設定 › 受取口座 に「受取口座を登録する」を出すのは、そのホスト（provider）の**オーナー**で、そのホストに **Direct charge の販売者プロフィール（`experience_host_seller_profiles`）が無い**とき（自分で登録したホストなど）。今の販売者のいるホストの画面は変えない。
- 直近 30 分のログインが要る（ADR 0003）。1 人のホストアカウントが複数のホストを持てるので、口座はホスト（provider）ごと。

### 口座の作成

- サーバーが `accounts.create` を呼ぶ：
  - 国 `JP`、上の controller、`capabilities.transfers.requested=true`。
  - `business_type` は入れない（個人事業主は Stripe では `individual` なので、ホストの種別からは決めない。Stripe の画面で選ぶ）。
  - 入金スケジュールは月 1 回（`settings.payouts.schedule`）。
  - `metadata.provider_id`・`metadata.creation_id`（下の行の ID）・`metadata.source=niho-experience`・`metadata.purpose=payout`。
- **確かめること（実装の前提。stg の test mode で）**：日本のプラットフォームが持つ日本の口座の service agreement は `full` だけ。`full` のまま `transfers` だけを要求して作れるか、`capabilities.transfers` が `active` になるか、登録画面で何を集めるかを確かめる。`card_payments` も要ると分かったら、要求に足し、その口座で決済を作らないことをサーバーで縛る（設計に追記する）。
- 口座 ID はブラウザから受け取らない。作った口座は `experience_connect_accounts` に記録する：
  - 列：`id`（作成の ID）、`provider_id`、`purpose`（`PAYOUT`）、`stripe_account_ref`（作成中は NULL）、`creation_params`（Stripe の冪等キーで呼び直すときに同じ値を渡すため）、`created_by_host_account_id`、`created_at`、`retired_at`・`retired_by`。
  - 有効な行（作成中を含む）は、ホストと用途ごとに 1 つ：`UNIQUE (provider_id, purpose) WHERE retired_at IS NULL`。
  - runtime の権限は INSERT と、`stripe_account_ref` の UPDATE だけ。trigger で「NULL から値へ 1 回だけ」に縛る。行は消さない。退役は運営の経路。
- 二重作成を防ぐ（advisory lock は要らない）：
  1. `INSERT … ON CONFLICT DO NOTHING` で作成中の行を入れる（入らなければ、既存の行を使う）。
  2. transaction の外で、行の `id` を冪等キーにして、保存した `creation_params` で `accounts.create` を呼ぶ。
  3. 作成中の行に口座 ID を入れる（`stripe_account_ref IS NULL` の条件つき）。
  4. 途中で落ちたら、次の操作が同じ冪等キーと同じパラメータで呼び直す。呼び直せるのは作成から 23 時間（`submitSettlementTransfer` と同じ）。過ぎたら `accounts.list({ created: 作成時刻の前後 })` で `metadata.creation_id` が一致する口座を探して結び付け、見つからないときだけ運営の確認にする（新しい口座は作らない）。
- そのあと Account Link（`type=account_onboarding`）を作って Stripe の画面へ送る。`return_url` は設定 › 受取口座、`refresh_url` は新しい Link を作り直すルート（オーナーのセッションだけ）。

### 状態

- `return_url` に戻ったことは完了を意味しない。サーバーが口座を読み直して状態を出す（画面を開くたびに読む）。
- 「受け取りに使えるか」（payout-ready）は、Direct charge の販売者の判定（`retrieveConnectedAccount` の `ready`。`charges_enabled` などを見る）とは**別の関数**にする。次をすべて満たすときだけ「使える」：
  - 国 `JP`・通貨 `jpy`、controller が上の値、`metadata.provider_id` がこのホスト。
  - `details_submitted`・`payouts_enabled`・`capabilities.transfers=active`、`requirements.currently_due`・`past_due` が空。
- 画面の状態と文言（説明は増やしすぎない）：
  - **未登録**：「受取口座を登録する」
  - **入力の途中**（`details_submitted=false`）：「Stripe で続きを入力する」
  - **確認中**（`pending_verification` がある、または `payouts_enabled=false`）：「Stripe で確認中です」
  - **追加の情報が必要**（`currently_due`・`past_due` がある）：「Stripe で入力する」
  - **止まっている**（`disabled_reason` が `rejected.*`）：「この口座は使えません。事務局にお問い合わせください」
  - **登録済み**（payout-ready）：「売上を受け取れます」と「Stripe で見る」（Express ダッシュボードのログインリンク）。3b-2 で「受取口座の登録が済みました」から変えた。銀行口座の末尾 4 桁は出さない（`external_accounts` を読む権限を増やさないため）。
- Express ダッシュボードのログインリンク（`stripe-login`）は、どの口座を開くかをサーバーが用途で選ぶ（Direct charge の販売者の口座か、受取口座か）。受取口座は `experience_connect_accounts` から取る。

### Webhook

- Connect の webhook（今の `/api/experience/stripe/webhook`、署名の秘密は今のもの、`event.account` 必須）で `account.updated` を受ける。
- `experience_connect_accounts` に無い口座のイベントは、何もしないで 204。
- 自分の口座のイベントを受けたら、イベントの中身ではなく、**その場で `accounts.retrieve` で読み直して**状態を保存する（`event.created` は秒単位で、登録中は同じ秒にイベントが続くので、順序に頼らない）。冪等の表は作らない。
- 追加の情報が新しく必要になったら（`details_submitted` のあとに限る）、ホストへメールで知らせる。outbox の重複しない鍵は「口座と要件の状態のハッシュ」にして、同じ状態で 2 通送らない。

### 運用

- Express ダッシュボードには Stripe の直接のログイン（`express_login`）があり、NIHO のセッションを通らない。ホストのオーナーが代わったときは、口座を退役して新しいオーナーが作り直す（手順を [host-operations.md](host-operations.md) に書く）。
- Stripe が Express の利用者へ送るメールと、NIHO のメールが重ならないか、stg で確かめる。

### 3a の実装（#710）

- **flag**：`EXPERIENCE_HOST_CONNECT_ONBOARDING_ENABLED`（配備変数 `HOST_CONNECT_ONBOARDING_ENABLED`）。OFF の間は、新しい 2 つの route（`POST /host/api/payout-account/onboarding?providerId=`、`GET …/onboarding/refresh?providerId=`）は 404、画面と Webhook は今のまま。ON でも、Direct charge の販売者プロフィールのあるホストの画面は変わらない（`/host/api/stripe-login` は、まず販売者の口座を開き、無いときだけ受取口座を開く）。
- **テーブル**（migration `0095`）：`experience_connect_accounts`（有効な行は `(provider_id, purpose)` に 1 つ。`stripe_account_ref` は NULL から値へ 1 回だけ・UNIQUE。DELETE は trigger が拒む）、`experience_connect_account_snapshots`（最後に Stripe から読んだ状態。`state`・`payout_ready`・`details_submitted`・`payouts_enabled`・`transfers_active`・要件のハッシュ・`read_at`。古い読み取りは新しいものを上書きしない）。runtime は行の INSERT と `stripe_account_ref` の UPDATE だけ。退役は `scripts/experience/retire-connect-account.mjs`（移行の権限）。
- **作成の流れ**：POST（同一 origin・直近 30 分のログイン・OWNER・販売者プロフィールが無い）→ 行を `ON CONFLICT DO NOTHING` で確保（`creation_params` を保存。行の `id` が `metadata.creation_id` と Stripe の冪等キー `experience-payout-account:<id>`）→ 行に口座 ID が無ければ `accounts.create`（作成から 23 時間まで。過ぎたら `accounts.list` で `metadata.creation_id` を探し、無ければ「事務局に問い合わせ」）→ 口座 ID を 1 回だけ書く → Account Link へ 303。Link の URL は JSON にもログにも保存にも出さない。`return_url` は `/host/settings?providerId=…&connect=return`（開くたびに読み直すので、戻っただけでは完了にしない）、`refresh_url` は上の GET。
- **payout-ready**（`retrievePayoutAccountStatus`。`retrieveConnectedAccount` とは別）：国 JP・通貨 jpy・controller と `metadata`（`provider_id`・`source`・`purpose`）が期待どおり、`details_submitted`・`payouts_enabled`・`transfers=active`、`currently_due`・`past_due`・`pending_verification` が空、`disabled_reason` が `rejected.*` でない。国・通貨・controller・metadata が違う口座は、状態が「止まっている」になる。
- **画面の状態**：照合の結果が `REJECTED`（`rejected.*` か、上の不一致）→「この口座は使えません」／`details_submitted=false` → 入力の途中／`currently_due`・`past_due` あり → 追加の情報が必要／それ以外で `pending_verification`・`payouts_enabled=false`・`transfers` が active でない → 確認中／すべて満たす → 登録済み（`READY`。このときだけ `payout_ready`）。
- **Webhook**：Connect の webhook に `account.updated` を足す。`verifyConnectWebhook` が署名と `event.account` だけを見て、`experience_connect_accounts` に無い（または退役した）口座は何もせず 204。自分の口座は、イベントの中身ではなく `accounts.retrieve` で読み直して保存する。読み直せないとき・保存できないときは 503（Stripe が再送する）。冪等の表は作らない。
- **メール**：状態が `ACTION_REQUIRED`（`details_submitted` のあと）になったとき、Webhook の読み直しだけが、オーナーへ「受取口座に追加の情報が必要です」を積む（outbox の重複しない鍵は `payout-account-attention:<行の id>:<要件のハッシュ>`。同じ状態で 2 通にならず、別の要件なら新しく積む。画面の読み直しでは積まない）。本文は何が必要かを書かず、設定 › 受取口座 へのリンクだけ。Stripe の URL は入れない。送るときに、行が退役・状態が変わった・宛先が無いなら送らずに閉じる。
- **受入の手順**：stg の test mode で実際の `accounts.retrieve` の応答（作った直後と各段階）を取り、テストの fixture と照合する。controller の `fees.payer` は `application` と `application_express` の両方を受け入れる（SDK の型にある。Express はこの値で返ることがある）。作った直後が「入力の途中」になることを確かめる。
- **再認証と読み直し**：`refresh_url` の GET も、直近 30 分のログインが要る（古ければ POST と同じく再認証へ）。Stripe が口座を見せない（`unreachable`）ときは、最後に保存した状態ではなく「確認が必要」を出す（保存した状態に戻すのは、一時的な失敗のときだけ）。売上・ホームは受取口座を Stripe から読まず、何も保存しない。
- **メール**：メール job の段は `EXPERIENCE_HOST_CONNECT_ONBOARDING_ENABLED` が ON のときだけ動く（migration 0095 より先にコードが配備されても失敗しない）。積むかどうかは「いま保存されている状態が、`details_submitted` のあとの ACTION_REQUIRED で、その要件ハッシュのメールがまだ無い」で決める（画面の読み取りが先に新しい状態を保存しても、Webhook でメールが積まれる）。メールの payload に要件ハッシュを入れ、送るときに現在の状態と違えば、古い要件のメールは送らずに閉じる。
- **未確認の Stripe の仕様**（stg の test mode で確かめる。[production-deploy.md](production-deploy.md) の前提 5）：`full` のまま `transfers` だけで日本の口座を作れるか／`settings.payouts.schedule`（月 1 回、`monthly_anchor=1`）を作成時に渡せるか／`default_currency` が作成直後から `jpy` か（不一致の判定は null を許している）／`controller` の応答の形（`losses.payments`・`fees.payer`・`requirement_collection`・`stripe_dashboard.type`）。

### 3a に含めないこと

- 決済・Transfer（3b）。3a の口座は、登録しても予約の受付の条件にはならない。
- 既存の販売者プロフィール（`experience_host_seller_profiles`）と、受取口座の利用同意（`provider_payout_account_consents`）は変えない。どちらも Direct charge の販売者のもの。

## 3b サポート 15% を NIHO で受けて、体験のあとに送る（代理受領）

3b-1（代理受領で売る）と 3b-2（送金）の 2 つの PR に分ける。お金が出ていく部分を別にレビューし、stg で確かめるため。台帳は予約から後で作れるので、依存は 3b-1 → 3b-2 の一方向。

### 判定を 1 か所に（`sales-kind.ts`）

- 決済の方式（`chargeMode`）は `PLATFORM` のまま。販売者が誰かを `salesKindOf(seller)` の 1 か所で決める：
  - `MANAGED_20`（NIHO が販売者）
  - `AGENT_15`（`PLATFORM`・`SUPPORTED_15`・`sellerParty=PROVIDER`・1500 がすべてそろうときだけ）
  - `DIRECT`
  - `null`（`sellerParty` の無い `PLATFORM` で 20% でないもの。拒む）
- SQL の断片も同じファイルに置く。古い予約の snapshot に `sellerParty` は補わない（これまでの `PLATFORM` は 20% だけなので、NIHO と読む）。
- 今のコードで `MANAGED_20` を条件にしている箇所（報酬・事務局の下書き・承認後決済・20% のメールなど）は、代理受領では拒む側に倒れる。そのままでよい。
- プラットフォームの決済であることだけを前提にしている箇所（Checkout の確認・platform webhook・返金・異議申立ての記録・事務局の対応）は、代理受領でも同じに動く。
- 必ず直す箇所は次の 3 つ。
  - `createPlatformCheckout` が 20% 以外を拒むこと
  - 受付を始める検査（`blockers`）が Direct の分岐へ流すこと
  - 販売者プロフィールの無いホストが、特定商取引法の表示を保存・公開できないこと

### 3b-1 代理受領で売る

- **データ（migration 0096）**
  - 販売プランの版に `seller_party`（`plan` から計算する生成列。20% は `NIHO`、ほかは `PROVIDER`。既存の行は計算で埋まる）を足す。代理受領だけで必須の `payout_delay_days`（1〜30）と `receiving_agent_name`（NIHO の正式名）も足す。
  - 版の CHECK（0071）を作り直して、`SUPPORTED_15` + `PLATFORM` + 1500 + `OWNER_WEB` + 販売者参照 `agt_…` の組を許す。既存の 3 組は新しい列が NULL。
  - 代理受領の同意の履歴 `provider_agent_sales_consents`：
    - 列は `seller_ref`（`agt_` + 32 桁の 16 進）・版・同意したオーナー・時刻・撤回。
    - 有効な行はホストごとに 1 つ。同じホストの `seller_ref` は変えない。削除しない。
    - 特定商取引法の表示の中身は `provider_seller_disclosures`（NATIVE）を正とし、こちらには写さない。
  - 版・公開版の sale group・商品の販売者列の値：
    - 口座 ID はプラットフォームの口座
    - 販売者参照は `agt_…`
    - 販売者名は NATIVE の名前
    - 公開版の `consent_version` は公開の同意の版（今のオーナーの経路と同じ）
    - 代理受領の同意の版は、販売プランの版と予約の snapshot に入れる
  - 予約の `sellerSnapshot` に `sellerParty` を入れる（代理受領は `payoutDelayDays`・`receivingAgentName` も）。
- **特定商取引法の表示**：販売者プロフィールの無いオーナーも、NATIVE を保存できるようにする。代理受領で受付中の体験があるときは、名前の変更と撤回を 409 にする。公開の販売者ページは、代理受領の版でも出す（同意の撤回・名前の違いで消える）。
- **選ぶ**：体験の編集で「サポート 15%（NIHO が代金を受け取る）」を選ぶ。
  - 条件：
    - オーナー・直近 30 分のログイン
    - 販売者プロフィールが無い
    - NATIVE がある
    - 同意の版が今の版
  - 1 つの transaction で、同意・版・状態・商品の販売者列を入れる。同じ command の再送は同じ結果。
  - 同意の文言（版つき、短く）：
    - 販売者はあなた（{販売者名}）
    - 代金は {NIHO の正式名} が代わりに受け取り、旅行者は支払った時点で支払いを済ませたことになる
    - 料率は 15%（決済手数料こみ、返金後の額に対して）
    - 体験が終わってから 3 日後に、予約ごとに受取口座へ送る（受付には受取口座は要らない、送金までに要る）
    - 送金のあとの返金・異議申立ては、送金の取り消しか次の送金からの差し引き
    - 規約へのリンク
- **受付を始める**：
  - 代理受領の分岐では、受取口座・販売者プロフィール・fee settings・readiness を見ない。
  - 次を見る：
    - 版が有効
    - 商品の販売者列が版と一致
    - 有効な同意（`AGENT_CONSENT_REQUIRED`）
    - NATIVE の名前の一致（`SELLER_DISCLOSURE_REQUIRED`）
    - プラットフォームの口座の確認が 5 分以内（`CONNECT_NOT_READY`）
- **Checkout**：`createPlatformCheckout` を使い回す（metadata・冪等キー・口座の header なし・application fee なしは同じ）。代理受領だけ、次を足す。
  - `payment_intent_data.transfer_group = niho-experience-agent-payout:<予約>`
  - `custom_text`：「販売者：○○。代金は NIHO が販売者に代わって受け取ります」（日本語・英語）
- **予約画面とメール**：決済の直前と確認メールに、販売者と代理受領を出す（`paymentCollectedBy`）。販売者情報のリンクは、ホスト自身の `/experiences/{slug}/seller`。
- **切り替え**：今の版が代理受領なら、Direct への切り替え（`beginOwnerSwitch`）は 409（3c まで）。体験の編集のプランの表示は「サポート 15%（NIHO が代金を受け取る）」にする。
- **flag**：
  - `EXPERIENCE_HOST_AGENT_SALES_ENABLED`（選ぶ・受付・Checkout・販売者情報の開放）。設定は `EXPERIENCE_HOST_AGENT_SALES_AGREEMENT_VERSION`・`EXPERIENCE_HOST_AGENT_RECEIVER_NAME`・`EXPERIENCE_HOST_AGENT_PAYOUT_DELAY_DAYS`（既定 3）。
  - 受付の可否は、販売者が NIHO なら `managedSalesEnabled`、ホストならこの flag で決める。
  - この flag は送金の flag（3b-2）を前提にし、3b-1 だけでは本番で ON にできないようにする。

#### 3b-1 の実装メモ（#725）

- **置き場所**：判定 `salesKindOf`／`salesKindSql` は `packages/experience-store/src/sales-kind.ts`（payments は `@niho-experience/experience-store/sales-kind` で読む）。選ぶ store は `agent-sales.ts`（`ProviderAgentSales.choose`・`revokeConsent`）、受付と販売の判定に使う同意と NATIVE の読みは `agent-consent.ts`。route は `POST /host/api/products/{productId}/agent-sales?providerId=`（`lib/experience/agent-sales-http.ts`）。
- **同意の版**：受付を始める検査（`openBooking`）だけ、有効な同意の版が設定の版と同じことを見る。販売（`loadSellable`）と下書きの保存は、同意が有効（撤回されていない・今の OWNER が与えた・版の `agt_…` と同じ）であれば続ける。版を上げても受付中の体験は続き、次の選択（受付を止めてから）から新しい版になる。
- **command の再送**：版の `owner_switch_command_id` に command ID を入れる（Direct への切替と同じ列・同じ一意制約）。同じ command の再送は、その版が今の版なら同じ結果、そうでなければ 409。
- **flag**：`EXPERIENCE_HOST_AGENT_SALES_ENABLED`。OFF なら route は 404、受付の boundary・特商法の route・予約の受付判定は今のまま。販売者が NIHO の予約は `managedSalesEnabled`、ホストの予約は `agentSalesEnabled`（`true` のときだけ）で止まり、2 つは独立。deploy の表は本番だけの `prodNeeds` に 3b-2 の flag（`EXPERIENCE_HOST_AGENT_PAYOUTS_ENABLED`）を持つので、本番では送金の flag も ON でないと ON にできない（stg は単独で ON にでき、test mode で確かめられる）。0096 はコードより先に適用する（flag が OFF でも、販売の読み取りが新しい列と表を読むため）。
- **再ログイン**：選ぶ route は直近 30 分のログインを見て、古ければ 401 `REAUTH_REQUIRED`（`href` つき）を返す。画面は `href` へ移る。戻り先は 設定 の受取口座（体験の編集ではない）。
- **撤回**：同意の撤回は store の `revokeConsent` だけ（画面と route は 3b-2 以降）。撤回すると販売・受付の判定と公開の販売者ページから外れる。

### 3b-2 送金

- **台帳（migration 0097）**：
  - `experience_agent_payouts`：予約ごとに 1 行。持つもの：
    - 決済額・返金・異議申立ての負け・NIHO の取り分・送金額
    - 予定日（体験の終了 + 版の日数）
    - 状態：予定・受取口座の登録待ち・手続き中・結果不明・送金済み・要確認・取消
    - 止めている理由：返金中・返金の失敗・異議申立て中・運営停止
    - 送金の command・送金先・Transfer ID・取り戻した額
    - 額の関係は CHECK で縛る
  - ほかの表：
    - 送金のあとの取り戻し（返金・異議申立て）
    - 次の送金からの差し引きの配分
    - append-only のイベント
  - 返金と異議申立ての表が変わったら、その予約の行を再計算の対象にする（trigger）。
- **job**（drain の 1 段。flag `EXPERIENCE_HOST_AGENT_PAYOUTS_ENABLED` が ON のときだけ。送金だけを止める非常停止にもなる）：
  1. 決済が済んだ代理受領の予約に、台帳の行を作る（PAYMENT_REVIEW は解決を待つ）。
  2. 予定日を過ぎた行を `FOR UPDATE SKIP LOCKED` と lease で取る。
  3. 返金後の額で再計算する。返金中・異議申立て中・運営停止は止める。送金額が 0 なら取消。
  4. 受取口座を確かめる：
     - 有効な行が無い、または payout-ready でないなら「登録待ち」にし、ホストへメールを送る（予定日・7 日後・30 日後）。
     - 予定日から 90 日で、事務局の要確認にする。送金を受ける権利は消さない。
  5. 元の Charge を読んで、額・通貨・状態を確かめる。
  6. 未消化の差し引きを古い順に配分し、手続き中にして command を固定し、commit する。
  7. Transfer を作る：
     - まず `transfer_group` の一覧から探し、無ければ作る（`source_transaction`・冪等キー `experience-agent-payout:<command>`）。
     - 23 時間を過ぎた未確定は作り直さず、要確認にする。
     - 例外なら結果不明にし、次の回で一覧から照合する。
  8. 送金のあとの返金・異議申立ての負けは、まず Transfer の reversal で取り戻す。残高が足りなければ次の送金から差し引く。90 日たっても残るものは、NIHO の損失として記録する（事務局の要確認）。異議申立ての手数料は NIHO が負う。
- **ホストの売上の画面**：予約ごとに、体験日・決済額・返金・NIHO の取り分・送金額・予定日・状態（予定・登録待ち・送金済み・確認中・取消）を出す。取り戻しがあれば、それも出す。受取口座の「登録済み」の文言を「売上を受け取れます」に変える。
- **事務局の画面**：要確認の一覧（要確認・23 時間を過ぎた結果不明・期限を過ぎた登録待ち・長く残る取り戻し）と、予約ごとの操作。操作は再計算・送られていないことを確かめての作り直し・送らずに閉じる・差し引きに回す・損失として記録で、version の CAS をかける。
- **ホストの取消**：送金の手続きに入った後は、ホスト自身では取り消せない（事務局が対応する）。

#### 3b-2 の実装メモ（#725）

- **置き場所**：台帳の store は `packages/experience-store/src/agent-payouts.ts`（`AgentPayoutRepository`）、migration は `0097_agent_payouts.sql`、Stripe は `packages/experience-payments` の `retrieveAgentPayoutCharge`・`submitAgentPayoutTransfer`・`reverseAgentPayoutTransfer`、job は `apps/web/src/lib/experience/agent-payouts.ts`（drain の `agentPayouts`。返金の再送の後、決済費用の照合の前）。メールは新しい topic `host.mail.agent_payout_account_needed`（`hostAgentPayoutMails`）。
- **一時停止**：`EXPERIENCE_HOST_AGENT_PAYOUTS_PAUSED`（既定 false。ほかの flag を要さない）。本番の非常停止はこれ（販売の flag が送金の flag を要るので、送金の flag だけは OFF にできない）。ON の間、job は再計算と結果不明の transfer の照合（作らない）だけを行い、画面は「一時停止中」と出す。
- **flag**：`EXPERIENCE_HOST_AGENT_PAYOUTS_ENABLED`（既定 OFF）。ON のときだけ、送金の job・ホストの売上の「NIHO からの送金」・事務局の route と画面が動く（OFF の route は 404）。販売の flag を止めても、受けた予約の送金は続く。送金だけを止める非常停止もこの flag。deploy の表では `HOST_CONSOLE`・DB・ホストアカウント・受取口座の登録・ホストメールが要り、`EXPERIENCE_HOST_AGENT_SALES_ENABLED` は本番でこの flag を要る（`prodNeeds`）。
- **job の流れ**：初期化（AGENT_15 で決済済み・CONFIRMED か CANCELLED の予約に行を作る。PAYMENT_REVIEW は待つ）→ `FOR UPDATE SKIP LOCKED` と 5 分の lease で claim → `prepare`（再計算。保留・取消・予定日前は休ませる。TRANSFERRED の行は送金後の取り戻しを見る。SUBMITTING・RESULT_UNKNOWN は一覧から照合へ）→ 送金先（0095 の有効な PAYOUT の行を Stripe で読み、snapshot も保存。受け取れなければ `awaitAccount`）→ Charge を読む → `begin`（もう一度計算、差し引きの配分、command と送金額を固定して commit）→ Transfer → `recordTransfer`。最後に取り戻しの reversal と、90 日残った差し引き待ちの要確認化。
- **ロック順**：在庫の advisory lock → 予約 → payout → adjustment（ホストの取消と同じ）。Stripe の呼び出しはどのロックの中でも行わない。
- **額**：返金 = 成功した返金の合計、異議申立て = LOST の合計。NIHO の取り分 = 床（(決済 − 返金 − 負け) × 15%）、送金額 = それ以外。10,000 円で 2,000 円返金なら 1,200 円と 6,800 円。返金中（REQUESTED・PENDING）・失敗して閉じていない返金・異議申立て中・ホストの運営停止は、予定の行を `hold_reason` つきで止める。送金額 0 は CANCELLED。送金額 + 差し引き = 送金時の取り分。
- **Transfer の冪等と照合**：`transfers.list({transfer_group: niho-experience-agent-payout:<予約>})` を先に読み、metadata（source・purpose・booking_id・payout_id）と額・送金先が合う 1 件があれば採用。ほかの transfer が 1 件でもあれば、重複・切り詰めと同じく要確認。無ければ `source_transaction`・transfer_group・metadata を付けて、冪等キー `experience-agent-payout:<command_id>` で作る。command から 23 時間を過ぎた未確定は作り直さず要確認。例外は RESULT_UNKNOWN にして、次の回は一覧から照合する。`niho-experience-settlement:` の group は拒む。transfers の capability が無い拒否は登録待ちへ、ほかの拒否は要確認。
- **取り戻し（reversal）**：送金のあとの返金・異議申立ての負けで「送った額 + 差し引いた額 − 新しい取り分 − すでに扱った額」が正なら adjustment を作る。Transfer の残りの範囲で `transfers.listReversals` を先に読み（metadata の adjustment_id）、無ければ `createReversal`（冪等キー `experience-agent-payout-reversal:<id>`）。残高不足は OFFSET_PENDING（次の送金から古い順に差し引き、`offsets` に配分を追記）。90 日残る・ほかの拒否は REVIEW_REQUIRED。
- **ホストの画面**：売上に、OWNER だけの「NIHO からの送金」（体験日・決済額・返金等・NIHO の手数料・送金額・予定日・状態〔予定・登録待ち・送金済み・確認中・取消〕、取り戻し・差し引き）。他のホストの行は出ない（`providerId` で分ける）。受取口座の「登録済み」は「売上を受け取れます」。
- **事務局**：予約の面（AGENT_15）の「ホストへの送金」で、再計算して再開（命令の無い行）・送られていないことを確かめて作り直す・送らずに閉じる（メモ必須。差し引きを使った行は不可）・差し引きに回す・NIHO の損失として記録（メモ必須）・取り消しを再開。`expectedVersion` の CAS、actor はイベントに残る。要確認の一覧は 要確認・23 時間を過ぎた結果不明・登録待ちが予定日から 30 日を超えたもの・30 日残る取り戻し。route は `/admin/api/site-bookings/agent-payout/{publicBookingId}`。
- **レビュー後の補強**：Charge に DB に無い返金（`amount_refunded` が成功した返金の合計を超える。Dashboard の返金など）か異議申立て（`disputed`）があれば送らず要確認。送金先は `begin` の lock の中でもう一度（そのホストの・退役していない・PAYOUT・同じ口座 ID）確かめ、違えば登録待ち。差し引きを使った行が送金額 0 になったら取消にせず要確認。一部だけ取り消せた取り戻しは、取り消しを再開せず、差し引きに回しても取り消し済みを数え直さない。結果不明の送金の作り直し・閉じるは command から 23 時間のあと、job が claim 中の行と、job が持つ取り戻し（REVERSAL_PENDING）には事務局は触れない。差し引き待ちの 90 日は OFFSET_PENDING になった時刻から（事務局が戻したら新しく）。送金済みの行は、返金・異議申立て・運営停止の trigger が起こすときだけ見直す。job は他の段と同じ時間の予算（`sendBudgetMs`。Stripe を呼ぶ前にも見る）で止まる。Stripe の `charge.disputed` は決着後も true のままなので、台帳に異議申立ての行が 1 つも無いときだけ送金を止める（行があれば、LOST の合計を引き、開いている間は hold する計算に任せる）。lease は 300 秒で、Stripe を呼ぶ直前に行ごとに（claim の token つきで）延ばし、version も上げる。延ばせなかった行（別の run や事務局が取った）は Stripe を呼ばない。送金・取り消しの Stripe client は timeout 20 秒・再試行 1 回で、1 行の最悪は約 90 秒（lease の 1/3 以下）。
- **ホストの取消**：送金の command ができた（SUBMITTING 以降、要確認で止まった行も含む）予約は、ホスト自身の取消（この回を中止も）の対象から外れる（事務局が対応）。
- **確かめられていないこと（Stripe の仕様）**：transfers の capability 不足のエラーコード（`insufficient_capabilities_for_transfer`・`transfers_not_allowed` を想定）、Express の残高不足のときの reversal のエラーコード（`balance_insufficient`・`insufficient_funds` を想定）、`source_transaction` つきで Transfer の額が Charge から返金を引いた残りを超えられるか。stg の test mode で確かめ、違えば `submitAgentPayoutTransfer`・`reverseAgentPayoutTransfer` の分類を直す。

### 決めた既定値（オーナー「他の論点は推奨で」2026-11-28）

- 送金までの日数：体験の終了から 3 日。版に固定する。
- 受取口座の登録待ち：予定日・7 日後・30 日後に知らせる。90 日で事務局の要確認にする。送金を受ける権利は消さない（上限は法務の確認のあと）。
- 送金のあとの取り戻し：reversal、次の送金からの差し引き、90 日で NIHO の損失、の順。
- 異議申立ての負けは、返金と同じく取り戻す。異議申立ての手数料は NIHO。
- 運営停止中のホストへは送らない。
- 同意の版を上げても、受付中の体験は続ける（次の選択から新しい版）。
- 今の Direct 15%・おまかせ 20% のホストは、3b では代理受領へ移れない。

### 本番で開く前の確認（flag は OFF のまま）

- **法務**：
  - 代理受領の規約。次を定める。
    - 代理受領権
    - 旅行者の支払い義務が消えること
    - 行き先を本人名義の口座に限ること
    - 預かる期間の上限
    - 個人のホストの扱い
    - 差し引き・取り戻し
    - 収納代行の法改正
  - 本人名義の確かめ方：初回の送金の前に、事務局が Express の名義と販売者名を照合する。
  - 特定商取引法の表示に代理受領者を書くこと。
  - インボイス（媒介者交付特例）、領収書と Checkout の文言。
- **Stripe（stg の test mode）**：
  - PaymentIntent と Transfer の `transfer_group`・`source_transaction` を同時に渡せるか。
  - Express の残高不足のときの reversal のエラー。
  - 本番キーの権限：Transfers・Transfer reversals の書き込み、PaymentIntents・Charges の読み取り。
- **初回の送金の名義の確認**：今は仕組みを作っていない。法務が要るとした場合は、初回の送金の前に事務局が Express の名義と販売者名を照合する門（ホストごとの確認済みの印がないと `begin` しない）を足す。
- **料金**：Connect の料金（口座ごとの月額・入金ごとの料金）を、15% でまかなえるか。
- `experience-sales-plans.md` の「15% と 10% は同じ口座」と、`glossary.md`（代理受領）を直す。

## 3c 独立 10% の本人の口座（Standard）

2 つの PR に分ける。flag `EXPERIENCE_HOST_STANDARD_ONBOARDING_ENABLED`（既定 OFF。本番は 3c-2 まで OFF）。

### 決めた既定値（オーナー「他の論点は推奨で」2026-11-28）

- 口座は 3a の `experience_connect_accounts` を用途 `DIRECT` で使い回す（予約の行・冪等キー・状態・webhook・退役の仕組みが同じ）。有効な行は用途ごとに 1 つ。1 つの口座が両方の用途にはならない。
- 既存の Stripe アカウントを持つ人も、OAuth ではつながず、新しく作る（本人は Stripe の画面で今のログインのまま入れる。残高と入金は別のアカウントになる）。
- 1 つのホストで、体験ごとに代理受領 15% と独立 10% が混ざってよい。受付中の代理受領は続ける。代理受領を新しく選べるのは販売者プロフィールが無いときだけ。代理受領から独立 10% への切り替えは受付中でもできる（開いている NIHO の Checkout は閉じる。受けた代理受領の予約は今までどおり Express へ送る）。
- 独立 10% の同意の版は新しい設定 `EXPERIENCE_HOST_INDEPENDENT_SALES_AGREEMENT_VERSION`。文言は「販売者はあなた」「代金はあなたの Stripe で直接受け取る」「料率 10%（決済手数料こみ。NIHO が補う）」「返金・異議申立ての損失はあなた」「規約へのリンク」。
- 受取口座の利用同意の文と版（`EXPERIENCE_PAYOUT_ACCOUNT_CONSENT_VERSION`）は使い回す。
- 販売者名は特定商取引法の表示（NATIVE）の名前にし、Stripe の名義との自動の照合はしない。
- Standard の口座の要件のメールは、NIHO からは送らない（Stripe が本人に知らせる）。
- `DIRECT` の行は、販売者プロフィールが結んでいる間は退役させない（運営の販売者変更の手順に任せる）。

### 3c-1 口座をつなぐ（口座の作成と販売者の登録）

- **口座の作成**（migration 0098）：`experience_connect_accounts.purpose` に `DIRECT` を足す。`UNIQUE (id, provider_id, purpose, stripe_account_ref)` を足す（販売者プロフィールからの FK 用）。状態の表に `charges_enabled` を足す。
  - パラメータ：国 `JP`、`controller: { stripe_dashboard: { type: "full" }, losses: { payments: "stripe" }, fees: { payer: "account" }, requirement_collection: "stripe" }`、`capabilities: { card_payments, transfers }`、metadata（`provider_id`・`creation_id`・`source`・`purpose: "direct"`）。`business_type` と入金スケジュールは入れない（本人が設定する）。冪等キーは `experience-direct-account:<行 id>`。
  - 作成の流れ（行の確保・23 時間の窓・`metadata.creation_id` の照合・口座 ID を 1 回だけ書く・Account Link）は 3a と同じ。route は `POST /host/api/direct-account/onboarding?providerId=` と `GET …/refresh`（同一 origin・オーナー・直近 30 分のログイン）。
  - 状態：国・通貨・controller・metadata の一致、`details_submitted`・`charges_enabled`・`payouts_enabled`、`card_payments` と `transfers` が `active`（`transfers` は NIHO の補填の Transfer に要る）、要件が空、`rejected.*` でない、で READY。画面の状態と文言は 3a と同じ。
  - webhook：`account.updated` を用途で分ける。`DIRECT` は読み直して保存するだけで、メールは出さない。
- **販売者プロフィールを runtime から作る**（migration 0099）：
  - `experience_host_seller_profiles` に `connect_account_id`・`connect_account_purpose`（`DIRECT`）を足す。`experience_connect_accounts (id, provider_id, purpose, stripe_account_ref)` への FK と CHECK（あれば `legacy_provider_id` は NULL、`seller_niho_account_ref` は `sel_`）を足す。
  - BEFORE INSERT の trigger：表の持ち主の role でないとき（runtime のとき）、`connect_account_id` があり、その行が `DIRECT` で退役しておらず、ホストと口座 ID が同じでなければ拒む。運営の script（移行の identity）は今のまま書ける。
  - runtime の権限は INSERT だけ（UPDATE は `updated_at` だけ、DELETE なし）。
  - store `ProviderDirectSellers.register`（1 つの transaction）：
    1. 在庫の lock と同意の lock、オーナーであること、販売者プロフィールが無いこと（あれば `SELLER_EXISTS`）を確かめる。
    2. 有効な `DIRECT` の行で口座 ID が一致し、状態が READY で 5 分以内に読んだものかを確かめる。
    3. NATIVE の名前を確かめる（無ければ `SELLER_DISCLOSURE_REQUIRED`）。
    4. 販売者プロフィールを作る（新しい `sel_`・NATIVE の名前・公開名・legacy は NULL）。
    5. 受取口座の利用同意（`recordPayoutConsentIn` に切り出す）。
    6. `attachSellerToSellerlessProducts`（運営専用のファイルから共有のファイルへ移す。代理受領の版を除く条件は今のまま）。
  - route `POST /host/api/direct-account/seller?providerId=`：直前に Stripe を読んで READY を確かめる。
  - ホストの手順は、Stripe に登録 → READY → 特定商取引法の表示を保存 → 同意する（ここで販売者プロフィールができる）。
- **混在の修正**：
  - 受取口座の利用同意の取消は、今の版が代理受領の掲載は止めない。
  - 受取口座の画面で、Express の段を出す条件を変える。今は「販売者プロフィールが無い」とき。これを「PAYOUT の行がある、または代理受領の同意の履歴がある」ときも出す（そうしないと送金が登録待ちで止まる）。
  - 販売者プロフィールができたあとの特定商取引法の表示は、今どおりプロフィールの名前に固定する。
  - 販売者プロフィールの無いホストが NATIVE を保存できる条件に、この flag を足す。
- **stripe-login**：販売者の口座が `DIRECT` の行の口座なら、Express のログインリンクを作らず、Stripe のダッシュボード（`https://dashboard.stripe.com/`）を開く。
- **設定 › 受取口座 の出し分け**（各段は 1 行の説明と 1 つのボタン）：
  - 販売者プロフィールが無いとき：
    - 「サポート 15% の受取口座」（3a）。
    - 「独立 10%：自分の Stripe アカウント」。未登録なら「自分の Stripe アカウントで販売する」、途中の状態は 3a と同じ文言。READY なら同意の文と「同意する」（NATIVE が無いときは特定商取引法の画面へのリンクだけ）。
  - 販売者プロフィールがあるとき：今の画面。Standard の口座なら「Stripe で見る」はダッシュボードへのリンク。条件を満たせば、その下に Express の段。

#### 3c-1 の実装メモ（#726）

- **migration**：`0098`（`experience_connect_accounts.purpose` に `DIRECT`、`UNIQUE (id, provider_id, purpose, stripe_account_ref)`、状態の表に `charges_enabled`）と `0099`（`experience_host_seller_profiles` に `connect_account_id`・`connect_account_purpose`、CHECK、FK、BEFORE INSERT の trigger）。**どちらもコードより先に適用する。**
- **trigger と権限**：表の持ち主の role（移行の権限。運営の script）は今までどおり書ける。ほかの role（runtime）は、`connect_account_id` があり、その行が `DIRECT` で退役しておらず、ホストと Stripe の口座が同じときだけ INSERT できる。runtime の権限は `INSERT` と `updated_at` の UPDATE だけ（`DELETE` なし）。
- **口座の作成**：`packages/experience-payments` の `directAccountCreationParams`・`createDirectAccount`（冪等キー `experience-direct-account:<行 id>`）・`directAccountFactsOf`・`retrieveDirectAccountStatus`。`findPayoutAccountByCreationId` は `purpose`（metadata）で絞る。READY は、不一致なし・`details_submitted`・`charges_enabled`・`payouts_enabled`・`card_payments` と `transfers` が `active`・要件が空・`rejected.*` でない。
- **web**：`lib/experience/host-direct-account.ts`（`startDirectOnboarding`・`refreshDirectOnboardingLink`・`loadDirectScreenState`・`registerDirectSeller`）と `host-direct-account-http.ts`。route は `POST /host/api/direct-account/onboarding`・`GET …/onboarding/refresh`・`POST …/seller`（すべて `?providerId=`・OWNER・直近 30 分のログイン。seller は同一 origin の form で `accountLast4`・`consentVersion`・`accepted`）。`account.updated` は用途で分け、`DIRECT` は読み直して保存するだけでメールは出さない。`connectAccounts()` は 3a と 3c-1 のどちらかの flag が ON なら返す。
- **販売者の登録**：store `ProviderDirectSellers.register`（`packages/experience-store/src/direct-sellers.ts`、1 つの transaction。途中で失敗したら何も残らない）。`recordPayoutConsentIn`（同意）と `attachSellerToSellerlessProducts`（`seller-attachment.ts`。運営の `site-sale-registration.ts` と共有）を同じ transaction で呼ぶ。Stripe の読み取りは直前（5 分以内の READY）。
- **混在の修正**：受取口座の利用同意の取消は、今の版が代理受領の掲載を止めない。`reserve`（PAYOUT）は、販売者プロフィールが無い、または代理受領の同意の履歴があるときに通す。受取口座の画面は、PAYOUT の行がある、または代理受領の同意の履歴があるときも Express の段を出す。販売者プロフィールが無いホストは、この flag でも特定商取引法の表示（NATIVE）を保存できる。`agentSalesOffer` は、販売者プロフィールのあるホストでも、代理受領の商品には `choosable: false` で状態を返す。
- **画面**：`ExperiencePayoutLoad` は `connect: { payout, direct }`（どちらかが null なら、その段は出さない）と `owner: { …, payout?, standard? }`。販売者の口座が `DIRECT` の行なら「Stripe で見る」は dashboard（`https://dashboard.stripe.com/`。Express のログインリンクは作らない）。
- **退役**：`retire-connect-account.mjs` は `--purpose direct` で `DIRECT` の行も退役できる。販売者プロフィールが結んでいる行は拒む（販売者の変更の手順が先）。
- **flag**：`EXPERIENCE_HOST_STANDARD_ONBOARDING_ENABLED`（既定 OFF）。needs はホストの画面・DB・ホストアカウント・ホスト公開 API。**本番では ON にできない**（deploy の表の `stagingOnly: true`。本番で ON にすると deploy の検査が拒む）。3c-2 でこの属性を外し、3c-2 が足す設定 `EXPERIENCE_HOST_INDEPENDENT_SALES_AGREEMENT_VERSION` を必須にする。
- **flag が OFF でも効く変更**：混在の修正のうち、(1) 同意の取消が代理受領の掲載を止めない、(2) `reserve(PAYOUT)` が有効な行を返し、履歴で新しい行を作れる、(3) Express の段と「Stripe で見る」の出し分け（`ownerExtras`）、(4) `agentSalesOffer` の `choosable:false`。すでに代理受領を使うホストのためで、migration `0098`・`0099` をコードより先に適用する。画面の Express の段と `reserve(PAYOUT)` の条件は、store の `payoutBlock`（有効な PAYOUT の行がある、または代理受領の同意の履歴がある）の 1 か所で決める。
- **退役の競合**：結ばれた `DIRECT` の行の退役は、アプリの判定に加えて 0099 の trigger（`retired_at` が NULL から値になる UPDATE で、販売者プロフィールが参照していれば例外）が拒む。`register` が行を `FOR SHARE` で持っているあいだの退役は、待ってから拒まれる。
- **「Stripe で見る」**：販売者プロフィールの `connect_account_id`（`DIRECT`）で判定し、`DIRECT` なら常に `https://dashboard.stripe.com/`（flag が OFF でも、fallback でも）。PAYOUT の行も持つホストは、ボタンの `kind`（`direct`＝自分の Stripe アカウント、`payout`＝Express）で出し分ける。

### 3c-2 独立 10% で売る

- 体験の編集の「料金・予約」で「独立 10%」を選ぶ（`POST /host/api/products/{id}/independent-sales?providerId=`）。
  - 条件：直近 30 分のログイン、readiness（口座が使える・同意・口座の一致）、同意の版、NATIVE の名前が販売者プロフィールの名前と同じ。
  - store `chooseIndependent`：状態が無い商品は、版 1（`INDEPENDENT_10`・`CONNECT_DIRECT`・1000・`OWNER_WEB`）・状態・商品の販売者列を作る。代理受領の版からは、今の切り替え（`beginOwnerSwitch`・Checkout の失効・`finalizeSwitch`）を通す。
- 受付を始める検査：販売者が `DIRECT` のプロフィールのとき、版が無ければ `SALES_PLAN_REQUIRED`（fee settings は見ない）。`INDEPENDENT_10` の版なら fee settings を見ず、版の有効・販売者列の一致・NATIVE の名前の一致を見てから、今の readiness へ進む。今の Direct のホストの検査は変えない。
- Checkout・返金・精算（補填の Transfer）は、今の Direct の経路のまま。

