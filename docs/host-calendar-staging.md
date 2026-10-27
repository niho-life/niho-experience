# ホスト・Google Calendar の staging 受入準備（#92）

[ADR 0002](adr/0002-experience-domain-ownership.md) に従い、`niho-app-stg` 内に Experience 専用サービスを置く。通常の mock preview、本番、NIHO app のサービスとは実行ID・配備ID・Artifact Registry・OIDC poolを分ける。販売・検索登録は常に停止する。この手順を用意しただけでは受入完了にならない。

API契約は、このリポの体験業務 v1 と、固定された NIHO host/account 契約を使う。移行元公開APIは `1.0` を維持する。NIHO側 #19282/#19283 の merge・stg配備・契約確認が済むまで readiness を有効にしない。NIHO app のコード・配備設定は連携担当が変更する。

## 固定リソースと権限

| 項目 | staging 専用の値・境界 |
| --- | --- |
| Project / region | `niho-app-stg` / `asia-northeast1` |
| Cloud Run | `niho-experience-host-stg`。初回placeholderはprivate、候補は0%配信（公開状態はservice単位で継承） |
| Artifact Registry | `experience-host-stg`。このrepoに限りdeployerがwriter、Cloud Run service agentがreader |
| Runtime SA | `experience-host-stg-runtime`。6個の対象SecretだけAccessor、既存SQL instanceだけ条件付きClient |
| Deployer SA | `experience-host-stg-deployer`。対象Cloud Run serviceだけ `run.admin` / `run.invoker`、runtime SAだけ `serviceAccountUser` |
| OIDC | 専用pool `experience-host-staging` / provider `github`。固定repo ID・repo名・main・手動workflow・`host-staging` Environmentを検査 |
| Cloud SQL | 既存 `niho-app-db-stg` を使用するが、Experience専用DB・DBユーザーを別途作る。NIHO業務DBへ接続しない |

Owner/Editor、project全体のRun Admin、project全体のSecret Accessor、SA鍵は付けない。deployerはSecretの値を読めず、DBにも接続しない。RuntimeのCloud SQL Clientは [Google公式のIAM条件](https://docs.cloud.google.com/sql/docs/postgres/iam-conditions) で既存instanceだけを許す。SQLのDB権限は別途制限する。

## 初期設定（運用担当がレビュー後に手動実施）

1. GitHub Environment `host-staging` を新規作成し、deployment branchは `main` のみ、required reviewerと自己承認禁止を設定する。保護が実際に使えることを確認する。`STG_HOST_DEPLOY_ENABLED` は未設定または `false` のままにする。
2. 管理者が対象project・請求・既存instanceを確認して、レビュー済みSHAから `CONFIRM_HOST_STAGING_SETUP=niho-app-stg bash scripts/gcp/setup-host-staging.sh` を実行する。これは明示的なGCP変更である。scriptはAPI有効化、専用identity/repository/service/IAMを作る。DB・DBユーザー・Secret・既存サービス・共有instanceの設定は変更しない。初回はSecret/DBなしのprivate placeholderを作る。
3. 出力された4個の `STG_HOST_*` をEnvironment Variablesへ登録する。値はresource識別子であり、秘密値ではない。既存providerの設定が異なる場合はscriptを止め、IAMを緩めずレビューする。
4. 特権を持つmigration専用IDでExperience専用DB・専用DBユーザー・バックアップ方針を用意する。NIHO業務DBを使わない。`packages/experience-store/migrations/` のSQLを名前順に適用する。RuntimeにDDL・role作成権限を渡さず、必要なtable/sequence DMLだけを付ける。共有instance内の他DBへの接続/読取を拒否できるか確認する。ここはこのscript/workflowでは実行しない。
5. 合成提供者と専用のテストNIHOアカウントを、正当な権限を持つ非公開のprovisioning経路で結ぶ。`provider_memberships` を含む実ID・SQL応答・接続URL・Google資格情報はGit、公開Issue、PR、CIログへ記録しない。実顧客・実提供者・本番DBの複製は使わない。

## Secret Manager（値は管理者だけが登録）

Secretはすべて `niho-app-stg` に新規のExperience専用品として作成する。Firebase keyもNIHO **stg** の値を使う。versionは数字へ固定し、`latest` やaliasを使わない。

| Environment Variable | Secret名（値は書かない） | Cloud Run環境変数 |
| --- | --- | --- |
| `STG_HOST_SESSION_SECRET_REF` | `experience-stg-host-session` | `HOST_SESSION_SECRET` |
| `STG_HOST_FIREBASE_WEB_API_KEY_REF` | `experience-stg-niho-firebase-web-api-key` | `NIHO_FIREBASE_WEB_API_KEY` |
| `STG_HOST_DATABASE_URL_REF` | `experience-stg-database-url` | `EXPERIENCE_DATABASE_URL` |
| `STG_HOST_GOOGLE_CLIENT_ID_REF` | `experience-stg-google-client-id` | `EXPERIENCE_GOOGLE_CLIENT_ID` |
| `STG_HOST_GOOGLE_CLIENT_SECRET_REF` | `experience-stg-google-client-secret` | `EXPERIENCE_GOOGLE_CLIENT_SECRET` |
| `STG_HOST_GOOGLE_TOKEN_KEY_REF` | `experience-stg-google-token-key` | `EXPERIENCE_GOOGLE_TOKEN_KEY` |

各Variableには上表のSecret名と有効な数字versionを `secret-name:VERSION_NUMBER` 形式で指定する。秘密値をGitHub Variablesへ登録しない。session keyは32文字以上の専用乱数、Google token keyは32 bytesの専用乱数を標準base64へ変換した値とする。鍵の作成・登録は安全な管理端末で行い、標準出力・shell履歴へ値を出さない。

DB URLはExperience専用DB・限定ユーザーを使い、[Cloud RunのUnix socket接続](https://docs.cloud.google.com/sql/docs/postgres/connect-run) に合わせて `/cloudsql/niho-app-stg:asia-northeast1:niho-app-db-stg` をhostとして `pg` が解釈できる形で設定する。資格情報のURL encode、DB名、socket指定、接続とDMLの可否を非公開の管理経路で確認する。workflowは値を取得・表示しない。

管理者は各Secretに対して、次のresource単位のbindingを6件だけ追加する（`SECRET_NAME` は上表のいずれかへ置換）。既存NIHOのSecretへの権限は追加しない。

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
5. `BOOKINGS_ENABLED=false`、`SITE_INDEXING=block`、`HOST_SIGNUP_MODE=pilot` は固定。Stripe/ゲスト予約/販売/本番Google接続を受け入れたとは扱わない。定期同期workerの配備もこのworkflowの対象外で、同期が古いときの受付停止を確認する。
6. 昇格せず破棄する候補は運用担当がtagを除去する。公開済みservice上では0%でもtag URLへアクセスできるため、保留候補のSHA・tag・破棄予定を運用記録で管理し、受入後に未使用tagがないことを確認する。tag除去はrevisionや配信中trafficの削除を意味しない。
7. #92へはSHA・image digest・テスト項目と成否・未実施理由だけを残す。実ID、DB接続情報、OAuth state/code/token、cookie、Calendar ID、予定の件名/説明/参加者、スクリーンショット内の個人情報を公開しない。

候補GETの成功は、DB/membershipの正しさやGoogle OAuth完了を証明しない。受入が終わるまで #92 をcloseせず、NIHOの旧提供者画面の転送・撤去、本番配備は別の受入に進める。
