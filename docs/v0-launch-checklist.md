# v0（相談・日本語・担当）を本番で開く手順と前提

対象：#532（相談）、#59（日本語サイト）、#535（担当）。2026-11-13 の stg 配備（main `daae2888`）の結果から作った。**本番はまだ開いていない。** 順序は上から。

## stg の状態（2026-11-13）

| 項目 | 状態 |
| --- | --- |
| migration `0069`〜`0074` | stg DB へ適用済み |
| 配備 | main `daae2888` を候補 → 昇格済み |
| `STG_JAPANESE_SITE_ENABLED` | `true`（`host-staging`・`host-staging-owner` の両 Environment） |
| `STG_GROUP_INQUIRY_ENABLED` | `true`（同上。前提のゲストメール・DB は元から ON） |
| `OCCURRENCE_ASSIGNMENT_ENABLED` | **開けていない**。前提の完全代行の販売が stg で OFF のため（下記） |
| 相談の流れ | `/ja/business` → フォーム → 送信 → 受付番号 → `/admin/inquiries` で状態・次の期限・担当・メモの更新まで確認。360px で横スクロールなし。合成データは確認後に削除 |
| 未確認 | メールの実送信（宛先が実在の info@niho.life と外部のため送っていない。2通とも「送信待ち」まで）、体験ページの「◯◯さんに相談する」（stg の合成体験にホスト名が無い）、日本語サイトの NIHO 側 release との通し |

### 担当（#535）を stg で開けない理由

`OCCURRENCE_ASSIGNMENT_ENABLED` の前提は `MANAGED_SALES_ENABLED`。stg には次が無い。

- `STG_MANAGED_SALES_WEBHOOKS_ENABLED`、`STG_MANAGED_PLATFORM_ACCOUNT_ID`（Stripe test の `acct_`）
- Secret `experience-stg-stripe-platform-webhook-secret`（Stripe test の署名鍵。実値は管理者が登録）
- `STG_MANAGED_LEGAL_SELLER_NAME`、`STG_MANAGED_COMMERCIAL_TRANSACTIONS_URL`、`STG_MANAGED_SELLER_NIHO_ACCOUNT_REF`、`STG_MANAGED_AGREEMENT_VERSION`

stg の Stripe test 側の準備と、合成の販売者の値の決定が要る。本番にはこれらが既にある（下の「本番の現状」）。

## 本番で開く手順

1. **migration を先に当てる**：`experience_prd` に `0069`〜`0074` のうち未適用のものを辞書順で。`CONFIRM_EXPERIENCE_DB_MIGRATE=niho-app-prd`、niho-app の `niho-db.sh prd --via-bastion -- node scripts/gcp/apply-experience-db-migrations.mjs`（手順は `docs/host-calendar-staging.md`「以降のmigrationとruntime権限」）。runtime ロールに開いたセッションがあると止まる（stg では Scheduler の drain job を一時停止して待つと通った。終わったら再開する）。新しいコードより先。追加のみで、戻さない。
2. **配備**：`Deploy production`（候補 → 昇格）。この時点では flag は OFF のまま、挙動は変わらない。
3. **flag を開く**（repository variable `PROD_*`、未設定か `false` が OFF）。1つずつ、開くたびに候補 → 昇格：
   - `PROD_GROUP_INQUIRY_ENABLED=true`（前提：DB・ゲストメール。どちらも本番は ON）
   - `PROD_JAPANESE_SITE_ENABLED=true`（前提：host console。**加えて** NIHO の日本語 release の実配備と実機確認。`docs/localization-consumer.md`）
   - `PROD_OCCURRENCE_ASSIGNMENT_ENABLED=true`（前提：完全代行の販売。本番は ON）
4. **設定値**：事務局への相談の通知先は `PROD_MAIL_REPLY_TO`（今は `info@niho.life`）。この宛先を事務局が見るか、確認する。受付メールの送信元は `PROD_MAIL_FROM`。
5. **配備後の確認**：`/ja/business`・`/ja/schools`・フォーム・受付番号・`/admin/inquiries`。合成の相談を1件送り、受付メール2通（事務局宛・本人宛）が届くのを自分の宛先で確かめ、終わったら削除する。
6. **切り戻し**：該当の `PROD_*` を `false`（または削除）にして候補 → 昇格。入口とページは消え、受け付けたデータは残る。migration は戻さない。

## 本番の現状（variable 名のみ）

`PROD_GUEST_MAIL_ENABLED`・`PROD_GUEST_BOOKING_ENABLED`・`PROD_MANAGED_SALES_ENABLED`・`PROD_MANAGED_SALES_WEBHOOKS_ENABLED`・`PROD_HOST_ACCOUNTS_ENABLED`・`PROD_HOST_PUBLICATION_API_ENABLED`・`PROD_ADMIN_SUPPORT_CONSOLE_ENABLED` は `true`。`PROD_GROUP_INQUIRY_ENABLED`・`PROD_JAPANESE_SITE_ENABLED`・`PROD_OCCURRENCE_ASSIGNMENT_ENABLED` は未設定（OFF）。

## オーナーの確認（2026-11-13）

- 法人・学校の案内ページの数字（金額・人数・時間・期間。`GROUP_GUIDE_NUMBERS` / `GROUP_GUIDE_FACTS`）：**いまの値のまま公開してよい**と確認済み。
- 相談の運用：返信の目安は2営業日（土日を除く）、事務局への通知先は `PROD_MAIL_REPLY_TO` のまま、保持は完了から1年・月1回の手動削除：**確認済み**。`/privacy` に相談の入力内容の扱いを追記した（相談の flag が ON のときだけ出る節）。
- 担当（#535）：stg を整えずに、本番で flag を開いて確かめる（予約者の画面・メール・決済には出ない内部の機能で、flag を戻せば消える）：**決定済み**。ただし確認のために本番で予約・申込みを作らず、既存のデータも書き換えない。
- 日本語サイト：stg で日本語の予約を確認中。結果が出るまで本番では開けない。
- 担当の報酬の扱いなど `docs/occurrence-assignments.md` の「まだ無いもの」は未決のまま。
