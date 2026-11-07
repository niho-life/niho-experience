# 本番候補の配備と公開ゲート

対象: [#5](https://github.com/niho-life/niho-experience/issues/5)、[#15](https://github.com/niho-life/niho-experience/issues/15)、[#92](https://github.com/niho-life/niho-experience/issues/92)、[#84](https://github.com/niho-life/niho-experience/issues/84)（機能のフラグ）。2026-11-08 更新。**販売開始、検索公開、外部提供者登録、ホストのカレンダーは別々に受入する。**

## 固定する構成

| 項目 | 設定 |
| --- | --- |
| GCP | 初期pilotは既存 `niho-app-prd` を共用し、Cloud Runサービス・実行ID・配備権限を分離。`asia-northeast1` |
| Cloud Run | `niho-experience`、`experience-runtime`（権限なし）、1 vCPU / 512 MiB、候補段階は min 0 / max 2 |
| イメージ | 本リポのレビュー済み `main` の40文字SHA。資格情報なしで build と smoke を行い、SHA256確認済みのイメージだけを配備jobへ渡す |
| 配備権限 | `experience-deployer` に `niho-experience` サービス単位の `roles/run.admin`、専用Artifact Registryのwriter、runtime SAだけのService Account Userを付与。専用 Workload Identity Pool は GitHub repository ID `1425500695`、`refs/heads/main`、`production` environment、手動起動、`deploy-production.yml` の同時一致を要求 |
| GitHub | `production` environment は `main` のみ。owner決定（2026-11-03）によりrequired reviewerは不要。起動者IDと再実行者をworkflowで検査し、WIFも本人IDへ限定。`PRODUCTION_DEPLOY_ENABLED=true` は設定が揃うまで付けない |
| 初期revision | `EXPERIENCE_API_MODE=http`、`EXPERIENCE_PUBLIC_API_VERSION=1.0`、`EXPERIENCE_GUIDE_PUBLIC_SOURCE=static`、`SITE_URL=https://experience.niho.life`、`NEXT_PUBLIC_NIHO_WEB_ORIGIN=https://niho.life`、`SITE_INDEXING=allow`（オーナー決定 2026-11-07。それまでは `block`）、`BOOKINGS_ENABLED=false`、`HOST_SIGNUP_MODE=pilot`、`NIHO_HOST_START_URL=https://niho.life/experiences/provider`、`GUIDE_EDITOR_SITE_ORIGIN=https://editor.niho.life`、`HOST_CONSOLE_ENABLED=false`。`MOCK_CATALOG` と `UMAMI_WEBSITE_ID` は渡さない |

初期pilotでは既存の `niho-app-prd` にCloud Runサービスと限定した配備IDを足し、既存のglobal external Application Load BalancerとCloudflare proxyを再利用する。新規プロジェクト作成と新しいロードバランサーは不要。GCP project Owner、請求、API有効化、クォータの管理境界は共有する一方、GitHub deployerのCloud Run Adminは `niho-experience` サービスだけに付け、既存アプリのサービス・runtime identity・DB/Secretsへ権限を与えない（[Cloud Runのリソース単位IAM](https://docs.cloud.google.com/run/docs/securing/managing-access)）。売上や取り扱いデータが増える、組織ポリシー・障害範囲・請求分離が必要になる段階では専用GCP projectへ移行する。Googleは Cloud Run domain mapping をproductionに推奨していないため、DNS onlyのdomain mappingは採らない。Cloud RunはALB経由だけを受けるingressとし、候補も読み取り専用の専用edge経路で確認する。プレビュー用deployerに本番権限は付けない。

## 初回準備（本番設定の確認後）

### 独立認証の本番有効化（#456、2026-11-07）

ホストと Admin の本人確認・口座の正本は [ADR 0003](adr/0003-experience-independence.md) に従う。以下の手順では NIHO Host v1 の配備・NIHO の口座再利用同意を前提にしない。この節を、後述の旧 NIHO 認証を使う有効化手順より優先する。

1. レビュー済みの main SHA を固定し、公式の `apply-experience-db-migrations.mjs` で `0064`〜`0066` と runtime grants を適用する。既存予約・販売者・公開版の件数を事前に確認する。実レコードとアドレスは公開の証跡へ書かない。
2. Stripe は既存 NIHO プラットフォームを使い、Experience 専用の制限付きキーを Secret Manager に登録する。NIHOapp の全権限キーを Experience runtime に渡さない。現行コードに必要な権限は、接続口座の Checkout Sessions・Charges and Refunds の書込み、Payment Intents・Balance・Balance Transaction Sources・Payouts の読取り、Accounts・Application Fees の読取り、Login Links・Transfers の書込み。新規口座の作成はまだ開かないので、Accounts・Account Links の書込みは不要。
3. 予約を開く場合は、Experience 専用の Connect webhook と署名鍵、checkout IP HMAC 鍵も用意する。webhook のイベントは [staging の予約設定](host-calendar-staging.md#旅行者の予約stripe-テストモード285) と同じ。既存 NIHOapp の webhook と署名鍵は変更しない。
4. SMTP は NIHOapp の既存 `RECEIPT_DELIVERY_SMTP_*` を使える。同一の送信先サーバー・ポート・アカウントであることを照合し、送信せずに TLS と SMTP 認証を確認する。2026-11-07 は staging で認証できる既存資格情報を本番の `RECEIPT_DELIVERY_SMTP_PASSWORD:2` に登録した。既存版は保持する。runtime へは各 Secret 単位で読取りを許可する。From・Reply-To は既存の NIHO の送信者を用いる。
5. Google OAuth の本番 callback と、既存管理者本人のアドレスを照合して `PROD_ADMIN_ALLOWED_EMAILS` を設定する。`PROD_PROVIDER_PAGES_API_ENABLED` など、ホストの NIHO トークンを使う競合 flag を外す。`PROD_GUEST_MAIL_ENABLED`・`PROD_HOST_ACCOUNTS_ENABLED`・`PROD_ADMIN_SUPPORT_CONSOLE_ENABLED`・`PROD_ADMIN_GOOGLE_LOGIN_ENABLED` と、承認済み `PROD_PAYOUT_ACCOUNT_CONSENT_VERSION=experience-payout-account-2026-11-07-v1` を設定する。
6. 最初の OWNER と販売者は [ホストアカウントの登録手順](host-accounts.md#登録ops) で登録する。事業者・既存接続口座・OWNER を照合し、同意や公開を運用 SQL で代行しない。実アドレス・口座 ID をリポ・GitHub の本文へ置かない。
7. staging の合成体験で予約・Stripe テスト決済・確定 webhook・取消／返金まで確認する。`run.app` の直アクセスには Cloudflare の `CF-Connecting-IP` が無いため、ブラウザからの checkout は安全のため 503 になる。予約を開く受入には、このヘッダーを上書きする信頼できる edge 経路と、origin への直アクセスの制限が必要。欠けたヘッダーを任意のクライアント値へ fallback させない。
8. 公式 workflow の `candidate` → 候補確認 → 同じ SHA・revision・digest の `promote`。メールログイン、許可済み Admin、公開データ、予約停止、既存 Guide を確認する。予約・公開の gate はそれぞれの受入後に開く。Secret の登録だけ、DB 移行だけ、または候補の作成だけを、本番有効化済みと扱わない。

1. `@niho.life` の `niho-app-prd` Ownerで `ORG_ID=299180592876 PROJECT_ID=niho-app-prd ALLOW_SHARED_NIHO_APP_PROJECT=true bash scripts/gcp/setup-production.sh` を実行する。既存請求先は確認するだけで変更しない。スクリプトは専用Artifact Registry、runtime/deployer SA、GitHub OIDC pool/providerを作り、認証必須のprivate bootstrap serviceを用意する。公開host ruleは候補revisionの昇格まで追加しない。deployerの `roles/run.admin` はこのCloud Run serviceにだけ付与する。出力されたGitHub variablesを記録する。
2. GitHubの `production` environment が **mainのみのbranch rule** を持ち、prod WIFの `actor_id` が `252574334`（niho3 / ghN）、`345803507`（taku-niho / ghL）、`119937906`（takuyatakahama3）の3件だけであることを確認する。本人起動・再実行ガードをmainへ反映してからrequired reviewersを外す。元のEnvironment/provider設定を保存し、rollback時はreviewersを先に戻す。スクリプトが出した `PROD_GCP_*` 6変数をrepository variablesに登録する。preview用 `GCP_*` と混ぜない。最後に `PRODUCTION_DEPLOY_ENABLED=true` を登録する。
3. `.github/workflows/deploy-production.yml` を `main` から `action=candidate` で手動起動し、入力 `commit_sha` を起動時の `main` SHA と完全一致させる。ホストカレンダーの受入前は `enable_host_calendar=false` を選ぶ。workflow は資格情報なしで build/smoke → 保護環境で image push → digest固定の `--no-traffic --tag candidate-<sha12>` → NIHO本番公開APIの一覧・revision専用URL・runtime env・robots・preview 404 を確認する。APIが未配備で404なら候補を受け入れない。実行結果に出るSHA・revision・**Cloud Run実行用image digest**・候補URLを確認する。DockerがOCI indexをpushした場合、Cloud Runの実行用digestはその `linux/amd64` 子manifestとなる。workflowは親子関係を検証し、両方のdigestを記録する。
4. 候補URLを確認して受け入れた後、別の手動実行で `action=promote` を選び、候補実行の同じ `commit_sha`、`candidate_revision`、**実行用digest** を `candidate_image_digest` に、同じ `enable_host_calendar` を入力する。保護環境で既存revisionのcommit label・不変image digest・停止設定・候補URLを再検証し、そのrevision自体を昇格する。promotionではbuild・image push・再配備を行わない。候補SHA・revision・digest・配備run・環境変数・HTTP結果を #15 に記録する。予約停止は維持する。検索はオーナー決定（2026-11-07）で公開し、候補と昇格の前に robots.txt・sitemap・トップの `robots` を確かめる。

`--set-env-vars` に渡す初期8項目、`HOST_CONSOLE_ENABLED`、下の「[機能のフラグ](#機能のフラグ84)」が本サービスの runtime 設定全量である。`enable_host_calendar=false` はカレンダー用 Secret と Cloud SQL 接続を除去し、`/host/calendar` の404を確認する。`true` は次の受入条件を満たした場合だけ選ぶ。固定の管理入口は候補作成・昇格前とプレビューでrevision設定とHTMLから確認する。管理リンクの認証・登録・口座状態はNIHOが判定し、セルフ登録の公開設定とは区別する。運用で値を足す際は workflow（機能のフラグなら `scripts/deploy/runtime-flags.mjs` の表）を同時に更新し、Cloud Run画面での一時変更を正本としない。`UMAMI_WEBSITE_ID` はポリシーの追記後、別PRで本番だけに追加する。

### ホストカレンダーの本番候補を有効にする条件（#92）

1. NIHO app-connect Web・ホストAPI（niho-app #19282、#19283）を先にマージしてstgへ配備し、`APP_CONNECT_WEB_ORIGINS` に対象サイトのexact originを登録する。NIHOアカウントでのログイン、提供者権限、再認証、ログアウトをstgで確認する。本番NIHOへの反映はその後に行う。
2. 体験専用PostgreSQL DB `experience_prd` を `gcloud sql databases create` で作り、`CONFIRM_EXPERIENCE_DB_MIGRATE=niho-app-prd` を付けて `niho-app` の `niho-db.sh prd --via-bastion -- node scripts/gcp/apply-experience-db-migrations.mjs` を実行する。空のDBではscriptが先にruntime接続URLをSecret `experience-prd-database-url` の新versionへ保管し、NOLOGINの `experience_prd_migrator` と限定LOGINの `experience_prd_runtime` を作って、`packages/experience-store/migrations/` の全SQLファイルを辞書順（両方の `0010` を含む。`0006` は停止・旧revision drain・snapshot後に適用。詳細は [体験業務の移行手順](experience-runtime.md)）に移行専用IDで適用し、runtimeの権限を宣言どおりに付ける（手順の詳細は [stg手順](host-calendar-staging.md#以降のmigrationとruntime権限)）。出力された `RUNTIME_DATABASE_URL_REF` が `PROD_EXPERIENCE_DATABASE_URL_REF` の値になる。Cloud Run実行IDには `roles/cloudsql.client` を[対象instanceに限るIAM条件](https://docs.cloud.google.com/sql/docs/postgres/iam-conditions)付きで付け、DBユーザーにも体験専用DBの権限だけを与える。既存のprivate IPのみ・connector必須のinstanceへ接続するため、候補はCloud SQL接続と `default` VPC/subnetへのDirect VPC egress（private rangesのみ）を併用し、双方を検査する。`0009`/`0010` の private bucket、uniform access、public access prevention、runtime IAM と `GUIDE_MEDIA_BUCKET` は [Guide CMS](guide-cms.md) に従い、editor flag とGuide public sourceは受入までOFF/staticを維持する。`provider_memberships` は権限を確認した非公開の移行処理で投入し、公開リポ・CI・ログに実IDを記録しない。
3. Google OAuth Web clientに `https://experience.niho.life/host/calendar/google/callback` を許可し、同意画面の状態を確認する。ExperienceのCalendar接続が要求するscopeは `calendar.calendarlist.readonly`、`calendar.events.freebusy`、`calendar.app.created`。下表のSecret Manager secretへ値を保存し、Cloud Run実行IDへ対象SecretのAccessorだけを付与する。値と接続URLはGitHub変数やPRに書かない。`EXPERIENCE_DATABASE_URL` はその専用DBを指し、Cloud SQL接続に対応させる。
4. stgで本人のGoogle接続・読み取り元予定のbusy表示・繰り返し枠の競合・切断/失効・他提供者からのアクセス拒否を確認する。**現行NIHO予約枠にはGoogle busyはまだ反映されない**ので、既存販売枠はNIHO側で閉じる。候補の無認証HTTP検査は画面の存在と設定を確認するだけで、この本人操作の代わりにはならない。
5. stg受入証跡を #92 に記録してから、GitHub repository variablesに下表のSecret参照と `PROD_EXPERIENCE_CLOUDSQL_INSTANCE`（`project:region:instance`）を設定し、最後に `PROD_HOST_CALENDAR_READY=true` を入れる。候補と昇格の双方で `enable_host_calendar=true` を選ぶ。workflowはSecret参照の数値version固定、Cloud SQL instanceのproject一致、6設定の参照、`/host` のログイン導線、`/host/calendar` の存在を検査する。候補のOAuth redirectは `SITE_URL` の本番hostを指すため、tagged revisionのURLで実際のGoogle接続を完了できない。昇格直後に本番hostで本人がログイン・Google接続・busy反映を確認し、失敗したら直前revisionへ戻す。

| GitHub repository variable（Secret名と数値versionだけ） | Secret Manager secret名 | Cloud Run環境変数 |
| --- | --- | --- |
| `PROD_HOST_SESSION_SECRET_REF` | `experience-prd-host-session` | `HOST_SESSION_SECRET` |
| `PROD_NIHO_FIREBASE_WEB_API_KEY_REF` | `experience-prd-niho-firebase-web-api-key` | `NIHO_FIREBASE_WEB_API_KEY` |
| `PROD_EXPERIENCE_DATABASE_URL_REF` | `experience-prd-database-url` | `EXPERIENCE_DATABASE_URL` |
| `PROD_EXPERIENCE_GOOGLE_CLIENT_ID_REF` | `experience-prd-google-client-id` | `EXPERIENCE_GOOGLE_CLIENT_ID` |
| `PROD_EXPERIENCE_GOOGLE_CLIENT_SECRET_REF` | `experience-prd-google-client-secret` | `EXPERIENCE_GOOGLE_CLIENT_SECRET` |
| `PROD_EXPERIENCE_GOOGLE_TOKEN_KEY_REF` | `experience-prd-google-token-key` | `EXPERIENCE_GOOGLE_TOKEN_KEY` |

Cloud Run側はSecretの数値versionを固定する。鍵を更新するときはSecretに新versionを作り、参照変数を更新して新しい候補revisionを作る。`PROD_HOST_CALENDAR_READY` をfalseに戻しても既存revisionの公開状態は変わらない。緊急停止は前の `enable_host_calendar=false` revisionへtrafficを戻し、NIHO側の旧枠も別途止める。

### 機能のフラグ（#84）

mock で出している機能を http mode で開くフラグを、repository variable `PROD_*` で候補 revision に渡す。どれも**未設定か `false` なら OFF**（そのフラグの環境変数・設定・Secret の参照を revision に載せない）で、今の候補は変わらない。

- **表は 1 つ**：`scripts/deploy/runtime-flags.mjs` の `FLAGS`。stg（`STG_*`）と本番（`PROD_*`）の workflow が同じ表を使う。
- **配備の前に検査**：候補・昇格の両方で、資格情報を得る前にこの script が variable を読み、次を確かめる。足りなければ variable の名前（値は出さない）を `::error` に出して止まる。
  - フラグの値が `true`・`false`・未設定のどれか
  - 下の「前提」のフラグが ON か。ホストの画面と DB は `enable_host_calendar=true` のときだけ配線されるので、`false` の候補ではどのフラグも ON にできない
  - 要る設定の形と、Secret の参照が `secret-name:数字version` か
  - 前提は `apps/web/src/lib/resolve-config.ts` の規則と同じ。加えて、予約にはメールを要る（確認メールと予約ページのため）。`apps/web/src/lib/deploy-runtime-flags.test.ts` が、表の各フラグの出力を `resolveConfig` に通して、起動が失敗せずフラグが ON になることを確かめる
- **host consoleの基礎設定**：`enable_host_calendar=true` なら `PROD_NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE=https://api.niho.life` を常に設定する。NIHO本人確認のservice ID token向けaudienceであり、Experience公開API flagとは独立する。Host v1 APIが未配備・未受入なら `HOST_PUBLICATION_API_ENABLED` はOFFのまま。
- **配備後の検証**：候補の revision の環境変数と Secret の参照のうち、表が扱う名前が、script の期待と完全に一致することを確かめる（余分なフラグも欠けも失敗）。昇格のときも variable を読み直して同じ検査をするので、候補を作ったあとで variable を変えると昇格は止まる。
- **本番の `BOOKINGS_ENABLED` は `false` のまま**：予約のフラグを ON にしても checkout は `UNAVAILABLE` を返す。販売の開始は下の「個別ゲートと切戻し」の「予約・販売」で別に判断する。

| フラグ（Cloud Run） | variable（`PROD_` の後ろ） | 前提 | 設定（variable、`PROD_` の後ろ） | Secret の参照（`PROD_` の後ろ）→ 環境変数 | workflow が入れる値 |
| --- | --- | --- | --- | --- | --- |
| `ADMIN_SUPPORT_CONSOLE_ENABLED` | `ADMIN_SUPPORT_CONSOLE_ENABLED` | ホストの画面・DB（配備capability） | — | `ADMIN_SESSION_SECRET_REF` → `ADMIN_SESSION_SECRET`（専用の32文字以上の乱数、数値version固定） | `NIHO_EXPERIENCE_ADMIN_ORIGIN`＝サイトのURL |
| `EXPERIENCE_GUEST_BOOKING_ENABLED` | `GUEST_BOOKING_ENABLED` | ホストの画面・DB、メール | `BOOKING_CONSENT_VERSION`、`PRIVACY_POLICY_URL`（任意） | `STRIPE_PLATFORM_SECRET_KEY_REF` → `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET_REF` → `EXPERIENCE_STRIPE_WEBHOOK_SECRET` | — |
| `EXPERIENCE_GUEST_MAIL_ENABLED` | `GUEST_MAIL_ENABLED` | DB | `MAIL_FROM`、`MAIL_REPLY_TO` | `SMTP_HOST_REF`・`SMTP_PORT_REF`・`SMTP_USER_REF`・`SMTP_PASSWORD_REF` → `EXPERIENCE_SMTP_*` | `EXPERIENCE_JOBS_AUDIENCE`＝サイトの URL、`EXPERIENCE_JOBS_SERVICE_ACCOUNT_EMAIL`＝`experience-jobs@<project>` |
| `EXPERIENCE_PUBLICATIONS_ENABLED` | `PUBLICATIONS_ENABLED` | ホストの画面・DB | `PUBLICATION_CONSENT_VERSION`、`PUBLIC_MEDIA_BUCKET` | DB capability → `EXPERIENCE_DATABASE_URL` | — |
| `EXPERIENCE_HOST_PUBLICATION_API_ENABLED` | `HOST_PUBLICATION_API_ENABLED` | Experience publications | — | — | — |
| `EXPERIENCE_PROVIDER_PAGES_API_ENABLED` | `PROVIDER_PAGES_API_ENABLED` | legacy NIHO provider-pages consumer（有効化禁止） | — | — | — |
| `EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED` | `PROVIDER_OPERATIONS_API_ENABLED` | ホストの画面・DB | — | — | — |
| `EXPERIENCE_TRANSLATE_API_ENABLED` | `TRANSLATE_API_ENABLED` | ホストの画面・DB | — | — | — |
| `EXPERIENCE_GUEST_QUESTIONS_ENABLED` | `GUEST_QUESTIONS_ENABLED` | ホストの画面・DB、Provider APIとは併用不可 | — | — | — |
| `EXPERIENCE_TRANSLATION_ENABLED` | `TRANSLATION_ENABLED` | メールか質問 | — | `ANTHROPIC_API_KEY_REF` → `EXPERIENCE_ANTHROPIC_API_KEY` | — |
| `EXPERIENCE_GUEST_REVIEWS_ENABLED` | `GUEST_REVIEWS_ENABLED` | DB | — | — | — |
| `EXPERIENCE_HOST_ATTENDANCE_ENABLED` | `HOST_ATTENDANCE_ENABLED` | 予約 | — | — | — |
| `HOST_SALES_LEDGER_ENABLED` | `HOST_SALES_LEDGER_ENABLED` | ホストの画面・DB | — | — | — |
| `HOST_SALES_PAYOUTS_ENABLED` | `HOST_SALES_PAYOUTS_ENABLED` | 売上（台帳） | — | `STRIPE_PLATFORM_SECRET_KEY_REF` → `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY` | — |
| `HOST_NOTIFICATION_SETTINGS_ENABLED` | `HOST_NOTIFICATION_SETTINGS_ENABLED` | ホストの画面・DB | — | — | — |
| `EXPERIENCE_HOST_CALENDAR_FEED_ENABLED` | `HOST_CALENDAR_FEED_ENABLED` | ホストの画面・DB | — | `CALENDAR_FEED_KEY_REF` → `EXPERIENCE_CALENDAR_FEED_KEY` | — |
| `HOST_PWA_ENABLED` | `HOST_PWA_ENABLED` | ホストの画面 | — | — | — |
| `HOST_PUSH_ENABLED` | `HOST_PUSH_ENABLED` | PWA・DB | `HOST_PUSH_VAPID_PUBLIC_KEY`、`HOST_PUSH_VAPID_SUBJECT` | `HOST_PUSH_VAPID_PRIVATE_KEY_REF` → `HOST_PUSH_VAPID_PRIVATE_KEY` | `HOST_PUSH_JOB_AUDIENCE`＝サイトの URL、`HOST_PUSH_JOB_SERVICE_ACCOUNT_EMAIL`＝`experience-host-push@<project>` |
| `EXPERIENCE_GOOGLE_BUSY_SYNC_ENABLED` | `GOOGLE_BUSY_SYNC_ENABLED` | ホストの画面・DB | — | — | `EXPERIENCE_GOOGLE_JOBS_AUDIENCE`＝サイトの URL、`EXPERIENCE_GOOGLE_JOBS_SERVICE_ACCOUNT_EMAIL`＝`experience-google-jobs@<project>` |
| `EXPERIENCE_GOOGLE_BOOKING_EVENTS_ENABLED` | `GOOGLE_BOOKING_EVENTS_ENABLED` | ホストの画面・DB | — | — | 上と同じ |
| `EXPERIENCE_OTA_GUEST_DETAILS_ENABLED` | `OTA_GUEST_DETAILS_ENABLED` | DB、メール（1 年後の消去） | — | — | — |
| `EXPERIENCE_OTA_BOOKING_NOTIFICATIONS_ENABLED` | `OTA_BOOKING_NOTIFICATIONS_ENABLED` | push・DB | — | — | — |
| `EXPERIENCE_HOST_MAIL_ENABLED` | `HOST_MAIL_ENABLED` | ホストの画面・DB、メール | — | — | — |
| `EXPERIENCE_HOST_ACCOUNTS_ENABLED` | `HOST_ACCOUNTS_ENABLED` | ホストの画面・DB、メール。提供者の運営・旧 provider pages・通訳・記事連携の API とは併用不可 | `PAYOUT_ACCOUNT_CONSENT_VERSION` → `EXPERIENCE_PAYOUT_ACCOUNT_CONSENT_VERSION` | `STRIPE_PLATFORM_SECRET_KEY_REF` → `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY` | — |
| `EXPERIENCE_JAPANESE_SITE_ENABLED` | `JAPANESE_SITE_ENABLED` | ホストの画面・DB（配線のため。機能は公開サイト） | — | — | — |
| `EXPERIENCE_CHANNEL_WATCHDOG_ENABLED` | `CHANNEL_WATCHDOG_ENABLED` | ホストの画面・DB | — | — | `EXPERIENCE_CHANNEL_WATCHDOG_AUDIENCE`＝サイトの URL、`EXPERIENCE_CHANNEL_WATCHDOG_SERVICE_ACCOUNT_EMAIL`＝`experience-ota-watchdog@<project>` |
| `EXPERIENCE_CHANNEL_MANAGER_ENABLED` | `CHANNEL_MANAGER_ENABLED` | Admin（`ADMIN_SUPPORT_CONSOLE_ENABLED`）・DB | — | — | — |
| `EXPERIENCE_ADMIN_GOOGLE_LOGIN_ENABLED` | `ADMIN_GOOGLE_LOGIN_ENABLED` | Admin（`ADMIN_SUPPORT_CONSOLE_ENABLED`）・ホストの画面・DB（Google OAuth はホストの画面の配線が入れる）。NIHO の Admin トークンを使う API とは併用不可 | `ADMIN_ALLOWED_EMAILS` → `EXPERIENCE_ADMIN_ALLOWED_EMAILS`（`@niho.life` の小文字のアドレスを `;` で区切る） | — | — |
| `EXPERIENCE_CHANNEL_RUNTIME_ENABLED` | `CHANNEL_RUNTIME_ENABLED` | 掲載先の設定（manager）、watchdog、DB | `CHANNEL_SUPPORTED_ADAPTERS` → `EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS`（短い書式） | — | — |
| `EXPERIENCE_RESOURCE_GOOGLE_ENABLED` | `RESOURCE_GOOGLE_ENABLED` | ホストの画面・DB（Google OAuth の 3 つはホストの画面の配線が入れる） | — | — | — |
| `EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED` | `RESOURCE_GOOGLE_WATCH_ENABLED` | リソースごとの Google | — | — | `EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL`＝サイトの URL ＋ `/api/google/calendar/watch` |
| `EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED` | `AIRBNB_GOOGLE_SETUP_ENABLED` | ホストの画面・DB（Google OAuth は上と同じ） | — | — | — |
| `EXPERIENCE_AIRBNB_GOOGLE_ACTIVATION_ENABLED` | `AIRBNB_GOOGLE_ACTIVATION_ENABLED` | Airbnb×Google の設定（SETUP） | — | — | — |
| `EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED` | `AIRBNB_GOOGLE_DELIVERY_ENABLED` | OTA の runtime | — | — | — |
| `EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED` | `AIRBNB_GOOGLE_OBSERVATION_ENABLED` | Airbnb×Google の反映（DELIVERY） | — | — | — |

- OTA の 2 つ（#194）は、OTA の予約の取込みそのものは開かない（取込みは channel runtime の設定のまま）。`0036` を先に適用する。[外部予約台帳](ota-external-reservations.md)の「予約者の情報（#194）」「ホストへの通知（#194）」。
- ホストへのメール（#194、オーナー決定 2026-11-01）：ログインのときに NIHO の確認済みのメールを写し、設定 › 通知で宛先を変えられ、新しい予約・取消・日時変更をメールでも知らせる。メールはメール job が送るので、メール（`EXPERIENCE_GUEST_MAIL_ENABLED`）が要る。新しい Secret・Scheduler・サービスアカウントは無い。**`0038` を新しいコードより先に適用する**（予約の確定・取消と OTA の台帳の transaction が、宛先の表を読んで行を積むため。フラグが off でも読む。off の間は宛先が 1 件も無いので行は積まれない）。[guest-booking.md](guest-booking.md) の「ホストへの通知」。
- ホストのアカウント（ADR 0003、[host-accounts.md](host-accounts.md)）の `HOST_ACCOUNTS_ENABLED` は、`/host` のログインを NIHO から Experience 自前のメールのログインリンクに切り替える。リンクはメール job が送るので、メール（`EXPERIENCE_GUEST_MAIL_ENABLED`）が要る。ホストの NIHO トークンを NIHO へ送るフラグ（`PROVIDER_OPERATIONS_API_ENABLED`・`PROVIDER_PAGES_API_ENABLED`・`TRANSLATE_API_ENABLED`・`HOST_ARTICLE_LINKS_ENABLED`）と同時には ON にできず、配備前の検査で止まる（表に無い `HOST_SUPPORT_*`・`EXPERIENCE_FEE_SUMMARY_API_ENABLED` も、起動時に止まる）。**`0064` と `0065` を先に適用する**。この方式では受取口座を Stripe へ直接照会し、OWNER が Experience で口座の利用に版付きで同意する（3 段目）。そのため表は `PAYOUT_ACCOUNT_CONSENT_VERSION`（同意文の版。文言を変えたら版を上げる）と Stripe のプラットフォームのキー（予約・入金と同じ参照）をこのフラグに求める。起動時の検査が両方を必須にするのは `HOST_PUBLICATION_API_ENABLED` も ON のときだが、表は先に求めて、公開 API を後から開けても欠けないようにする。公開 API はこの方式では NIHO を呼ばない（NIHO の audience は host console の基礎設定として残る）。新しい Scheduler・サービスアカウントは無い。
- Admin のログイン（ADR 0003 の 4、[admin-auth.md](admin-auth.md)）の `ADMIN_GOOGLE_LOGIN_ENABLED` は、`/admin` のログインを NIHO の Admin session から、`niho.life` の Google アカウントと Experience の許可リスト（`ADMIN_ALLOWED_EMAILS`）に切り替える。セッションは Experience の DB に置き、NIHO を呼ばない。**`0066` を先に適用し**、Google Cloud コンソールで Experience の OAuth クライアント（`EXPERIENCE_GOOGLE_CLIENT_ID`）の承認済みリダイレクト URI に `https://experience.niho.life/admin/auth/google/callback` を操作者が追加してから ON にする（コードからは変えない）。NIHO の Admin トークンを送るフラグ（`ADMIN_SUPPORT_READ_API_ENABLED`・`ADMIN_SUPPORT_CASE_API_ENABLED`・`ADMIN_OPERATIONS_API_ENABLED`・`EXPERIENCE_ASSISTED_LAUNCH_API_ENABLED`・`EXPERIENCE_FEE_SUMMARY_API_ENABLED`。どれも表に無い）と同時には起動しない。この方式では `NIHO_FIREBASE_WEB_API_KEY` は Admin に使わない（ホストの画面の基礎設定として残る）。終わったセッションはメール job が消す。
- 日本語サイト（#59）の `JAPANESE_SITE_ENABLED` は、公式配備の表に載せただけで、既定は OFF（`STG_` / `PROD_` とも未設定）。ON にするのは、日本語の文言（このリポの `ja-static-copy.ts`。`EXPERIENCE_PUBLICATIONS_ENABLED` の環境では NIHO の release は使わない）をオーナーが確認し、実機確認が済んでから、専用の変更で行う（[localization-consumer.md](localization-consumer.md)「有効化の前に確かめること」）。
- OTA の枠管理（#194、[ota-runtime.md](ota-runtime.md)、[ota-google-channel-flow.md](ota-google-channel-flow.md)）の 9 つは、すべて既定 OFF。**今はどの variable も作らない**（`STG_` / `PROD_` とも未設定のまま）。
  - `CHANNEL_WATCHDOG_ENABLED` は、これまで表に無く stg・本番の workflow に直接書かれていたが、表へ移った。variable 名は同じなので、既存の `STG_CHANNEL_WATCHDOG_ENABLED` / `PROD_CHANNEL_WATCHDOG_ENABLED` はそのまま使える（Cloud Run に付く 3 つの環境変数の名前と値も以前と同じ）。
  - `CHANNEL_SUPPORTED_ADAPTERS` は短い書式だけを受け付ける：`site/adapter@version=能力(+能力)` を `;` でつなぐ（例 `GetYourGuide/gyg-browser@1=observe+close+open`）。能力は `observe`・`readReservations`・`close`・`open`・`create`。`--set-env-vars` の区切りになるので、値にカンマ・空白を持てない（JSON の書式は配備では使えない）。
  - runtime は manager（掲載先の設定）・watchdog・adapters を要る。新しい OPEN の保留（heartbeat の途絶後の `open_hold_since`）を watchdog がするため、watchdog 無しでは開かない。manager は Admin を要るので、runtime には `ADMIN_SUPPORT_CONSOLE_ENABLED` も要る。
  - Google の watch の webhook（`EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL`）は workflow がサイトの URL から入れる。variable は無い。
  - **有効化の順序**（どれも variable を変えて配備するだけ。止めるときは variable を消して新しい候補を作る）：
    1. `CHANNEL_WATCHDOG_ENABLED`（配備・昇格のあとで Cloud Scheduler `experience-ota-watchdog` を再開する。[ota-runtime.md](ota-runtime.md)「クラウド watchdog」）
    2. `CHANNEL_MANAGER_ENABLED`
    3. `CHANNEL_SUPPORTED_ADAPTERS` と `CHANNEL_RUNTIME_ENABLED`（最初は読取りと開閉だけ。`create` は付けない）
    4. `RESOURCE_GOOGLE_ENABLED`（watch は `RESOURCE_GOOGLE_WATCH_ENABLED` で別に開く）
    5. Airbnb×Google を `AIRBNB_GOOGLE_SETUP_ENABLED` → `AIRBNB_GOOGLE_ACTIVATION_ENABLED` → `AIRBNB_GOOGLE_DELIVERY_ENABLED` → `AIRBNB_GOOGLE_OBSERVATION_ENABLED`
  - 本番は stg の受入のあとで、同じ順に開く。
- 「ホストの画面・DB」は本番では `enable_host_calendar=true`（と `PROD_HOST_CALENDAR_READY=true`）。サイトの URL は `https://experience.niho.life`、`<project>` は `niho-app-prd`。
- `PROVIDER_PAGES_API_ENABLED` はlegacy NIHO provider-pages consumerのflagで、Experience商品・原稿・写真・公開には使用しない。新しい販売フローではOFFを維持する。
- `PROVIDER_OPERATIONS_API_ENABLED` は旧NIHO予約の一覧・詳細・承認/辞退/取消／返金・メッセージなど、NIHOが引き続き所有する予約運営業務の限定APIだけを扱う。NIHO本番に `APP_CONNECT_WEB_ORIGINS` と許可されたservice identityを設定し、契約と旧予約権限をstgで受け入れてから開く。Experienceの商品・原稿・写真・公開は `EXPERIENCE_HOST_PUBLICATION_API_ENABLED` が使うExperience BFFだけで行う。NIHOのtokenはExperience serverだけで扱う。旧 `niho.life/experiences/provider` 転送はNIHO Web側の別配備。
- 新しいExperience商品を開くには、NIHOapp #19712のHost v1 APIとservice identity allowlistを先にstagingへ配備し、同一source hash、current identity、Connect一致・readiness・再利用同意を合成アカウントで受け入れる。Experience DB migration `0047` とruntime grants、GCS media bucket／IAM、承認済み掲載同意文、`SITE_URL`、NIHO audienceを設定する。その後 `PROD_PUBLICATIONS_ENABLED=true` と `PROD_HOST_PUBLICATION_API_ENABLED=true` を別々に段階設定する。NIHO Host v1が未配備の間はどちらもOFF。`EXPERIENCE_GUEST_BOOKING_ENABLED` と `BOOKINGS_ENABLED` は予約・Stripe受入の別ゲート。
- `GUEST_QUESTIONS_ENABLED` はExperience DB所有の「Ask the host」と質問返信を表示する場合だけ使う。NIHO提供者APIのメッセージ画面と併用できないため、`PROVIDER_OPERATIONS_API_ENABLED` と同時には有効化せず、配備前検査で拒否する。提供者APIを使う受入では、NIHO API上のメッセージ一覧・返信を受け入れる。
- 設定の形：同意の版は英数字と `._:+-` の 1〜100 字。From・Reply-To はアドレスか `表示名 <アドレス>`（カンマ・`"`・`<>` なし）。URL は小文字の host の https。VAPID の公開鍵は base64url の P-256、subject は `mailto:` か https。`--set-env-vars` の区切りになるカンマは、どの値にも入れられない。
- 各 Secret は Secret Manager に作り、実行 ID `experience-runtime` にその Secret だけの `secretAccessor` を付けてから参照を入れる。値と接続情報は GitHub の variable・PR に書かない。
- job（メール・push・Google）を開くフラグは、呼び手の Cloud Scheduler と、上の名前のサービスアカウント（project の role なし、このサービスの `run.invoker` だけ）を先に作る。workflow はそれらを作らない。
- 順番：設定と Secret の参照を先に入れ、最後にフラグの variable を `true` にする。`candidate` → 候補 URL で確認 → 同じ variable のまま `promote`。止めるときはフラグを `false` に戻して新しい候補を作るか、前の revision に traffic を戻す。

**フラグを足すとき**（paneB-1・paneB-2 など）：`scripts/deploy/runtime-flags.mjs` の `FLAGS` に 1 項目（Cloud Run の名前、variable、前提、設定・Secret、workflow が入れる値）、`deploy-runtime-flags.test.ts` の `CONFIG_KEY` に 1 行、この表と [stg の表](host-calendar-staging.md#機能のフラグ84) に 1 行。workflow は変えなくてよい。

`EXPERIENCE_PUBLIC_API_VERSION` は初期値 `1.0` を固定する。`1.1` はNIHO側のAPI契約PR #31 と連携B、集合概要を返すniho-app PR #19267が取り込まれた後、stgとprodのv1.1エンドポイントを `verify:live -- --api-version 1.1 --expect-private-meeting-slug <公開概要を持つAFTER_BOOKING合成slug>` で確認し、提供者bio・写真alt・`meetingOverview` と、非公開集合情報が応答に無いことを合成データで確かめてから、専用の変更PRでだけ有効化する。`1.2` はNIHO側の公開カタログ・checkout契約（niho-app #19160/#19161）が取り込まれた後、stgとprodでテーマ・開催日フィルターを `verify:live -- --api-version 1.2 --region kamakura --theme FOOD --available-on <開催予定日> --expect-slug <当日開催の合成slug> --expect-theme-excluded-slug <別テーマで当日開催のslug> --expect-date-excluded-slug <同テーマで別日開催のslug> --expect-private-meeting-slug <公開概要を持つAFTER_BOOKING合成slug>` で確認し、UTM・DNT・checkoutエラーを合成E2Eで検証してから、専用の変更PRでだけ有効化する。API未配備の環境では `1.0` のままにする。

`verify:live` は認証なしの公開GETだけを呼び、Checkoutを作成しない。v1.1/v1.2は指定した合成商品が基本一覧にあり、空でない概要・`AFTER_BOOKING`・`meetingPoint: null` を確認できなければ失敗する。空一覧や概要が全件nullの結果では有効化できない。v1.2を切り替える前に、さらにstg限定の安全な予約検証を行う。

1. NIHO stgに検証専用の合成体験・開催枠（本番・一般公開には出さない）と、Stripe test modeのテスト用PaymentEntityを準備する。本番口座・実旅行者の情報を使わない。
2. DNTを無効にしたブラウザで、4つの許可済みUTM値がある体験URLから予約を送る。予約リクエストにUTM4項目だけが含まれ、NIHO stgの合成予約行で同じ値を確認する。URL・Checkout応答・Umami送信・ログにUTMや予約情報が混ざらないことも確認する。
3. DNTを有効にして別の合成予約を送り、リクエストと予約行のどちらにもUTMがないこと、通常どおり予約導線が進むことを確認する。
4. Stripe test mode上の予約をstg運用手順で取り消し、必要な返金まで確認する。確認結果はSHA・合成slug・操作結果だけを非公開の受入記録に残し、予約token・Checkout URL・ゲスト情報は記録しない。

このstg確認が完了するまで、公開API版を `1.2` に切り替えない。テスト予約ができない環境では、v1.2の公開GET確認だけを根拠に切り替えず、NIHO側の安全な予約検証経路を整えてから再開する。

## `experience.niho.life` の入口（本番revisionを昇格後）

| 層 | 作るものと値 | 確認 |
| --- | --- | --- |
| GCP | 既存 `nihoapp-prd-cf-https-fr` と `nihoapp-prd-cf-urlmap` を使う。新しい `asia-northeast1` serverless NEGとHTTPS backend serviceを作り、`experience.niho.life` 専用host rule/path matcherを追加する。forwarding rule・static IPv4・ALBは増やさない | `Host: experience.niho.life` でトップと静的assetが200。既存hostの経路に変化がない |
| TLS | Certificate ManagerのDNS authorizationで `experience.niho.life` の証明書を発行し、既存 `nihoapp-prd-cf-cert-map` に専用hostname entryを追加する。DNS authorizationのCNAMEだけCloudflare DNSへ追加する | 証明書がactive、TLS hostnameが一致、HTTPが既存redirect経由でHTTPSへ転送 |
| Cloudflare | `experience` のA recordを既存Cloudflare向けALB IPv4へ向け、proxyを有効にする。SSL/TLSはFull (strict)。既存 `niho.life` / `app` / `api` のDNSは触らない | DNS、TLS、`cf-ray`、ALB access logを突合 |
| cache | この hostname の既定は bypass。後順位の例外 rule として `/_next/static/*` のみ cache eligible。`/experiences/*/book`、`/booking/*`、`/preview/*`、API、HTML は常に bypass。`/_next/image` は初回は bypass | 予約関連の `Cache-Control: private, no-store`、`CF-Cache-Status` が `HIT` でないことを確認 |
| origin protection | 販売前に Cloud Run ingress を `internal-and-cloud-load-balancing` にし、`run.app` の直アクセスが拒否されることを確認。候補revisionの検証を ALB 経由に切り替えたworkflowを同時に入れる | `run.app` でアクセス不可、ALB経由は正常 |

ALB/DNSは、この文書の設定とGoogle Cloudの[Cloud Run custom domain手順](https://cloud.google.com/run/docs/mapping-custom-domains)、[revisionの段階切替](https://cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration)、Cloudflareの[cache rule順序](https://developers.cloudflare.com/cache/how-to/cache-rules/order/)を照合して適用する。既存URL mapへhost ruleを追加する前に全host/path ruleを保存し、`experience.niho.life` だけに新経路を加える。DNS cutover前にレコードの値とIDを保存し、切戻しはexperience用host ruleとDNS recordだけを戻す。共有ALBのforwarding ruleや既存host ruleは削除しない。

## NIHO の実APIとの整合

連携Aの [#19137](https://github.com/niho-coliving/niho-app/pull/19137) を merge・stg配備し、契約 [#26](https://github.com/niho-life/niho-experience/pull/26) を取り込んでから、`npm -C packages/api-client run verify:live -- --origin https://app-stg.niho.life` を実行する。検証環境に公開した合成商品と開催枠がない場合、空一覧は契約不一致ではなくfixture不足として記録する。

NIHOapp側の変更は連携Aの担当へ集約する。stg Web の `EXPERIENCE_SITE_ALLOWED_ORIGINS` は検証用サイトの exact origin、本番 Web は `https://experience.niho.life` の exact origin に限定する。GET availability と POST checkout の path/method だけ CORS を許し、ワイルドカードや資格情報付きCORSを使わない。`EXPERIENCE_SITE_PUBLIC_ORIGIN` は、承認済み原稿が本番ホストで表示されるまで**未設定**とする。この変数を入れると NIHO側の canonical・sitemap・中断時の戻り先が新サイトへ切り替わるため、両側を同時にreadbackする。env の反映は [NIHO連携runbook](https://github.com/niho-coliving/niho-app/blob/main/ops/runbooks/experience-site/experience-site-integration.md) と Cloud Run manifest の経路を使う。

Admin代理公開は、NIHO本番の `APP_CONNECT_EXPERIENCE_ADMIN_ORIGIN=https://experience.niho.life` を正規配備経路で反映し、現在のNIHO Admin session検証とExperience migration `0058`・`0061`、runtime grantsを受け入れてから `ADMIN_SUPPORT_CONSOLE_ENABLED`、`PUBLICATIONS_ENABLED`、`HOST_PUBLICATION_API_ENABLED` を有効化する。販売者の現在OWNER/Connect readiness、口頭または書面での確認、掲載同意version、写真権利を本番候補で確認する。Adminは販売者のHost sessionを更新できないため、公開直前に販売者がHost画面を開いて作成した5分以内のreadiness snapshotが必要。合成受入とmigration/readbackが済む前にAdminまたは公開APIのflagを開かない。

## 個別ゲートと切戻し

| ゲート | 開く前の証跡 |
| --- | --- |
| 表示 | 本番候補で mock/pilot fixture が出ず、`/preview/states` と `/preview/checkout` が404。公開APIは掲載済みだけ。モバイル・デスクトップと主要エラー表示、商品原稿・写真許諾を確認 |
| 予約・販売 | 合成提供者と Stripe test の掲載→予約→決済→確定→予約一覧→売上→返金、販売者/口座/条件、停止・期限切れ・再送を確認。P-01/02の実条件、サポート窓口、販売開始判断者が確定してから `BOOKINGS_ENABLED=true` と NIHO側受付を開く |
| 検索 | canonical・sitemap・robots、公開原稿と写真、計測の公表が揃ってから `SITE_INDEXING=allow`。販売開始とは別に判断。**オーナー決定（2026-11-07）で開いた**。本番は Umami・GA4 とも未設定で、公表が要る計測は無い（入れる時は下の「計測」の順で公表を先に行う）。体験詳細の canonical は NIHO 側の `EXPERIENCE_SITE_PUBLIC_ORIGIN` の切替までは NIHO の企画ページを指す |
| Guide CMS公開元 | [database flagゲート](guide-cms.md#database-flagを開く前のゲート)をstagingで満たし、migration、private bucket、現行ホストログインのactive OWNER、移行件数を照合してから `DATABASE_GUIDE_PUBLICATIONS_ENABLED=true`。これは `EXPERIENCE_GUIDE_PUBLIC_SOURCE=database` と専用 `GUIDE_MEDIA_BUCKET` を一緒に設定する。`EDITOR_PUBLICATIONS_ENABLED`とは相互排他で、未設定・不正・競合は認証前の配備検査で止める。実DB/非公開画像で再訪・公開更新・停止・権限失効・写真取消、UNLISTEDの直URL/noindexと一覧/sitemap除外、DB/画像障害、Cloudflare bypassを確認する。書込み開始後の切戻しは`static`ではなく、同じDB revisionを読める既知revisionへのtraffic rollbackとする。旧editor公開元の撤去は#480 |
| 外部提供者 | 連携B #19123 の登録・権限・口座・売上の受入後にだけ `HOST_SIGNUP_MODE=open` |
| ホストの画面 | NIHO 側の接続（niho-app #19282、#19283）の本番配備と [#92](https://github.com/niho-life/niho-experience/issues/92) の受入の後にだけ `enable_host_calendar=true` の候補を昇格する |
| 計測 | NIHOのプライバシーポリシーに Umami Cloud の送信内容・目的・保存期間を追記し、同意方針の確認後だけ `UMAMI_WEBSITE_ID` を設定。previewには設定しない |

**検索公開の例外配備（2026-11-07、オーナー承認）**：この時点の `main` は #410（公開カタログ・詳細の読み元を Experience publication へ切替、旧NIHO商品へ fallback しない）を含み、本番は `PROD_PUBLICATIONS_ENABLED` が未設定のため、workflow で配備すると一覧が空になる。そのため、稼働中の revision `niho-experience-00023-res`（commit `fa26a76e291f`、実行用 digest `sha256:8e8d503a8e0dffbab0b52ec44648769b99bf909e35e754827c3e2afa11b0d5b1`）と同じイメージ・同じ設定で、`SITE_INDEXING=allow` だけを変えた revision `niho-experience-00025-lav`（tag `search-fa26a76e`、label `change=search-indexing`）を `gcloud run services update --no-traffic` で作り、robots.txt・sitemap・各ページの `robots`・2件目の詳細の404を候補URLで確かめてから100%へ昇格した。切り戻しは `00023-res` へ traffic を戻す。次の workflow 配備（#410 の受入後に `PUBLICATIONS_ENABLED` を開く時）は、workflow の `SITE_INDEXING=allow` を引き継ぐ。

緊急停止はまず NIHO の掲載/受付を止め、サイト側も `BOOKINGS_ENABLED=false` の安全revisionへ戻す。サイトのtrafficを直前revisionへ戻しても、成立済み予約・返金は NIHO の予約一覧と台帳で追う。Cloud Run trafficの変更後に revision、100% の配分、トップ/詳細/予約停止、NIHO側の予約一覧・返金導線をreadbackする。停止・切戻し・再開の日時とSHAを #15 に残す。


## Editorの記事連携を開く設定（2026-11-03）

新しい設定も`runtime-flags.mjs`の同じ検査・固定版参照・revision readbackを使う。GitHub variableはstagingで`STG_`、productionで`PROD_`を付け、未設定はOFF。実値・token・未公開原稿をIssue/PRへ書かない。

| variable（prefixを省略） | 開くもの | 必要な設定 |
| --- | --- | --- |
| `ARTICLE_AUTHORITY_API_ENABLED` | 現在OWNER・体験候補・関連権限API | DB、`ARTICLE_AUTHORITY_SERVICE_ACCOUNT_EMAILS`、`NIHO_ARTICLE_AUTHORITY_ORIGIN` / `AUDIENCE`、`EDITOR_ARTICLE_AUTHORITY_ORIGIN` / `AUDIENCE` |
| `GUIDE_ADMIN_API_ENABLED` | NIHO Admin BFFからの限定writer/category管理API | ホストの画面・DB、`GUIDE_ADMIN_AUDIENCE`（Cloud Run service URL）、`GUIDE_ADMIN_SERVICE_ACCOUNT_EMAIL`（NIHO API runtime SA 1つ） |
| `HOST_ARTICLE_LINKS_ENABLED` | ホスト設定のNIHO正本への招待・取消 | ホスト画面、`NIHO_ARTICLE_AUTHORITY_ORIGIN`、`NIHO_ARTICLE_LINKS_AUDIENCE` |
| `EDITOR_PUBLICATIONS_ENABLED` | 公開元を`editor`へ切替 | DB、authority API、`GUIDE_EDITOR_API_BASE_URL`、`GUIDE_EDITOR_API_TOKEN_REF`の固定数値版、`GUIDE_EDITOR_ASSET_ORIGIN` |
| `DATABASE_GUIDE_PUBLICATIONS_ENABLED` | 公開元をExperience DBへ切替 | DB、専用private bucket名の`GUIDE_MEDIA_BUCKET`。`EDITOR_PUBLICATIONS_ENABLED`と同時ON不可 |
| `GUIDE_APP_CARDS_ENABLED` | NIHOライブラリ向けの公開summary | `EDITOR_PUBLICATIONS_ENABLED=true`。著者が`extras.app`を選んだlive公開版だけ。[記事カード契約](guide-app-cards.md) |

書き手の入口の `GUIDE_EDITOR_SITE_ORIGIN=https://editor.niho.life` はどのflagにも属さない固定値で、表には載せない。stagingとproductionのworkflowが全revisionに設定し、読戻しで値を照合する（flagがすべてOFFの本番revisionでも、表の名前として余分扱いにならない）。

許可サービスアカウントはセミコロン区切りで複数を指定する。gcloudのカンマ区切りと衝突せず、単一のenv値として渡し、runtimeでも同じリストを解釈する。サービス専用APIのaudienceは配備先の固定site URL。ホスト用`NIHO_ARTICLE_LINKS_AUDIENCE`はNIHOの既存writer resolver用audienceと一致させ、サービス専用の`NIHO_ARTICLE_AUTHORITY_AUDIENCE`と混同しない。

NIHO追加API → Editor / Experience追加API → 相互認証と合成の負例確認 → ホスト入口 → 公開元切替の順で開く。カテゴリ/writer管理には、NIHO Admin BFFが配備済みでExperienceの限定Guide Admin APIを呼べる状態を先に確認し、`GUIDE_ADMIN_API_ENABLED` はNIHOの正規runtime service accountだけを許可してから開く。writer解除・取消・OWNER変更・体験停止の次読取、既存カテゴリ停止後の記事維持、公開停止後の写真404、依存障害での関連表示非表示を確認する。owner指示により画面受入・実機操作は省略できる。Secret値の用意は各repoのowner専用手順に従い、AIが値を取得・表示しない。

公開元flagをOFFにすると空のstatic経路になるため、`/write`で実書込みを始めた環境の切戻しには使わない。既存runbookで、同じDB schemaとpublicationを読める固定revisionへtrafficを戻す。公開記事・旧下書き・招待履歴を消さない。新しい定期job・Schedulerは追加しない。

### 予約受付前の edge と候補の経路（#471）

正規 origin は本番 `https://experience.niho.life`、staging `https://experience-stg.niho.life`。Cloudflare proxy → niho.life 専用の Authenticated Origin Pull 証明書を検証する既存 ALB → 同一環境の serverless NEG → Cloud Run の順に通す。staging の backend service と NEG は `niho-app-stg` に置き、既存の `niho-app-prd` frontend から参照する。アプリ・DB・Stripe の環境は混ぜない。

Cloud Run ingress は両環境とも `internal-and-cloud-load-balancing`。`run.app` に CF ヘッダーを偽装しても公開経路にはならない。ALB IP の直アクセスもクライアント証明書なしでは拒否する。証明書検証を省略した疎通確認は受入に数えない。

候補専用 origin は `experience-candidate.niho.life` と `experience-stg-candidate.niho.life`。各 NEG が固定 `candidate` タグを参照する。Cloudflare の専用ルールで GET/HEAD 以外を拒否し、候補から予約・返金・設定変更は実行できない。workflow は候補作成後に alias を設定し、固定の run タグと alias が両方とも対象 revision を指すことを workflow 内の readback で照合する。alias が別候補へ移っていたら promote は止まる。環境ごとの concurrency は継続し、既存の安定 traffic は候補作成で動かさない。

`STG_HOST_SERVICE_URL`、staging の Google OAuth redirect、Stripe TEST webhook、Scheduler URI/OIDC audience を正規 origin にそろえる。旧 run.app の OAuth redirect は移行確認後に削除する。Guide Admin の Cloud Run audience のように Google のサービス認証が明示的に run.app を使う設定は別であり、機械的に書き換えない。

受入は、通常の Chrome から staging 予約入力→Stripe TEST決済→確定→取消／返金を行い、偽装ヘッダー付きも含む直 origin 拒否、候補 POST 拒否、正規経路でのログイン／メール／webhook／ジョブを確認する。
### 予約受付の開始・停止

`PROD_BOOKINGS_ENABLED` は未設定または `false` で停止、`true` で受付。`PROD_GUEST_BOOKING_ENABLED=true` とホスト機能が必須で、機能別の依存設定も通常どおり検証する。公開商品の価格・日程・販売者・受取口座・集合案内、staging の決済／取消／返金、専用 LIVE webhook とメール、origin 制限を受け入れた後に設定する。

切替は公式 workflow の candidate → readback → promote で行う。候補作成時と promote 時に switch を同じ値で照合するため、変数を書き換えただけでは既存 revision の受付は変わらず、異なる値で作った候補の promote も止まる。緊急停止も `false` にして停止用候補を配備する。候補の専用 edge は読み取りのみとし、開始前の受付経路にはしない。

2026-11-08のDinner公開では、保存済みの販売条件での公開と既存NIHO・GetYourGuideとの併売をオーナーが個別に承認した。併売はこの商品だけの例外で、既存枠の停止・同期を受付開始の前提にしない。商品条件と許諾の確認は[登録引き渡し表](content/registration-handoff.md)に記録する。

受付開始の配備は [candidate run 42387874462](https://github.com/niho-life/niho-experience/actions/runs/42387874462) → [promote run 42388212552](https://github.com/niho-life/niho-experience/actions/runs/42388212552)。SHA `306613ac0228a33dab1da93eadba911f39c65a21`、revision `niho-experience-00038-but`、実行用digest `sha256:191a4c8b99d5ed3cee19cdf5b93ab1909d936fe5b22f289b931e4549b69da0ae`。100% traffic、`BOOKINGS_ENABLED=true`、`EXPERIENCE_GUEST_BOOKING_ENABLED=true`、正規SITE_URL、制限済みingressを読戻した。通常Chromeの本番予約フォームで初回11月14日18時・定員8の選択と、大人1名＋子ども1名の合計42,000円を確認した。本番での実決済は行わず、決済〜取消・返金・精算の通し確認はStripeサンドボックスで完了している。

ADR 0002・0003への移行後は、成立済み予約・返金・精算をExperienceの `/host/bookings`・`/host/sales` と専用DBで追う。この運用を、上に残る旧NIHO正本の切戻し説明より優先する。個別商品の緊急停止はOWNER画面の「販売を停止」で新しい販売を止める。既存予約を自動で取り消したり、公開snapshot・口座・Stripe webhook・メール設定を削除したりしない。

全サイトの受付を止める場合は `PROD_BOOKINGS_ENABLED=false` の公式候補を確認して昇格する。配備を待てない障害時は、停止設定を受け入れ済みの直前revision `niho-experience-00035-faj`（SHA `91f26401ac5583c4d16bc5689727a5b2b6cfbd85`）へtrafficを戻す。これは同じDB・Webhook・返金と通知の処理を維持し、ゲストの新規受付だけを止められる版である。停止後は100% traffic、受付OFF、公開商品の表示、成立済み予約と返金導線を読戻し、時刻・SHA・操作を #15 に記録する。再開も受付ONの候補を公式手順で再確認する。
