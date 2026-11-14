# ADR 0001：公開サイトの技術構成とホスティング

- 状態：採用（ホスティング・表示名は2026-10-19にオーナー承認）
- 日付：2026-10-19
- 関連：[#5 開発基盤](https://github.com/niho-life/niho-experience/issues/5)

## 判断材料

`docs/architecture.md` の条件に従い、SSRの可否、公開データだけでのビルド、開発速度、運用費で比べた。既存NIHOapp（`apps/web`）は Next.js 16 / Tailwind CSS 4 / TypeScript / Vitest / Node 24 で動いている。

## フレームワーク

| 候補 | SSR・SEO | 予約フォーム等の動的処理 | NIHOとの相性 | 判断 |
| --- | --- | --- | --- | --- |
| **Next.js 16（App Router）** | Server Componentで本文をSSR。metadata/sitemap/robotsを標準で持つ | Server Actionでサーバー側からゲストAPIを呼べ、PIIをブラウザ保存せずに済む | 同じ版・同じ書き方。担当間で知識を共有できる | **採用** |
| Astro | 静的・SSRとも得意。JSが少ない | 予約入力は島（React等）を別に組む必要 | 新しい技術を一つ増やす | 不採用 |
| React Router v7 | SSR可 | loader/actionで可 | NIHOに前例なし | 不採用 |

採用した版（`package-lock.json` で固定）：

- Next.js 16.3.8（NIHOappと同じ）、React 19.3、TypeScript 5.9、Tailwind CSS 4.3
- zod 4（契約の検証）、Vitest 4.1、Playwright 1.56 + axe-core（E2E・アクセシビリティ）
- 書体は `@fontsource-variable` の Fraunces と Nunito を npm から同梱（ビルド時に外部取得しない）。日本語サイトの見出しだけ `@fontsource/zen-maru-gothic`（丸ゴシック、#612）
- Node 24（`.nvmrc`）。npmは workspaces を使う

## ホスティング

**決定：Cloud Runで動かし、Cloudflareを入口に置く。NIHOappと同じ形にする。**

2026-10-19にNIHOappの運用文書（`gcp/README.md`、`gcp/sot/public-front-door-sot.md`）で確認した事実：

- NIHOappの画面とAPIは、GCPプロジェクト `niho-app-prd` / `niho-app-stg` のCloud Runで動いている。
- 本番の `niho.life` と `app.niho.life` はCloudflareを入口（WAF・CDN）にし、その奥のGCPへ接続している。

| 候補 | 長所 | 注意点 | 判断 |
| --- | --- | --- | --- |
| **Cloud Run＋Cloudflare（入口）** | Next.jsが普通のNodeサーバーとして変換なしで動く。NIHOの手順・権限（`@niho.life`）・ログ・Cloudflare設定を使える。少量アクセスなら低コスト | 待機中からの最初の表示が遅くなる（本番は最小インスタンス1）。PRごとのプレビュー環境は自前で用意 | **採用** |
| Cloudflare Workers（OpenNext） | 利用者の近くで動き安い | Next.jsとの間に変換層が入る。データはNIHOのAPIから取るので、近くで動く利点が小さい。配備の仕組みが一つ増える | 不採用 |
| Vercel | PRプレビューが最も簡単 | 商用は有料プラン。別ベンダーの契約・権限が増える | 不採用 |

構成の決まり：

- NIHOappとは別のCloud Runサービスにする。GCP projectの分離はより強い隔離として推奨するが、初期pilotは既存の `niho-app-prd` に置き、専用runtime SA・Artifact Registry・Workload Identityと、Experienceサービスに限定したdeployer権限で境界を作る。売上や取扱データ、可用性要件が増えた段階で専用projectへ移行する。リージョンはNIHOのAPIと同じにする。
- 画像・JS・CSSはCloudflareでcacheする。予約入力・決済復帰・previewはアプリが `Cache-Control: private, no-store` を返すので、Cloudflare側でもcacheしない設定を確認する。
- イメージは一つだけ作り、プレビューと本番へ同じものを出す。環境ごとの値（`SITE_INDEXING`、`EXPERIENCE_API_MODE`、`HOST_SIGNUP_MODE` 等）は実行時の環境変数で渡し、ページ側はリクエスト時に読む。ビルドに環境ごとの値を焼き込まない。
- 実装：`next.config.ts` の `output: "standalone"`、root の `Dockerfile`（Node 24 slim をdigestで固定、非rootで実行、port 8080）。`scripts/container-smoke.sh` で、同じイメージが設定だけで検索許可・提供者登録の表示を切り替えることを確認する。

GCP・Cloudflareの準備と配備はオーナー承認済み（2026-10-19）。プレビューは `main` から自動配備する（`.github/workflows/deploy-preview.yml`、初回準備は [deploy-setup.md](../deploy-setup.md)）。本番のサービス・入口方式（Cloudflareの使い方）は公開ドメインと合わせて決める。

## 表示名・ドメイン

- 表示名は「NIHO Experience」で決定（2026-10-19 オーナー承認）。
- 公開ドメインは本番公開前に、NIHO既存ページの正規URL方針と合わせて決める（#12・#15）。

## CIと配備の分離

- 公開PRのCIは GitHub-hosted runner、`permissions: contents: read`、secretなし、合成データのみ（`.github/workflows/ci.yml`）。外部PRも同じ条件で走り、社内runner・本番secret・配備権限に触れない。
- Actionは commit SHA で固定する。依存は lockfile で固定し `npm ci` で入れる。
- 同じPRの古い実行は `concurrency` で止める。
- `docs/**` と `*.md` だけの変更ではCIを起動しない。必須チェックに設定する場合は、文書だけのPRが待ち状態にならないよう、ブランチ保護の設定と合わせて決める。
- CIはコンテナイメージもビルドし、起動確認する（pushはしない）。
- 本番配備は、レビュー済みの固定SHAから作ったイメージを対象に、secretを持たないビルドと、信頼済みのdeploy（保護された環境・承認者付き。GCPへはOIDCで認証し、鍵ファイルを置かない）を別ジョブ・別権限に分ける。プレビューの配備はこの形で実装済み（ビルド・smoke testの後にOIDCで認証し、`main` だけが配備できる）。本番も同じ形で、承認者付きの環境を別に設ける。

## 結果

- 新規cloneから `npm ci && npm run dev` で、英語の画面と合成データが表示できる（`docs/development.md`）。
- `docker build .` で配備用のイメージができ、`PORT=8080` で起動する。
- 本物のAPIは `EXPERIENCE_API_MODE=http` で接続するが、契約確定（#7・連携A）まで意図的に失敗する。
