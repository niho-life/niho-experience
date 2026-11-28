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
  - **登録済み**（payout-ready）：「受取口座の登録が済みました」と「Stripe で見る」（Express ダッシュボードのログインリンク）。3b が入るまでは「売上を受け取れます」とは書かない。銀行口座の末尾 4 桁は出さない（`external_accounts` を読む権限を増やさないため）。
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

## 3b サポート 15% を NIHO で受けて、体験のあとに送る（方向。設計は 3b で詰める）

- **決済の方式は `PLATFORM` のまま**にして、販売者が誰かは別の軸（販売プラン `SUPPORTED_15`、または販売者の種類の列）で表す。今のコードは「`PLATFORM` か、それ以外（Direct charge）か」の 2 択なので、新しい charge mode を足すと、checkout・返金（`booking-cancellations.ts`）・Direct の精算（`support-settlement.ts`）・売上（`host-sales.ts`）が Direct charge の経路へ流れてしまう。`MANAGED_20` を条件にしている箇所は、拒む側に倒れることを確かめる。`0070` の CHECK（`SUPPORTED_15` なら `CONNECT_DIRECT`）は新しい版で改める。
- 販売者はホスト。特定商取引法の表示は `/host/seller` の入力（`provider_seller_disclosures`）。表示ページの「受取口座の一致」の条件を、代理受領の販売者に合わせて直す。販売者プロフィールの `stripe_connect_account_ref`（NOT NULL・UNIQUE）と、公開版の sale group に入れる値（口座はプラットフォームの口座、同意の版は代理受領の同意の版）を決める。
- 予約の受付を始める条件に、受取口座は入れない（Stripe なしで売り始められる）。販売者の表示（`NATIVE`）と、サポート 15%・代理受領への同意は要る。
- Checkout・返金・異議申立ては、おまかせ 20% のプラットフォームの決済の経路を使う。Checkout の `custom_text` とメールに「販売者：○○。代金は NIHO が代理で受領します」を出す（カードの明細・Stripe の領収書は NIHO の名義）。インボイス（媒介者交付特例）を確かめる。
- 送金：体験が終わった時刻から N 日後（既定 3 日）に、予約ごとに Transfer を作る。
  - 額は「決済額 − 確定した返金 − NIHO の取り分（返金後の額の 15%、円未満切り捨て）」。Stripe の決済手数料は NIHO の取り分から払う。
  - `source_transaction` に元の Charge を付ける（送金の合計が決済額を超えず、NIHO と共有の残高に左右されない）。`transfer_group` は既存の `niho-experience-settlement:` と別の接頭辞にする。送金先は `experience_connect_accounts` の payout-ready な口座。
  - 台帳は予約ごとに、予定・送金済み・受取口座の登録待ち・要確認を持つ。返金処理中・異議申立て中は送らない。
  - 受取口座の登録待ちのお金は、期限・知らせ・期限後の扱いを決める。
  - 送金のあとの返金・異議申立て：Transfer の reversal は Express の口座に残高があるときしかできない（月 1 回の入金のあとは失敗する）。先に「次の送金から差し引く」を規約に入れ、それでも足りなければ NIHO の損失として記録する。
- 法務（弁護士に確かめる）：資金決済法の為替取引や預り金に当たらないように、規約で、旅行者が NIHO に払った時点で旅行者の支払い義務が消えること（代理受領権）、行き先はホスト本人の名義の口座に限ること、預かる期間の上限、個人のホストの扱いを定める。収納代行に関する法改正が当たるかも確かめる。
- `experience-sales-plans.md` の「15% と 10% は同じ口座」を改める。

## 3c 独立 10% の本人の口座（Standard）

- 設定 › 受取口座 の「自分の Stripe アカウントで販売する」。サーバーが Standard の口座を作り、Account Link で Stripe の画面へ送る。
- 準備ができたら、今の Direct charge の販売者プロフィールと、受取口座の利用同意の流れに乗せる（runtime から、その口座に限って販売者プロフィールを作れるようにする）。
- 料率は今どおり 10%（決済手数料こみ。NIHO が Transfer で補う）。見直すかはオーナーが別に判断する。
