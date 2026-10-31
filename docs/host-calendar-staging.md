# ホスト・Google Calendar の staging 受入準備（#92）

[ADR 0002](adr/0002-experience-domain-ownership.md) に従い、`niho-app-stg` 内に Experience 専用サービスを置く。通常の mock preview、本番、NIHO app のサービスとは実行ID・配備ID・Artifact Registry・OIDC poolを分ける。検索登録は常に停止する（`SITE_INDEXING=block`）。販売は、オーナー決定（2026-10-31）により staging だけ Stripe のテストモードで開ける。Environment Variable `STG_GUEST_BOOKING_ENABLED=true` のときだけで、未設定・`false` なら今までどおり止める（`BOOKINGS_ENABLED=false`。下の「[旅行者の予約（Stripe テストモード、#285）](#旅行者の予約stripe-テストモード285)」）。本番の販売は止めたまま。この手順を用意しただけでは受入完了にならない。

API契約は、このリポの体験業務 v1 と、固定された NIHO host/account 契約を使う。移行元公開APIは `1.0` を維持する。NIHO側 #19282/#19283 の merge・stg配備・契約確認が済むまで readiness を有効にしない。NIHO app のコード・配備設定は連携担当が変更する。

## 固定リソースと権限

| 項目 | staging 専用の値・境界 |
| --- | --- |
| Project / region | `niho-app-stg` / `asia-northeast1` |
| Cloud Run | `niho-experience-host-stg`。初回placeholderはprivate、候補は0%配信（公開状態はservice単位で継承） |
| Artifact Registry | `experience-host-stg`。このrepoに限りdeployerがwriter、Cloud Run service agentがreader |
| Runtime SA | `experience-host-stg-runtime`。下の「Secret Manager」の表の6個のExperience専用Secretと、旅行者の予約で使う6個（新規の webhook 署名鍵1個と NIHO app の既存Secret 5個）だけにresource単位でAccessor、既存SQL instanceだけ条件付きClient |
| Deployer SA | `experience-host-stg-deployer`。対象Cloud Run serviceだけ `run.admin` / `run.invoker`、runtime SAだけ `serviceAccountUser` |
| Jobs SA | `experience-jobs`。Cloud Scheduler の OIDC token 専用。projectのroleなし、対象Cloud Run serviceだけ `run.invoker` |
| Cloud Scheduler | `experience-jobs-drain-stg`（`asia-northeast1`）。毎分 `POST {STG_HOST_SERVICE_URL}/internal/experience-jobs/v1/drain`、audience は `STG_HOST_SERVICE_URL`。一時停止で作り、予約を開く配備のあとに再開する |
| OIDC | 専用pool `experience-host-staging` / provider `github`。固定repo ID・repo名・main・手動workflow・`host-staging` Environmentを検査 |
| Cloud SQL / VPC | 既存のprivate IPのみ・connector必須の `niho-app-db-stg` を使用するが、Experience専用DB・DBユーザーを別途作る。Cloud Runは既存 `default` VPC/subnetへのDirect VPC egress（private rangesのみ）とCloud SQL接続を併用する。NIHO業務DBへ接続しない |

Owner/Editor、project全体のRun Admin、project全体のSecret Accessor、SA鍵は付けない。deployerはSecretの値を読めず、DBにも接続しない。RuntimeのCloud SQL Clientは [Google公式のIAM条件](https://docs.cloud.google.com/sql/docs/postgres/iam-conditions) で既存instanceだけを許す。SQLのDB権限は別途制限する。

## 初期設定（運用担当がレビュー後に手動実施）

1. GitHub Environment `host-staging` を新規作成し、deployment branchは `main` のみ、required reviewerと自己承認禁止を設定する。保護が実際に使えることを確認する。`STG_HOST_DEPLOY_ENABLED` は未設定または `false` のままにする。
2. 管理者が対象project・請求・既存instanceを確認して、レビュー済みSHAから `CONFIRM_HOST_STAGING_SETUP=niho-app-stg bash scripts/gcp/setup-host-staging.sh` を実行する。これは明示的なGCP変更である。scriptはAPI有効化、専用identity/repository/service/IAMを作る。DB・DBユーザー・Secret・既存サービス・共有instanceの設定は変更しない。初回はSecret/DBなしのprivate placeholderを作る。
3. 出力された4個の `STG_HOST_*` をEnvironment Variablesへ登録する。値はresource識別子であり、秘密値ではない。既存providerの設定が異なる場合はscriptを止め、IAMを緩めずレビューする。
4. 下記の専用bootstrap scriptを手動実行し、Experience専用DB・専用DBユーザー・バックアップ方針を用意する。NIHO業務DBを使わない。`packages/experience-store/migrations/` のSQLを名前順に適用する。RuntimeにDDL・role作成権限を渡さず、必要なtable/sequence DMLだけを付ける。共有instance内の他DBへの接続/読取を拒否できるか確認する。`setup-host-staging.sh` と配備workflowはDB変更を実行しない。
5. 合成提供者と専用のテストNIHOアカウントを、正当な権限を持つ非公開のprovisioning経路で結ぶ。`provider_memberships` を含む実ID・SQL応答・接続URL・Google資格情報はGit、公開Issue、PR、CIログへ記録しない。実顧客・実提供者・本番DBの複製は使わない。

### 専用DBの初回bootstrap

空の `experience_stg` DBと既存stgのIAP bastion、空のSecret resource `experience-stg-database-url` を確認した後、`scripts/gcp/bootstrap-host-staging-db.mjs` を `niho-app` の `niho-db.sh stg --via-bastion` の子プロセスとして1回だけ実行する。`CONFIRM_EXPERIENCE_STG_DB_BOOTSTRAP=niho-app-stg` が必要。scriptは接続先・管理ID・空DB・既存role不在を検査し、新しいruntime資格情報をSecret Managerへ先に保管する。その後NOLOGINのmigration roleと限定runtime roleを作り、migration 0001〜0003を適用する。runtimeのDMLだけをgrantして接続・DDL拒否・NIHO側テーブル読取拒否を確認したら、数字versionの `STG_HOST_DATABASE_URL_REF` だけを出力する。これをEnvironment Variableへ設定する。DB接続URL・パスワードは標準出力やファイルへ出さない。

`provider_memberships` の `SELECT ... FOR SHARE` にPostgreSQLがUPDATE権限を要求するため、runtimeには `updated_at` 列だけのUPDATEを付ける。`role` と `active` のUPDATE権限は付けず、bootstrapで両方の拒否と行ロックの成立を検証する。

```sh
# niho-experience の checkout から。NIHO_APP_REPO は niho-app checkout の絶対パス。
CONFIRM_EXPERIENCE_STG_DB_BOOTSTRAP=niho-app-stg \
  "$NIHO_APP_REPO/scripts/dev/niho-db.sh" stg --via-bastion -- \
  node "$PWD/scripts/gcp/bootstrap-host-staging-db.mjs"
```

途中失敗時はSecret version、roleやtableが残り得るため、再実行は拒否される。readinessは無効のまま、専用DBの実状態とSecret versionを管理経路で調べてから復旧する。共有NIHO DBのPUBLIC CONNECTを剥がす操作はこの手順では行わない。runtimeがNIHO側の業務テーブルを読めないことを確認する。将来のmigrationはNOLOGIN roleへ明示的に切り替えて行い、変更したtableのruntime grantを個別に見直す。

### 以降のmigrationとruntime権限

初回bootstrap後のmigrationは `scripts/gcp/apply-experience-db-migrations.mjs` で適用する。適用済みのファイル名とSHA-256を `experience_schema_migrations`（migration role所有、runtimeは権限なし）に記録し、未適用のファイルだけを辞書順にNOLOGINのmigration roleで流す。各ファイルとその台帳の行は1つのトランザクションで確定する（ファイル自身の外側の `BEGIN;`…`COMMIT;` を、台帳の INSERT まで含む1つに置き換える。途中で接続が切れても「スキーマだけ変わって記録がない」状態は残らない。外側の `BEGIN;`/`COMMIT;` の形でないファイルや、中に別のトランザクション制御があるファイルは、流す前に止まる）。適用済みファイルの改変や、適用済みより前に並ぶ未適用ファイルがあれば止まる。runtime roleのsessionが残っている間も止まる。その後、runtimeの権限を `scripts/gcp/experience-db-grants.mjs` の宣言に一致させ（全テーブルを一度REVOKEしてから付け直す）、`has_table_privilege` / `has_column_privilege` で宣言との完全一致と、NIHO側テーブルを読めないことを確認する。新しいテーブル・書込み・upsert・行ロックを足したら同じPRで宣言を更新する。store の `runtime-grants.test.ts` がコード中のSQLとのずれを検出する。

適用済みの最後より前に並ぶ未適用のファイルがあると、scriptは止まる（あとから main に入ったファイルが、すでに適用した番号より前の名前を持つとき）。そのファイルが、適用済みのより後ろのファイルが前提にしている表や制約を変えないことを確かめたうえで、運用担当はファイル名を `EXPERIENCE_DB_ALLOW_OUT_OF_ORDER`（カンマ区切り）で明示して実行する。未適用のファイルは辞書順のまま流れ、指定したファイル以外に順序違いがあれば止まる。指定が未適用でない・順序違いでないときも止まる。新しい migration は、main の最後の番号より後ろに置いて、この状態を作らない。

10/27のbootstrap（0001〜0003）で作ったstg DBには台帳が無いため、最初の1回だけ `EXPERIENCE_DB_BASELINE_THROUGH=0003_google_busy_coverage.sql` を渡す。scriptは既存テーブルが0001〜0003の作るテーブルと完全一致する場合だけ、その3件を台帳へ記録する。stgのCloud SQLは通常 `activationPolicy=NEVER` で停止しているので、適用の間だけ起動し、終わったら戻す。

```sh
CONFIRM_EXPERIENCE_DB_MIGRATE=niho-app-stg \
  "$NIHO_APP_REPO/scripts/dev/niho-db.sh" stg --via-bastion --port 55460 -- \
  node "$PWD/scripts/gcp/apply-experience-db-migrations.mjs"
```

## Secret Manager（値は管理者だけが登録）

下表の6個は `niho-app-stg` に新規のExperience専用品として作成する（旅行者の予約で使うSecretは下の「旅行者の予約」）。Firebase keyもNIHO **stg** の値を使う。versionは数字へ固定し、`latest` やaliasを使わない。

| Environment Variable | Secret名（値は書かない） | Cloud Run環境変数 |
| --- | --- | --- |
| `STG_HOST_SESSION_SECRET_REF` | `experience-stg-host-session` | `HOST_SESSION_SECRET` |
| `STG_HOST_FIREBASE_WEB_API_KEY_REF` | `experience-stg-niho-firebase-web-api-key` | `NIHO_FIREBASE_WEB_API_KEY` |
| `STG_HOST_DATABASE_URL_REF` | `experience-stg-database-url` | `EXPERIENCE_DATABASE_URL` |
| `STG_HOST_GOOGLE_CLIENT_ID_REF` | `experience-stg-google-client-id` | `EXPERIENCE_GOOGLE_CLIENT_ID` |
| `STG_HOST_GOOGLE_CLIENT_SECRET_REF` | `experience-stg-google-client-secret` | `EXPERIENCE_GOOGLE_CLIENT_SECRET` |
| `STG_HOST_GOOGLE_TOKEN_KEY_REF` | `experience-stg-google-token-key` | `EXPERIENCE_GOOGLE_TOKEN_KEY` |

各Variableには上表のSecret名と有効な数字versionを `secret-name:VERSION_NUMBER` 形式で指定する。秘密値をGitHub Variablesへ登録しない。session keyは32文字以上の専用乱数、Google token keyは32 bytesの専用乱数を標準base64へ変換した値とする。鍵の作成・登録は安全な管理端末で行い、標準出力・shell履歴へ値を出さない。

DB URLはExperience専用DB・限定ユーザーを使い、[Cloud RunのUnix socket接続](https://docs.cloud.google.com/sql/docs/postgres/connect-run) に合わせて `/cloudsql/niho-app-stg:asia-northeast1:niho-app-db-stg` をhostとして `pg` が解釈できる形で設定する。既存NIHO backendと同じくCloud SQL接続とDirect VPC egressを併用し、connector必須の共有instanceへ到達させる。資格情報のURL encode、DB名、socket指定、接続とDMLの可否を非公開の管理経路で確認する。workflowは値を取得・表示しない。

管理者は各Secretに対して、次のresource単位のbindingを6件だけ追加する（`SECRET_NAME` は上表のいずれかへ置換）。既存NIHOのSecretへの権限は、旅行者の予約で参照する5個だけに `scripts/gcp/setup-host-staging-guest-booking.sh` がresource単位で追加する（オーナー決定 2026-10-31。それまでの「追加しない」を改めた）。ほかのNIHOのSecretとproject全体には追加しない。

```sh
gcloud secrets add-iam-policy-binding SECRET_NAME \
  --project niho-app-stg \
  --member serviceAccount:experience-host-stg-runtime@niho-app-stg.iam.gserviceaccount.com \
  --role roles/secretmanager.secretAccessor
```

## 固定URLでの接続準備

Cloud Run `status.url` を取得して `STG_HOST_SERVICE_URL` へそのまま登録する。末尾スラッシュ・wildcard・候補tag URL・本番URLを使わない。workflowでも実際のservice URLと一致することを確認する。

- Google OAuthはstg専用Web clientを作り、redirect URIを **`STG_HOST_SERVICE_URL` + `/host/calendar/google/callback`** の1つに限定する。Calendar APIの有効化、同意画面、検証用Googleアカウント、必要なscope（`calendar.calendarlist.readonly`、`calendar.events.freebusy`、`calendar.app.created`）を確認する。本番OAuth client・私用の実予定は使用しない。
- NIHO連携担当はstg Webの `APP_CONNECT_WEB_ORIGINS` に **同じ `STG_HOST_SERVICE_URL` のexact origin** を追加し、接続API/許可された戻り先を確認する。Cloud Runのtag URLを列挙しない。本番 `niho.life` の設定・cookieを変更しない。
- `SITE_URL` はstable service URL、NIHO APIとCSPは `https://app-stg.niho.life` に固定する。候補URLは構成・起動確認にだけ使う。ログインとOAuthの往復は、昇格後のstable URLで開始する。
- Secret/IAM、専用DBとmigration、合成membership、Google/NIHO両方のredirectとorigin、先行API配備を管理担当が確認した後、Environment Variable `STG_HOST_CALENDAR_READY=true` を設定する。最後にRepository Variable `STG_HOST_DEPLOY_ENABLED=true` を設定する。足りない場合はworkflowが失敗して停止する。

## 手動配備と受入

1. **Deploy host staging** を `main` から手動実行し、`action=candidate`、`commit_sha` に起動時点mainと完全一致するレビュー済み40文字SHAを指定する。別jobが資格情報なしでstg CSPを含むimageをbuild・container smokeする。保護Environment承認後、同じartifactのchecksumを検査し、OIDCで専用deployerを使ってdigest固定の0%候補を作る。配信中revisionと割合が変わっていないことを確認する。
2. 候補のimage/runtime/env/数字Secret参照/Cloud SQL接続設定を検査する。候補のGET smokeはdeployerのID tokenを使う。初回はprivateで検査し、初回昇格後の候補は公開済みserviceの設定を継承する。ID tokenは短命のため、配備後のGET直前に生成する。[auth action公式手順](https://github.com/google-github-actions/auth/blob/main/README.md) に従い `workloadIdentityUser` で生成する。Token Creatorの追加は不要。OAuth、予約作成、migrationは実行しない。
3. 成功runのSHA・revision・digestを確認し、`action=promote` に同じ値を指定する。対象commitがmainに残り、構成が現在の保護設定と一致することを再確認する。候補を100%にした**後**、stable serviceへの未認証アクセスを許可する。初回placeholderを公開しない。`robots.txt`・host入口・配信revisionを検査し、失敗時は直前のtrafficへ戻す。初回で失敗した場合はIAM checkも有効へ戻す。昇格の成功・失敗いずれでも対象候補のtagを除去する。候補作成/GET検査が失敗した場合も今回runのtagを除去し、別候補のtagは触らない。rollbackやtag除去も失敗した場合は手動readbackして復旧する。
4. Google Chromeでブラウザ名とstg URLを確認し、合成ホストでNIHOログイン→カレンダー→Google接続→合成busy表示→日程/休止保存→失効/切断→再接続を確認する。別提供者/別userの操作拒否、非OWNERのGoogle接続拒否、古い同期時の受付停止、cookieのHttpOnly/Secure/SameSite、tokenがstorage/公開cache/計測へ出ないことも確認する。ブラウザの画面だけでなく、専用DBへの保存・権限を非公開の管理経路で確認する。
5. `SITE_INDEXING=block`、`HOST_SIGNUP_MODE=pilot` は固定。`BOOKINGS_ENABLED` は `STG_GUEST_BOOKING_ENABLED=true` のときだけ `true`（Stripe テストモード、下の「旅行者の予約」）、それ以外は `false`。ほかの機能は下の「[機能のフラグ](#機能のフラグ84)」の Environment Variable で開く（既定は OFF。PWA だけ今までどおり ON）。この手順（カレンダー）の受入では、ゲスト予約・販売・本番Google接続を受け入れたとは扱わない（予約は下の受入で扱う）。定期同期workerの配備もこのworkflowの対象外で、同期が古いときの受付停止を確認する。
6. 昇格せず破棄する候補は運用担当がtagを除去する。公開済みservice上では0%でもtag URLへアクセスできるため、保留候補のSHA・tag・破棄予定を運用記録で管理し、受入後に未使用tagがないことを確認する。tag除去はrevisionや配信中trafficの削除を意味しない。
7. #92へはSHA・image digest・テスト項目と成否・未実施理由だけを残す。実ID、DB接続情報、OAuth state/code/token、cookie、Calendar ID、予定の件名/説明/参加者、スクリーンショット内の個人情報を公開しない。

候補GETの成功は、DB/membershipの正しさやGoogle OAuth完了を証明しない。受入が終わるまで #92 をcloseせず、NIHOの旧提供者画面の転送・撤去、本番配備は別の受入に進める。

## 機能のフラグ（#84）

mock で出している機能を http mode で開くフラグを、`host-staging` Environment の Variable `STG_*` で候補 revision に渡す。表・前提・配備前の検査・配備後の検証は本番と同じで、[本番の「機能のフラグ」](production-deploy.md#機能のフラグ84) の表の `PROD_` を `STG_` に読み替える（`scripts/deploy/runtime-flags.mjs`）。staging で違うのは次の点。

- **ホストの画面と DB は常にある**ので、前提の「ホストの画面・DB」はいつも満たす。サイトの URL は `STG_HOST_SERVICE_URL`、`<project>` は `niho-app-stg`。
- **`STG_HOST_PWA_ENABLED` は未設定なら ON**（今までどおり）。`false` で止める。
- **予約**は上の「旅行者の予約」の手順と Variable（`BOOKINGS_ENABLED` は `STG_GUEST_BOOKING_ENABLED` に従う）。
- **Secret の名前を固定**して検査する（`secret-name:数字version`）：

| Environment Variable | Secret 名（値は書かない） | Cloud Run 環境変数 | 使うフラグ |
| --- | --- | --- | --- |
| `STG_STRIPE_PLATFORM_SECRET_KEY_REF` | `STRIPE_CONNECT_PLATFORM_SECRET_KEY`（NIHO app 既存、テストの鍵） | `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY` | 予約、売上の入金（`STG_HOST_SALES_PAYOUTS_ENABLED`） |
| `STG_STRIPE_WEBHOOK_SECRET_REF` | `experience-stg-stripe-webhook-secret` | `EXPERIENCE_STRIPE_WEBHOOK_SECRET` | 予約 |
| `STG_SMTP_HOST_REF`・`STG_SMTP_PORT_REF`・`STG_SMTP_USER_REF`・`STG_SMTP_PASSWORD_REF` | `RECEIPT_DELIVERY_SMTP_HOST`・`…_PORT`・`…_USER`・`…_PASSWORD`（NIHO app 既存） | `EXPERIENCE_SMTP_*` | メール |
| `STG_ANTHROPIC_API_KEY_REF` | `NIHO_TRANSLATE_ANTHROPIC_API_KEY`（NIHO app 既存） | `EXPERIENCE_ANTHROPIC_API_KEY` | 翻訳 |
| `STG_HOST_PUSH_VAPID_PRIVATE_KEY_REF` | `experience-stg-host-push-vapid-private-key`（新規） | `HOST_PUSH_VAPID_PRIVATE_KEY` | push（`STG_HOST_PUSH_ENABLED`） |

- 新しい Secret（push の VAPID の秘密鍵）は、管理者が作って runtime `experience-host-stg-runtime` にその Secret だけの `secretAccessor` を付ける。売上の入金は、予約で使う Stripe の鍵（Accessor は `setup-host-staging-guest-booking.sh` が付ける）を読むだけで、新しい Secret は要らない。
- job を開くフラグ（push：`experience-host-push@niho-app-stg…`、Google の 2 つ：`experience-google-jobs@niho-app-stg…`）は、そのサービスアカウントと Cloud Scheduler を先に作る（メール job の `experience-jobs` と同じく、project の role なし、このサービスの `run.invoker` だけ）。workflow は作らない。
- 売上の入金（`STG_HOST_SALES_PAYOUTS_ENABLED`）は `STG_HOST_SALES_LEDGER_ENABLED=true` が前提。受入は [host-sales.md](host-sales.md) の「受入」4。

## 旅行者の予約（Stripe テストモード、#285）

オーナー決定（2026-10-31）：

- staging だけ、旅行者の予約（[guest-booking.md](guest-booking.md)）を Stripe のテストモードで開く（`BOOKINGS_ENABLED=true`）。検索登録は止めたまま（`SITE_INDEXING=block`）。staging の Secret にはテストの鍵だけを入れる。本番は販売を止めたまま（`deploy-production.yml` は変えない）。
- experience 専用の資格情報は新しく作らず、同じ project にある NIHO app の既存 Secret をそのまま参照する。新しく作る Secret は、このサービスを指す Stripe webhook endpoint の署名鍵 1 つだけ。

切り替えは Environment Variable `STG_GUEST_BOOKING_ENABLED`。予約には確認メールと予約ページが要るので、**`STG_GUEST_MAIL_ENABLED=true` も要る**（無ければ配備の前に止まる）。予約前の質問（「Ask the host」）は `STG_GUEST_QUESTIONS_ENABLED=true` で別に開く（2026-11-01 から。それまでは予約の variable だけでメールと質問も開いていた）。どれも未設定・`false` なら revision は今までと同じ（`BOOKINGS_ENABLED=false`、下の値は入れず、下の Variable も検査しない）。`true` のとき、workflow は配備の前に下の Variable をすべて検査し、欠け・形の誤りがあれば配備せずに止まる。配備後の検査は、revision の環境変数と Secret 参照が期待と完全に一致することを確かめる（昇格時も同じ。候補の作成後に Variable を変えると昇格は止まる）。検査とフラグの表は上の「[機能のフラグ](#機能のフラグ84)」と同じ `scripts/deploy/runtime-flags.mjs`。

### workflow が入れる環境変数

| Cloud Run 環境変数 | 値 |
| --- | --- |
| `BOOKINGS_ENABLED`・`EXPERIENCE_GUEST_BOOKING_ENABLED` | `true`（`STG_GUEST_BOOKING_ENABLED=true`） |
| `EXPERIENCE_GUEST_MAIL_ENABLED` | `true`（`STG_GUEST_MAIL_ENABLED=true`） |
| `EXPERIENCE_GUEST_QUESTIONS_ENABLED` | `true`（`STG_GUEST_QUESTIONS_ENABLED=true`） |
| `EXPERIENCE_BOOKING_CONSENT_VERSION` | `STG_BOOKING_CONSENT_VERSION` |
| `EXPERIENCE_MAIL_FROM` / `EXPERIENCE_MAIL_REPLY_TO` | `STG_MAIL_FROM` / `STG_MAIL_REPLY_TO` |
| `EXPERIENCE_JOBS_AUDIENCE` | `STG_HOST_SERVICE_URL`（OTA watchdog と同じく、サービスのベース URL） |
| `EXPERIENCE_JOBS_SERVICE_ACCOUNT_EMAIL` | `experience-jobs@niho-app-stg.iam.gserviceaccount.com` |
| `EXPERIENCE_PRIVACY_POLICY_URL` | `STG_PRIVACY_POLICY_URL`（設定したときだけ） |

翻訳：Environment Variable `STG_TRANSLATION_ENABLED=true`（`STG_GUEST_MAIL_ENABLED` か `STG_GUEST_QUESTIONS_ENABLED` が `true` であることが前提）で `EXPERIENCE_TRANSLATION_ENABLED=true` を入れ、NIHO app の既存の `NIHO_TRANSLATE_ANTHROPIC_API_KEY` を `STG_ANTHROPIC_API_KEY_REF` で参照する（オーナー決定 2026-10-31、experience 専用の key は作らない。[guest-questions.md](guest-questions.md) の「翻訳」）。

予約の variable では入れないもの：`EXPERIENCE_GUEST_REVIEWS_ENABLED`（レビュー #104/#108 は予約とは別の受入）、`HOST_PUSH_*`。どちらも上の「機能のフラグ」で別に開く。

### Environment Variables（値は Git に書かない）

| Variable | 形 |
| --- | --- |
| `STG_GUEST_BOOKING_ENABLED` | `true` / `false` / 未設定 |
| `STG_GUEST_MAIL_ENABLED` | `true` / `false` / 未設定（予約には `true` が要る） |
| `STG_GUEST_QUESTIONS_ENABLED` | `true` / `false` / 未設定 |
| `STG_BOOKING_CONSENT_VERSION` | 英数字と `._:+-` の 1〜100 字（app は空白なしの印字可能な ASCII を受けるが、`--set-env-vars` の区切りになるカンマを避けるため狭めた） |
| `STG_MAIL_FROM` | NIHO app の領収書と同じ送信者。`表示名 <アドレス>`（表示名のあとに半角空白 1 つ）かアドレスだけ。表示名にカンマ・`<>"`・改行を入れない |
| `STG_MAIL_REPLY_TO` | NIHO サポートの Reply-To。形は `STG_MAIL_FROM` と同じ |
| `STG_PRIVACY_POLICY_URL` | 任意。NIHO のプライバシーポリシーの https URL（小文字の host とパスだけ。query・カンマ・認証情報なし） |

Secret の参照（`secret-name:VERSION`、数字 version だけ。workflow は下の Secret 名に固定した正規表現で検査する）：

| Environment Variable | Secret 名（値は書かない） | Cloud Run 環境変数 | 持ち主 |
| --- | --- | --- | --- |
| `STG_SMTP_HOST_REF` | `RECEIPT_DELIVERY_SMTP_HOST` | `EXPERIENCE_SMTP_HOST` | NIHO app 既存 |
| `STG_SMTP_PORT_REF` | `RECEIPT_DELIVERY_SMTP_PORT` | `EXPERIENCE_SMTP_PORT` | NIHO app 既存 |
| `STG_SMTP_USER_REF` | `RECEIPT_DELIVERY_SMTP_USER` | `EXPERIENCE_SMTP_USER` | NIHO app 既存 |
| `STG_SMTP_PASSWORD_REF` | `RECEIPT_DELIVERY_SMTP_PASSWORD` | `EXPERIENCE_SMTP_PASSWORD` | NIHO app 既存 |
| `STG_STRIPE_PLATFORM_SECRET_KEY_REF` | `STRIPE_CONNECT_PLATFORM_SECRET_KEY` | `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY` | NIHO app 既存（Connect プラットフォームの鍵。staging はテストの鍵） |
| `STG_STRIPE_WEBHOOK_SECRET_REF` | `experience-stg-stripe-webhook-secret` | `EXPERIENCE_STRIPE_WEBHOOK_SECRET` | 新規（このサービスの webhook endpoint の署名鍵） |
| `STG_ANTHROPIC_API_KEY_REF` | `NIHO_TRANSLATE_ANTHROPIC_API_KEY` | `EXPERIENCE_ANTHROPIC_API_KEY` | NIHO app の既存（`STG_TRANSLATION_ENABLED=true` のときだけ） |

### 順番

1. 前提：experience DB に main の migration（`0032` まで）を `apply-experience-db-migrations.mjs` で適用し、runtime の権限を宣言に合わせてある（上の「以降のmigrationとruntime権限」）。上の初期設定・Secret・固定 URL の準備と配備ができている。
2. **setup**：管理者がレビュー済み SHA から実行する。明示的な GCP 変更である。

   ```sh
   CONFIRM_HOST_STAGING_GUEST_BOOKING_SETUP=niho-app-stg \
   STG_HOST_SERVICE_URL="<Environment Variable と同じ stable URL>" \
     bash scripts/gcp/setup-host-staging-guest-booking.sh
   ```

   URL が `https://niho-experience-host-stg-….a.run.app` の形でない、または実際の service の URL と違えば止まる。Cloud Scheduler API を有効にし、`experience-stg-stripe-webhook-secret` を version なしで作り、runtime に上の 6 個の Secret だけ resource 単位の `secretAccessor` を付け、`experience-jobs` を project の role なしで作って対象 service の `run.invoker` だけを付け、Scheduler job を作ってすぐ一時停止する（作成時に一時停止で作る flag が無い。その間に 1 回呼ばれても、gate が off なら 404 で何も変えない）。既存の job は検査だけで、変更・再開しない（設定が違えば止まる）。NIHO app の Secret が無ければ止まり、作らない。Secret の値と version を読まず、表示しない。既存の `setup-host-staging.sh` は変えない。
3. **Secret の version**：Stripe のテストモードで、NIHO のプラットフォームアカウントに webhook endpoint `{STG_HOST_SERVICE_URL}/api/experience/stripe/webhook` を作る。connected account のイベントを受ける（Connect の）endpoint とし、`checkout.session.completed`・`checkout.session.async_payment_succeeded`・`checkout.session.expired`・`checkout.session.async_payment_failed`・`refund.created`・`refund.updated`・`refund.failed` を購読する（[guest-booking.md](guest-booking.md) の「体験の登録と切替」の前提）。署名鍵はこの endpoint からしか出ないので、endpoint を先に作り、その署名鍵を安全な管理端末から `experience-stg-stripe-webhook-secret` に version として足す（標準出力・shell 履歴に出さない）。NIHO app の既存 endpoint とその鍵は変えず、流用しない。NIHO app の 5 個の Secret は値を変えず、NIHO app の stg が使っている数字 version を `gcloud secrets versions list` で確かめる。
4. **Variables**：`host-staging` Environment に上の Variable と 6 個の `*_REF` を設定し、`STG_GUEST_MAIL_ENABLED=true`・`STG_GUEST_QUESTIONS_ENABLED=true` にしてから、最後に `STG_GUEST_BOOKING_ENABLED=true` にする。
5. **配備**：上の「手動配備と受入」と同じく `candidate` → `promote`。summary は「Stripe test bookings open」と `bookings=true (Stripe test mode)` になる。
6. **Scheduler の再開**：昇格のあと `gcloud scheduler jobs resume experience-jobs-drain-stg --project niho-app-stg --location asia-northeast1`。次の実行が 200 で終わることを Scheduler の実行記録で確かめる（401 は audience かサービスアカウントの不一致、404 は配信中の revision で gate が off、503 は Google の鍵・DB・SMTP）。
7. **体験の登録**：合成の提供者・テストの Connect 口座で `scripts/experience/register-site-sale.mjs`（[guest-booking.md](guest-booking.md) の「体験の登録と切替（第9段）」）を流す。`plan` が出す鍵の種類が `test` であることを確かめ、`live` なら止めて Secret の version を見直す。

止めるとき：`stop-sale --yes` で販売条件を消し、仮押さえの期限（35 分）と返金の完了を待つ。Scheduler を一時停止してから `STG_GUEST_BOOKING_ENABLED` を `false` に戻して配備・昇格する（出欠の `STG_HOST_ATTENDANCE_ENABLED` も予約が前提なので、先に `false` にする）。gate を戻すと Stripe の秘密も revision から外れ、それ以降の webhook は処理されない。

### 受入（Stripe テストモード）

Google Chrome でブラウザ名と stable URL を確かめてから行う。予約者のアドレスはテスト用の受信箱を使う。

1. **体験ページ**：登録した体験の英語の詳細に日程と予約の入口が出て、残席・料金・質問が入力どおり。ほかの商品は NIHO のまま。`robots.txt` が `Disallow: /` のまま。
2. **予約**：Stripe のテストカード（`4242 4242 4242 4242`、未来の期限、任意の CVC）で 1 件予約する。`/booking/return` は予約の完了を約束しない。Stripe のテストモードで endpoint への配信が 2xx、`/host/bookings` に確定として出る。NIHO app 側の予約・台帳が増えない（NIHO の既存 webhook がこの Session を処理しない）。
3. **確認メール**：Scheduler の次の実行（1 分以内）で「Your booking is confirmed」が届く。From・Reply-To が設定どおりで、リンクの origin が stable URL。
4. **予約ページ**：メールのリンクから「Open your booking」で `/bookings/{id}` が開く。cookie `__Host-nb_…` が `HttpOnly`・`Secure`・`SameSite=Lax`。使用済みのリンクは開けない。`/bookings` の「Find your booking」で同じアドレスにリンクのメールが届く。
5. **メッセージ**：予約ページから送ると OWNER の `/host/messages` に出る。ホストの返信は次の job の実行でメールになり、予約ページに出る。体験ページの「Ask the host」から質問し、返信メールの `/questions/reply` で答えられる。
6. **取消と返金**：予約者が無料取消の期限内に「Cancel and get a full refund」で取り消し、Stripe のテストモードで返金ができ、`refund.*` の webhook のあと取消のメールが届く。別の予約で OWNER の取消（予約 1 件）も確かめる。サポートの取消・承認（Admin）は staging で開いていないので対象外。
7. **ホストの画面**：OWNER で予約・ホーム・この回（予約者の電話はここだけ）にこの予約が出る。OWNER でない・別の提供者のアカウントでは見えない。
8. **翻訳（英語にする）**：`STG_TRANSLATION_ENABLED` が off の間は、「英語にする」は使えないことを伝える文（`REPLY_DRAFT_UNAVAILABLE_TEXT`）を出し、旅行者の英語の日本語訳も作られない（訳の待ち行は残り、on にすると古いものから訳す）。on にしたら、旅行者の文の訳はメール job の次の実行（毎分、1 回 10 件・60 秒まで）で `/host/messages` に出て、「英語にする」はその場で（15 秒まで）下書きを返すことを確かめる。

#285 へは SHA・image digest・項目と成否・未実施の理由だけを残す。予約者の名前・アドレス・電話、予約番号、grant・cookie、Stripe の ID、メールの本文、スクリーンショット内の個人情報を公開しない。
