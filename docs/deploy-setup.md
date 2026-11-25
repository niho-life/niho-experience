# プレビュー配備の準備（Cloud Run）

`main` に入った変更を、合成データのプレビューとしてCloud Runへ自動で出すための初回準備。構成の判断は [ADR 0001](adr/0001-web-stack.md)、本番の受入・停止は [release-acceptance.md](release-acceptance.md)。

## 何が起きるか

```text
main に merge → GitHub Actions（.github/workflows/deploy-preview.yml）
  1. イメージをビルドし、smoke test（ここまで資格情報なし）
  2. GitHubのOIDCでGoogle Cloudに認証（鍵ファイルなし。mainのこのリポだけが使える）
  3. Artifact Registryへ登録 → Cloud Runの niho-experience-preview を更新
  4. 公開URLで表示とrobots.txt（検索除外）を確認し、URLを実行結果に表示
```

- プレビューはmock（`EXPERIENCE_API_MODE=mock`）で、検索に出ず、予約も決済もできない。表示する体験は、既定で掲載許可のある最初の5体験（`MOCK_CATALOG=pilot`、価格・日程は推奨値）。架空の合成データに戻すときは、手順2-2と同じ画面でリポジトリ変数 `PREVIEW_MOCK_CATALOG` を `synthetic` にして配備し直す。Cloud Runの画面で環境変数を直接変えても、次の配備で上書きされる。
- 最小インスタンス0なので、使わない時はほぼ費用がかからない（しばらく使わないと最初の表示に数秒かかる）。
- 初期pilotは既存 `niho-app-prd` に専用Cloud Runサービスとして作る。GitHub deployerにはそのサービスだけのCloud Run管理権限を付与し、NIHOappのruntime identity・DB・Secretsには触れない。分離の判断と本番の入口は [production-deploy.md](production-deploy.md) を参照。
- 準備が済むまで、このworkflowは何もせずに終わる（`GCP_PROJECT_ID` 変数がない間はskip）。

## 手順1：Google Cloudの準備（オーナーが1回だけ）

`@niho.life` の管理者アカウントで [Cloud Shell](https://shell.cloud.google.com/) を開く（iPhoneのブラウザでも使える）。次の2行を実行する。

```sh
curl -fsSLO https://raw.githubusercontent.com/niho-life/niho-experience/main/scripts/gcp/setup-preview.sh
bash setup-preview.sh
```

スクリプトがすること（何度実行しても安全）：

| 作るもの | 内容 |
| --- | --- |
| プロジェクト `niho-experience-web` | NIHOの組織に作り、請求先を紐付ける |
| Artifact Registry `web`（asia-northeast1） | イメージ置き場。新しい10個を残し、30日より古いものを消す |
| サービスアカウント `experience-runtime` | サイトが動く時の身元。権限なし |
| サービスアカウント `experience-deployer` | 配備用。Cloud Runの更新・イメージ登録・runtimeの指定だけ |
| Workload Identity（`github` / `niho-experience`） | GitHub Actionsのうち、このリポ（ID固定）の `main` だけがdeployerを使える |

止まった時：

| 表示 | 対処 |
| --- | --- |
| `Found N candidates for ORG_ID` / `BILLING_ACCOUNT` | 表示された候補から選び、`ORG_ID=… bash setup-preview.sh` のように付けて再実行 |
| プロジェクトIDが使われている | `PROJECT_ID=niho-experience-web2 bash setup-preview.sh` のように別のIDで再実行 |
| 権限がない（PERMISSION_DENIED） | 組織の管理者（プロジェクト作成・請求先の紐付けができる人）のアカウントで実行 |

最後に `GCP_…=…` の6行が表示される。パスワードや鍵ではない（貼り間違いを確認するためにチャットへ貼っても問題ない）。

## 手順2：GitHubの設定（オーナー、ブラウザで5分）

iPhoneの場合はSafariで github.com を開き、画面下の「aA」→「デスクトップ用Webサイトを表示」にすると Settings が出る。

**2-1. 配備できるブランチを `main` に限る**

1. https://github.com/niho-life/niho-experience/settings/environments を開く
2. **New environment** → 名前 `preview` → **Configure environment**
3. **Deployment branches and tags** で **Selected branches and tags** を選ぶ → **Add deployment branch or tag rule** → `main` → **Add rule**
4. 他は空のまま **Save protection rules**

**2-2. 手順1の6行を登録する**

1. https://github.com/niho-life/niho-experience/settings/variables/actions を開く（**Variables** タブ。Secretsではない）
2. **New repository variable** で、`=` の左を Name、右を Value にして6つ登録する

| Name | Value の例 |
| --- | --- |
| `GCP_PROJECT_ID` | `niho-experience-web` |
| `GCP_REGION` | `asia-northeast1` |
| `GCP_ARTIFACT_REPOSITORY` | `web` |
| `GCP_WIF_PROVIDER` | `projects/123456789012/locations/global/workloadIdentityPools/github/providers/niho-experience` |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | `experience-deployer@niho-experience-web.iam.gserviceaccount.com` |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | `experience-runtime@niho-experience-web.iam.gserviceaccount.com` |

値は手順1で表示されたものを使う（上は例）。

## 手順3：最初の配備

Actions → **Deploy preview** → Run workflow（branch: main）。5〜10分で終わり、実行結果の上部にプレビューのURL（`https://niho-experience-preview-….a.run.app`）が出る。以後は `main` へのmergeごとに自動で更新される。

## stg公開文書のSSR候補（#39/#42）

NIHO stgで公開済みの英語文書をクラウドSSRで確認するときだけ、既存の **Deploy preview** を手動起動する。branchは `main`、`stg_documents` を有効にし、`commit_sha` には起動時点の `main` と完全一致する40文字SHAを入力する。公開文書の `home/en` が準備済みであることを先に確認する。入力SHAがcurrent `main` と違う場合は、build前かつGoogle Cloudの資格情報を取得する前に停止する。

この起動は、新しいプロジェクト・サービス・サービスアカウント・IAM・有料resourceを作らない。既存の `niho-experience-preview` と現在の有効なtraffic配分がある場合だけ、stg公開APIを読むrevisionを `--no-traffic --tag stg-docs-<sha12>` で追加する。既存serviceの公開・IAM・ingress設定は変更せず、配備前後でpercentが正のrevision配列と割合が完全一致することをworkflowが確認するため、通常のmockプレビューは引き続き配信される。公開文書のreadbackは配備資格情報を持たない別jobがreview済みSHAをcheckoutして実行する。サービスが未作成、trafficが無効、候補URLをCloud Run statusから取得できない、またはreadbackが不一致ならfail closedで停止する。

候補は表示用公開文書のGET・SSRだけを受け入れる。`SITE_URL` は候補URLではなく既存previewサービスのstatus URLへ固定し、`SITE_INDEXING=block`、`BOOKINGS_ENABLED=false`、stgのNIHO管理入口を維持する。この候補をcanonical切替、販売開始、予約API、決済、個人情報、ログインcookieの受入には使わない。商品が0件でもHome文書SSRは判定できるが、Booking実APIは未検証として実行summaryへ残る。`EXPERIENCE_SITE_PUBLIC_ORIGIN` の設定や候補をtrafficへ昇格する操作は、この手順には含まれない。

CSPの接続許可はビルド時に固定されるため、候補だけ `NIHO_WEB_CSP_ORIGIN=https://app-stg.niho.life` でイメージを作る。通常版は既定の `https://niho.life` のままとし、コンテナsmokeと候補readbackで接続許可先を確認する。

通常のpushと、`stg_documents`を無効にした手動起動は、従来どおりmockプレビューを更新する。

### 合成商品の予約受入候補

実APIの予約受入では `stg_documents=true` に加えて `stg_bookings=true` を指定する。固定候補URLは
`https://stg-booking---niho-experience-preview-aotuusf7xq-an.a.run.app`。
`SITE_URL` もこのURLに固定し、`BOOKINGS_ENABLED=true` にする。候補の配信割合は0%のまま、通常プレビューの配分・IAM・ingress・検索除外を維持する。

起動前にNIHO側の公式設定経路で、stg Webの `EXPERIENCE_SITE_ALLOWED_ORIGINS` にこのexact originだけを追加する。
本番設定・`EXPERIENCE_SITE_PUBLIC_ORIGIN` は変更しない。共通基盤側の設定変更は連携担当へ集約する。
配備資格情報を持たないbuild jobが `scripts/stg_booking_preflight.py` で以下を確認し、不足があればイメージ作成前に停止する。

- `stg-synthetic-booking-acceptance` が公開中の英語合成商品で、Checkout受付中。
- 商品は `Synthetic test session` 1件、JPY 100円、定員・1組上限2名。予約可能で残席2の開催枠がある。
- availabilityは `no-store`。GETとcheckoutのOPTIONSが候補のexact originを許し、資格情報付きCORSを許可しない。

NIHO stgのStripeキーがテスト用であることを公式のstg preflightで先に確認する。ブラウザで生成したCheckoutも `livemode=false` を確認してから、Stripe公式テスト値だけを入力する。実カード・実顧客情報は使用しない。
このworkflowは予約作成・決済・取消を自動実行しない。配備成功は受入完了を意味しない。
PC/スマホで日時・人数・入力・Checkout・失敗からの復帰・計測ブロック時の予約・満席・掲載停止を確認し、テスト予約・仮押さえの取消と合成掲載の停止まで別途記録する。

`--no-traffic` は以後のLATESTへの自動配分も止めるため、通常のmock配備では、同じcommitかつmock設定のrevisionを再検証し、そのrevision名へ100%を明示配分します。候補配備ではこの操作を実行しません（[Cloud Runの仕様](https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy)）。

## うまくいかない時

| 症状 | 確認すること |
| --- | --- |
| `auth` の段で `Permission 'iam.serviceAccounts.getAccessToken' denied` | 手順1を最後まで実行したか。権限の反映に数分かかることがある |
| `auth` の段で `unauthorized_client` / attribute condition | `main` 以外から実行していないか |
| `Deploy` の段で権限エラー | `GCP_RUNTIME_SERVICE_ACCOUNT` と `GCP_DEPLOY_SERVICE_ACCOUNT` の値が手順1の表示と同じか |
| URLを開くと403 | 組織のポリシーで公開が禁止されている可能性。Cloud Runの「認証が不要」が有効か確認する |

## 本番について

本番の固定SHA配備、GCP projectとCloud Runの権限境界、`travel.niho.life` の入口・DNS/TLS/cache、NIHO側のCORS/canonical、販売・検索・外部提供者の個別ゲートは [production-deploy.md](production-deploy.md) を正とする。

## Cloudflareについて

**プレビューにはCloudflareは不要。** Cloud RunのURLで見られる。

本番（独自ドメイン）ではCloudflareを入口に置く。ホスト名は `travel.niho.life` と決まった。

入口はNIHOが既に使う global external Application Load Balancer と Cloudflare proxy を再利用する。Cloud Runの直接domain mappingはGoogleがproductionに推奨していない。Cloudflareでcacheするのは初期は `/_next/static/*` だけとし、予約入力・決済後ページはbypassを確認する。

本番候補のworkflowと準備スクリプトは用意済み。既存請求とALBを確認してからExperience専用サービスを作り、受入中は最小インスタンス0・予約停止・検索除外で運用する。販売開始時の最小インスタンス1への変更も受入記録に含める。

Umami CloudのWebsite IDは `f7a8b3ed-ef71-4a35-969e-955b88f01902`（ドメイン `travel.niho.life`）。プライバシーポリシーへの計測内容の追記後に、実行時環境変数 `UMAMI_WEBSITE_ID` として本番サービスだけへ設定する。previewには設定しない。サイトID自体は公開情報で、GitHub Secretではなくランタイム設定として扱う。
