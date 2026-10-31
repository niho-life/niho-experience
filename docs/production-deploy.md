# 本番候補の配備と公開ゲート

対象: [#5](https://github.com/niho-life/niho-experience/issues/5)、[#15](https://github.com/niho-life/niho-experience/issues/15)、[#92](https://github.com/niho-life/niho-experience/issues/92)、[#84](https://github.com/niho-life/niho-experience/issues/84)（機能のフラグ）。2026-11-01 更新。**販売開始、検索公開、外部提供者登録、ホストのカレンダーは別々に受入する。**

## 固定する構成

| 項目 | 設定 |
| --- | --- |
| GCP | 初期pilotは既存 `niho-app-prd` を共用し、Cloud Runサービス・実行ID・配備権限を分離。`asia-northeast1` |
| Cloud Run | `niho-experience`、`experience-runtime`（権限なし）、1 vCPU / 512 MiB、候補段階は min 0 / max 2 |
| イメージ | 本リポのレビュー済み `main` の40文字SHA。資格情報なしで build と smoke を行い、SHA256確認済みのイメージだけを配備jobへ渡す |
| 配備権限 | `experience-deployer` に `niho-experience` サービス単位の `roles/run.admin`、専用Artifact Registryのwriter、runtime SAだけのService Account Userを付与。専用 Workload Identity Pool は GitHub repository ID `1425500695`、`refs/heads/main`、`production` environment、手動起動、`deploy-production.yml` の同時一致を要求 |
| GitHub | `production` environment に `main` のみの branch rule と required reviewer を設定。repository variable `PRODUCTION_DEPLOY_ENABLED=true` は設定が揃うまで付けない |
| 初期revision | `EXPERIENCE_API_MODE=http`、`EXPERIENCE_PUBLIC_API_VERSION=1.0`、`EXPERIENCE_GUIDE_PUBLIC_SOURCE=static`、`SITE_URL=https://experience.niho.life`、`NEXT_PUBLIC_NIHO_WEB_ORIGIN=https://niho.life`、`SITE_INDEXING=block`、`BOOKINGS_ENABLED=false`、`HOST_SIGNUP_MODE=pilot`、`NIHO_HOST_START_URL=https://niho.life/experiences/provider`、`HOST_CONSOLE_ENABLED=false`。`MOCK_CATALOG` と `UMAMI_WEBSITE_ID` は渡さない |

初期pilotでは既存の `niho-app-prd` にCloud Runサービスと限定した配備IDを足し、既存のglobal external Application Load BalancerとCloudflare proxyを再利用する。新規プロジェクト作成と新しいロードバランサーは不要。GCP project Owner、請求、API有効化、クォータの管理境界は共有する一方、GitHub deployerのCloud Run Adminは `niho-experience` サービスだけに付け、既存アプリのサービス・runtime identity・DB/Secretsへ権限を与えない（[Cloud Runのリソース単位IAM](https://docs.cloud.google.com/run/docs/securing/managing-access)）。売上や取り扱いデータが増える、組織ポリシー・障害範囲・請求分離が必要になる段階では専用GCP projectへ移行する。Googleは Cloud Run domain mapping をproductionに推奨していないため、DNS onlyのdomain mappingは採らない。Cloud Runは候補段階で公開 `run.app` のrevision URLを使い、販売前にはALB経由だけを受けるingressと候補revisionの検証経路を整える。プレビュー用deployerに本番権限は付けない。

## 初回準備（本番設定の確認後）

1. `@niho.life` の `niho-app-prd` Ownerで `ORG_ID=299180592876 PROJECT_ID=niho-app-prd ALLOW_SHARED_NIHO_APP_PROJECT=true bash scripts/gcp/setup-production.sh` を実行する。既存請求先は確認するだけで変更しない。スクリプトは専用Artifact Registry、runtime/deployer SA、GitHub OIDC pool/providerを作り、認証必須のprivate bootstrap serviceを用意する。公開host ruleは候補revisionの昇格まで追加しない。deployerの `roles/run.admin` はこのCloud Run serviceにだけ付与する。出力されたGitHub variablesを記録する。
2. GitHubの `production` environment が **required reviewer と mainのみのbranch rule** を持つことを確認する。スクリプトが出した `PROD_GCP_*` 6変数をrepository variablesに登録する。preview用 `GCP_*` と混ぜない。最後に `PRODUCTION_DEPLOY_ENABLED=true` を登録する。
3. `.github/workflows/deploy-production.yml` を `main` から `action=candidate` で手動起動し、入力 `commit_sha` を起動時の `main` SHA と完全一致させる。ホストカレンダーの受入前は `enable_host_calendar=false` を選ぶ。workflow は資格情報なしで build/smoke → 保護環境で image push → digest固定の `--no-traffic --tag candidate-<sha12>` → NIHO本番公開APIの一覧・revision専用URL・runtime env・robots・preview 404 を確認する。APIが未配備で404なら候補を受け入れない。実行結果に出るSHA・revision・**Cloud Run実行用image digest**・候補URLを確認する。DockerがOCI indexをpushした場合、Cloud Runの実行用digestはその `linux/amd64` 子manifestとなる。workflowは親子関係を検証し、両方のdigestを記録する。
4. 候補URLを確認して受け入れた後、別の手動実行で `action=promote` を選び、候補実行の同じ `commit_sha`、`candidate_revision`、**実行用digest** を `candidate_image_digest` に、同じ `enable_host_calendar` を入力する。保護環境で既存revisionのcommit label・不変image digest・停止設定・候補URLを再検証し、そのrevision自体を昇格する。promotionではbuild・image push・再配備を行わない。候補SHA・revision・digest・配備run・環境変数・HTTP結果を #15 に記録する。予約停止と検索除外は維持する。

`--set-env-vars` に渡す初期8項目、`HOST_CONSOLE_ENABLED`、下の「[機能のフラグ](#機能のフラグ84)」が本サービスの runtime 設定全量である。`enable_host_calendar=false` はカレンダー用 Secret と Cloud SQL 接続を除去し、`/host/calendar` の404を確認する。`true` は次の受入条件を満たした場合だけ選ぶ。固定の管理入口は候補作成・昇格前とプレビューでrevision設定とHTMLから確認する。管理リンクの認証・登録・口座状態はNIHOが判定し、セルフ登録の公開設定とは区別する。運用で値を足す際は workflow（機能のフラグなら `scripts/deploy/runtime-flags.mjs` の表）を同時に更新し、Cloud Run画面での一時変更を正本としない。`UMAMI_WEBSITE_ID` はポリシーの追記後、別PRで本番だけに追加する。

### ホストカレンダーの本番候補を有効にする条件（#92）

1. NIHO app-connect Web・ホストAPI（niho-app #19282、#19283）を先にマージしてstgへ配備し、`APP_CONNECT_WEB_ORIGINS` に対象サイトのexact originを登録する。NIHOアカウントでのログイン、提供者権限、再認証、ログアウトをstgで確認する。本番NIHOへの反映はその後に行う。
2. 体験専用PostgreSQL DB `experience_prd` を `gcloud sql databases create` で作り、`CONFIRM_EXPERIENCE_DB_MIGRATE=niho-app-prd` を付けて `niho-app` の `niho-db.sh prd --via-bastion -- node scripts/gcp/apply-experience-db-migrations.mjs` を実行する。空のDBではscriptが先にruntime接続URLをSecret `experience-prd-database-url` の新versionへ保管し、NOLOGINの `experience_prd_migrator` と限定LOGINの `experience_prd_runtime` を作って、`packages/experience-store/migrations/` の全SQLファイルを辞書順（両方の `0010` を含む。`0006` は停止・旧revision drain・snapshot後に適用。詳細は [体験業務の移行手順](experience-runtime.md)）に移行専用IDで適用し、runtimeの権限を宣言どおりに付ける（手順の詳細は [stg手順](host-calendar-staging.md#以降のmigrationとruntime権限)）。出力された `RUNTIME_DATABASE_URL_REF` が `PROD_EXPERIENCE_DATABASE_URL_REF` の値になる。Cloud Run実行IDには `roles/cloudsql.client` を[対象instanceに限るIAM条件](https://docs.cloud.google.com/sql/docs/postgres/iam-conditions)付きで付け、DBユーザーにも体験専用DBの権限だけを与える。既存のprivate IPのみ・connector必須のinstanceへ接続するため、候補はCloud SQL接続と `default` VPC/subnetへのDirect VPC egress（private rangesのみ）を併用し、双方を検査する。`0009`/`0010` の private bucket、uniform access、public access prevention、runtime IAM と `GUIDE_MEDIA_BUCKET` は [Guide CMS](guide-cms.md) に従い、editor flag とGuide public sourceは受入までOFF/staticを維持する。`provider_memberships` は権限を確認した非公開の移行処理で投入し、公開リポ・CI・ログに実IDを記録しない。
3. Google OAuth Web clientに `https://experience.niho.life/host/calendar/google/callback` を許可し、必要なCalendar scopeと同意画面の状態を確認する。下表の6設定はSecret Managerに保存し、Cloud Run実行IDへ対象SecretのAccessorだけを付与する。値と接続URLはGitHub変数やPRに書かない。`EXPERIENCE_DATABASE_URL` はその専用DBを指し、Cloud SQL接続に対応させる。
4. stgで本人のGoogle接続・読み取り元予定のbusy表示・繰り返し枠の競合・切断/失効・他提供者からのアクセス拒否を確認する。**現行NIHO予約枠にはGoogle busyはまだ反映されない**ので、既存販売枠はNIHO側で閉じる。候補の無認証HTTP検査は画面の存在と設定を確認するだけで、この本人操作の代わりにはならない。
5. stg受入証跡を #92 に記録してから、GitHub repository variablesに下表のSecret参照と `PROD_EXPERIENCE_CLOUDSQL_INSTANCE`（`project:region:instance`）を設定し、最後に `PROD_HOST_CALENDAR_READY=true` を入れる。候補と昇格の双方で `enable_host_calendar=true` を選ぶ。workflowはSecret参照の数値version固定、Cloud SQL instanceのproject一致、6設定の参照、`/host` のログイン導線、`/host/calendar` の存在を検査する。候補のOAuth redirectは `SITE_URL` の本番hostを指すため、tagged revisionのURLで実際のGoogle接続を完了できない。昇格直後に本番hostで本人がログイン・Google接続・busy反映を確認し、失敗したら直前revisionへ戻す。

| GitHub repository variable（Secretの名前とversionだけ） | Cloud Run環境変数 |
| --- | --- |
| `PROD_HOST_SESSION_SECRET_REF` | `HOST_SESSION_SECRET` |
| `PROD_NIHO_FIREBASE_WEB_API_KEY_REF` | `NIHO_FIREBASE_WEB_API_KEY` |
| `PROD_EXPERIENCE_DATABASE_URL_REF` | `EXPERIENCE_DATABASE_URL` |
| `PROD_EXPERIENCE_GOOGLE_CLIENT_ID_REF` | `EXPERIENCE_GOOGLE_CLIENT_ID` |
| `PROD_EXPERIENCE_GOOGLE_CLIENT_SECRET_REF` | `EXPERIENCE_GOOGLE_CLIENT_SECRET` |
| `PROD_EXPERIENCE_GOOGLE_TOKEN_KEY_REF` | `EXPERIENCE_GOOGLE_TOKEN_KEY` |

Cloud Run側はSecretの数値versionを固定する。鍵を更新するときはSecretに新versionを作り、参照変数を更新して新しい候補revisionを作る。`PROD_HOST_CALENDAR_READY` をfalseに戻しても既存revisionの公開状態は変わらない。緊急停止は前の `enable_host_calendar=false` revisionへtrafficを戻し、NIHO側の旧枠も別途止める。

### 機能のフラグ（#84）

mock で出している機能を http mode で開くフラグを、repository variable `PROD_*` で候補 revision に渡す。どれも**未設定か `false` なら OFF**（そのフラグの環境変数・設定・Secret の参照を revision に載せない）で、今の候補は変わらない。

- **表は 1 つ**：`scripts/deploy/runtime-flags.mjs` の `FLAGS`。stg（`STG_*`）と本番（`PROD_*`）の workflow が同じ表を使う。
- **配備の前に検査**：候補・昇格の両方で、資格情報を得る前にこの script が variable を読み、次を確かめる。足りなければ variable の名前（値は出さない）を `::error` に出して止まる。
  - フラグの値が `true`・`false`・未設定のどれか
  - 下の「前提」のフラグが ON か。ホストの画面と DB は `enable_host_calendar=true` のときだけ配線されるので、`false` の候補ではどのフラグも ON にできない
  - 要る設定の形と、Secret の参照が `secret-name:数字version` か
  - 前提は `apps/web/src/lib/resolve-config.ts` の規則と同じ。加えて、予約にはメールを要る（確認メールと予約ページのため）。`apps/web/src/lib/deploy-runtime-flags.test.ts` が、表の各フラグの出力を `resolveConfig` に通して、起動が失敗せずフラグが ON になることを確かめる
- **配備後の検証**：候補の revision の環境変数と Secret の参照のうち、表が扱う名前が、script の期待と完全に一致することを確かめる（余分なフラグも欠けも失敗）。昇格のときも variable を読み直して同じ検査をするので、候補を作ったあとで variable を変えると昇格は止まる。
- **本番の `BOOKINGS_ENABLED` は `false` のまま**：予約のフラグを ON にしても checkout は `UNAVAILABLE` を返す。販売の開始は下の「個別ゲートと切戻し」の「予約・販売」で別に判断する。

| フラグ（Cloud Run） | variable（`PROD_` の後ろ） | 前提 | 設定（variable、`PROD_` の後ろ） | Secret の参照（`PROD_` の後ろ）→ 環境変数 | workflow が入れる値 |
| --- | --- | --- | --- | --- | --- |
| `EXPERIENCE_GUEST_BOOKING_ENABLED` | `GUEST_BOOKING_ENABLED` | ホストの画面・DB、メール | `BOOKING_CONSENT_VERSION`、`PRIVACY_POLICY_URL`（任意） | `STRIPE_PLATFORM_SECRET_KEY_REF` → `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET_REF` → `EXPERIENCE_STRIPE_WEBHOOK_SECRET` | — |
| `EXPERIENCE_GUEST_MAIL_ENABLED` | `GUEST_MAIL_ENABLED` | DB | `MAIL_FROM`、`MAIL_REPLY_TO` | `SMTP_HOST_REF`・`SMTP_PORT_REF`・`SMTP_USER_REF`・`SMTP_PASSWORD_REF` → `EXPERIENCE_SMTP_*` | `EXPERIENCE_JOBS_AUDIENCE`＝サイトの URL、`EXPERIENCE_JOBS_SERVICE_ACCOUNT_EMAIL`＝`experience-jobs@<project>` |
| `EXPERIENCE_GUEST_QUESTIONS_ENABLED` | `GUEST_QUESTIONS_ENABLED` | ホストの画面・DB | — | — | — |
| `EXPERIENCE_TRANSLATION_ENABLED` | `TRANSLATION_ENABLED` | メールか質問 | — | `ANTHROPIC_API_KEY_REF` → `EXPERIENCE_ANTHROPIC_API_KEY` | — |
| `EXPERIENCE_GUEST_REVIEWS_ENABLED` | `GUEST_REVIEWS_ENABLED` | DB | — | — | — |
| `EXPERIENCE_HOST_ATTENDANCE_ENABLED` | `HOST_ATTENDANCE_ENABLED` | 予約 | — | — | — |
| `HOST_SALES_LEDGER_ENABLED` | `HOST_SALES_LEDGER_ENABLED` | ホストの画面・DB | — | — | — |
| `HOST_SALES_PAYOUTS_ENABLED` | `HOST_SALES_PAYOUTS_ENABLED` | 売上（台帳） | — | `STRIPE_PLATFORM_SECRET_KEY_REF` → `EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY` | — |
| `HOST_NOTIFICATION_SETTINGS_ENABLED` | `HOST_NOTIFICATION_SETTINGS_ENABLED` | ホストの画面・DB | — | — | — |
| `HOST_PWA_ENABLED` | `HOST_PWA_ENABLED` | ホストの画面 | — | — | — |
| `HOST_PUSH_ENABLED` | `HOST_PUSH_ENABLED` | PWA・DB | `HOST_PUSH_VAPID_PUBLIC_KEY`、`HOST_PUSH_VAPID_SUBJECT` | `HOST_PUSH_VAPID_PRIVATE_KEY_REF` → `HOST_PUSH_VAPID_PRIVATE_KEY` | `HOST_PUSH_JOB_AUDIENCE`＝サイトの URL、`HOST_PUSH_JOB_SERVICE_ACCOUNT_EMAIL`＝`experience-host-push@<project>` |
| `EXPERIENCE_GOOGLE_BUSY_SYNC_ENABLED` | `GOOGLE_BUSY_SYNC_ENABLED` | ホストの画面・DB | — | — | `EXPERIENCE_GOOGLE_JOBS_AUDIENCE`＝サイトの URL、`EXPERIENCE_GOOGLE_JOBS_SERVICE_ACCOUNT_EMAIL`＝`experience-google-jobs@<project>` |
| `EXPERIENCE_GOOGLE_BOOKING_EVENTS_ENABLED` | `GOOGLE_BOOKING_EVENTS_ENABLED` | ホストの画面・DB | — | — | 上と同じ |

- 「ホストの画面・DB」は本番では `enable_host_calendar=true`（と `PROD_HOST_CALENDAR_READY=true`）。サイトの URL は `https://experience.niho.life`、`<project>` は `niho-app-prd`。
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

## 個別ゲートと切戻し

| ゲート | 開く前の証跡 |
| --- | --- |
| 表示 | 本番候補で mock/pilot fixture が出ず、`/preview/states` と `/preview/checkout` が404。公開APIは掲載済みだけ。モバイル・デスクトップと主要エラー表示、商品原稿・写真許諾を確認 |
| 予約・販売 | 合成提供者と Stripe test の掲載→予約→決済→確定→予約一覧→売上→返金、販売者/口座/条件、停止・期限切れ・再送を確認。P-01/02の実条件、サポート窓口、販売開始判断者が確定してから `BOOKINGS_ENABLED=true` と NIHO側受付を開く |
| 検索 | canonical・sitemap・robots、公開原稿と写真、計測の公表が揃ってから `SITE_INDEXING=allow`。販売開始とは別に判断 |
| Guide CMS公開元 | [Guide CMSのdatabase flagゲート](guide-cms.md#database-flagを開く前のゲート)をstagingで満たし、migration/bucket/NIHO editor auth/移行件数を照合してから、専用の配備変更でだけ `EXPERIENCE_GUIDE_PUBLIC_SOURCE=database`。DB/storage障害時にstaticへ戻らないこと、CloudflareがHTML・sitemap・mediaをcacheしないことを確認。切戻しはデータを消さず`static`の新revision。`EXPERIENCE_GUIDE_PUBLIC_SOURCE=editor`（#252・editor v1 契約に合わせ済み）は editor.niho.life の公開（設計の段階 3）が本番で使え、`api.editor.niho.life` が開き、カテゴリの扱いのオーナー判断（[残る差](guide-cms.md#v1-に合わせた記録と残る差epic-251)）が済むまで有効化せず、`GUIDE_EDITOR_API_*` の Secret Manager・workflow 配線もそれまで行わない（`GUIDE_EDITOR_API_TOKEN` は editor の面の資格で期限があるので、払い出しと入れ替えの運用も先に決める）。書き手の入口の `GUIDE_EDITOR_SITE_ORIGIN=https://editor.niho.life` は公開元と独立で、editor.niho.life が本番で開けることを確かめてから渡す。開くときは [editor 公開APIの切替](guide-cms.md#切替切戻し) をstagingで満たし、Cloudflareが `/guides*`（`/guides/preview` を含む）と sitemap を cacheしないことを確認。切戻しは `database` か `static` の新revision |
| 外部提供者 | 連携B #19123 の登録・権限・口座・売上の受入後にだけ `HOST_SIGNUP_MODE=open` |
| ホストの画面 | NIHO 側の接続（niho-app #19282、#19283）の本番配備と [#92](https://github.com/niho-life/niho-experience/issues/92) の受入の後にだけ `enable_host_calendar=true` の候補を昇格する |
| 計測 | NIHOのプライバシーポリシーに Umami Cloud の送信内容・目的・保存期間を追記し、同意方針の確認後だけ `UMAMI_WEBSITE_ID` を設定。previewには設定しない |

緊急停止はまず NIHO の掲載/受付を止め、サイト側も `BOOKINGS_ENABLED=false` の安全revisionへ戻す。サイトのtrafficを直前revisionへ戻しても、成立済み予約・返金は NIHO の予約一覧と台帳で追う。Cloud Run trafficの変更後に revision、100% の配分、トップ/詳細/予約停止、NIHO側の予約一覧・返金導線をreadbackする。停止・切戻し・再開の日時とSHAを #15 に残す。
