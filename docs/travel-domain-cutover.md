# NIHO Travel のホスト名切替（#653）

| 用途 | origin |
| --- | --- |
| 本番 | `https://travel.niho.life` |
| staging | `https://travel-stg.niho.life` |
| 本番候補 | `https://travel-candidate.niho.life` |
| 旧本番 | `https://experience.niho.life`。切替後は恒久301 |

公開名は英語・日本語とも NIHO Travel。パス・slug、Public API v1.0、NIHO Host v1.0.0 を維持する。Cloud Run サービスと DB は同じものを使う。既存の stg 候補URLは workflow の構成確認専用。新しいホストでの操作受入は stable の staging で行う。

## 1. 先行設定

1. NIHO 本体で新旧双方の許可 origin と App Connect の戻り先を登録し、先に配備する。記事連携が使う URL も送信側で確認する。旧 origin を許可から外すのは全切替の読戻し後。NIHO の公開 origin や生成リンクの正規値は、新しい配信先が応答する段階で切り替える。
2. [本番配備](production-deploy.md#travelniholife-の入口本番revisionを昇格前に準備) の手順で Cloudflare DNS/TLS、Authenticated Origin Pull、ALB の host mapping を準備する。本番候補の NEG は本番の `candidate` タグを参照し、Cloudflare でも GET/HEAD に制限する。候補は noindex・robots 全面拒否・予約フォーム拒否。候補を OAuth・Webhook・Scheduler に登録しない。旧本番と旧 stg の edge は切替の読戻しまで残す。
3. Google OAuth に新旧の戻り先を追加する。対象は `/host/calendar/google/callback` と `/admin/auth/google/callback`。NIHO アカウントの戻り先はホスト・旅行者・記事執筆者も確認する。既存カレンダー名と既存予約・口座のデータは維持する。

## 2. staging で先に受け入れる

`STG_HOST_SERVICE_URL=https://travel-stg.niho.life` に合わせ、公式 workflow で候補を作成・昇格する。staging の Stripe TEST Webhook、Scheduler URL / OIDC audience、通知が使う origin を新URLへ合わせる。Chrome で英日トップ・体験・記事・ホスト・管理、NIHO ログインの往復、ゲストの Stripe TEST 決済・確認メール・予約確認・キャンセル、Google の接続・busy・通知を受け入れる。ログ・Issue には予約や OAuth のトークン、実データを載せない。

## 3. 本番候補を確認して昇格する

配備と昇格で同じ承認済み SHA と機能フラグを使う。現在の販売可否を維持する。候補で origin、noindex、予約拒否と sitemap の本番URLを確認する。旧ホストで開始済みの認証往復は昇格前に完了させる。昇格後、stable の新ホストで英日ページ、体験一覧・詳細、記事、`/host`、`/admin`、`/bookings` が応答し、canonical・hreflang・OG URL・構造化データ・robots・sitemap が新本番を使うことを確認する。

旧ホストの転送はまだ有効化せず、下表の送信元を新ホストへ切り替えて読戻す。301 を追うクライアントは POST を GET に変える場合があり、Stripe も 3xx を配信成功と扱わない。動いているサービス間通信を転送に依存させない。

| 経路 | 切替と読戻し |
| --- | --- |
| Stripe Connect / platform | `/api/experience/stripe/webhook` と `/api/experience/stripe/platform-webhook` の既存宛先 URL を更新する。接続口座と platform の署名鍵を区別し、既存 destination と runtime の Secret 参照を照合する。再試行中の配信を含めて新 URL が 2xx で署名済みイベントを受けることを確認する |
| NIHO guest-mail feedback | NIHO の `EXPERIENCE_GUEST_MAIL_FEEDBACK_URL` と `EXPERIENCE_GUEST_MAIL_FEEDBACK_AUDIENCE`、Experience の `PROD_EXPERIENCE_MAIL_FEEDBACK_AUDIENCE` を同じ新 origin に合わせる。受信側が有効な間に送信側を切り替え、不達イベントが新 URL で取り込まれることと旧 URL 宛の未処理が無いことを確認する |
| Scheduler / OTA / 記事連携 | `/internal/` のジョブ（メール・push・Calendar busy/booking events・OTA watchdog）と記事連携の宛先を確認する。公開ホストを使う URI と、それに対応する OIDC audience を同時に更新し、双方の設定と 2xx を読戻す。NIHO API や固定 run.app を audience とする契約はその値を使う |
| Google Calendar の watch | `/api/google/calendar/watch` の新 URL を runtime から登録する。既存チャネルの通知先は発行時に固定で、次の周期同期は満了の24時間前まで新チャネルを作らない（発行時は最長6日を要求）。旧ホストへの `POST` を受けられる状態を維持し、旧チャネルの満了と新 URL への通知の 204 を確認する。切替を早める場合も、承認済みの Google 接続手順で古いチャネルを停止して新チャネルで通知を受けてから進む。定期の busy 照合は継続する |
| 予約とログイン | Checkout の success/cancel、ゲストとホスト宛メール、Google Calendar / Admin OAuth、NIHO 認証の開始・復帰を新ホストで確認する。旧セッションと OAuth の確認 cookie は旧ホストに属する。切替後は新ホストでログインし、未完了の OAuth もやり直す |

## 4. 旧本番を恒久転送にする

1. 既知の送信元すべてで新 URL への配信を確認してから、Cloudflare の zone-level `http_request_dynamic_redirect` に [旧ホストの Redirect Rule](../scripts/deploy/travel-legacy-host-redirect.json) を追加する。既存ルールを維持し、旧ホストに先に一致する競合ルールが無いことを確かめる。旧ホストのプロキシ DNS と TLS を維持する。 [Cloudflare の Redirect Rules API](https://developers.cloudflare.com/rules/url-forwarding/single-redirects/create-api/)
2. `bash scripts/deploy/readback-travel-legacy-redirect.sh` で 301 の `Location` を直接確認する。パス、percent encoding、重複 query、UTM と `checkout=cancelled` を保持する。転送付きURLに実予約・決済情報を付けて検査しない。
3. Search Console で新ホストの所有権、新 sitemap、旧→新の転送を確認する。IndexNow は新ホストの鍵ファイルを確認してから送信する。GA4 データストリームと Umami の URL、メールの送信者表示（`PROD_MAIL_FROM` / `STG_MAIL_FROM` の名前を NIHO Travel）、外部の掲載・新規印刷用 QR を更新する。ログイン、ホーム画面アプリの入れ直しと通知の再登録は運用側で案内する。

301 の発効前に失敗した場合、旧 edge を残したまま直前の revision、Webhook URL・Scheduler URI と audience の組を戻せる。発効後はクライアントに301がキャッシュされるため、新本番ホストは維持し、修復または互換 revision の配信で復旧する。旧ホストでの公開再開は切戻し手段にしない。
