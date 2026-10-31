# ホストの画面をアプリとして使う（PWA）

[#177](https://github.com/niho-life/niho-experience/issues/177)。P1 で、ホストが `/host/` をスマホのホーム画面・Mac の Dock・PC のアプリとして追加し、アプリの窓で使えるようにした。P2 で、その端末へのプッシュ通知（Web Push）を足す（[プッシュ通知](#プッシュ通知p2)）。

## 範囲

- 対象はホストの画面だけ（scope `/host/`）。旅行者のページ（`(site)`・`(ja)`）と英語の紹介 `/host` は範囲外で、manifest も Service Worker も出さない。
- 入口はホストの root layout（`(host)/host/layout.tsx`）だけ。`HOST_PWA_ENABLED=true` のとき manifest・apple-touch-icon・`apple-mobile-web-app-*` を出し、`HostPwaRegistrar` が `/host/sw.js` を登録する。`viewportFit: "cover"` は付けない（上端の safe area は今のまま）。
- 起動先は `/host/launch`（console の枠の外）。アプリ内で始めたログインのセッションならホームへ、それ以外はログイン画面を出す。ブラウザで開いてセッションがあればホームへ進む。
- アプリでは、ログアウト（アプリ内でログインしたセッション）と、画面が見つけたセッション切れの行き先を `/host` ではなく `/host/launch` にする（範囲の外へ出ない）。`HOST_PWA_ENABLED=true` のとき、cookie が無い・期限切れの状態で console の URL を開いた場合の転送先も `/host/launch`（ブラウザでも日本語のログイン画面になる）。1 分以上裏にいたあと戻るとページを読み込み直す（編集中は除く。予約・メッセージは一覧を画面側で持つので、`router.refresh()` ではなく全体を読み込む）。裏にいる間に push が届いていれば、1 分未満でも戻ったときに読み込み直す。表示中に届いた push はサーバー側の部分（ホームのやること・アイコンの数）だけ更新する（P2）。
- 設定に「この端末」を足す（「アプリ」の行。追加済み・Chromium の追加ボタン・iPhone/iPad と Mac Safari の手順）。`HOST_PUSH_ENABLED=true` なら「通知」の行も出す（P2）。

## manifest

`/host/manifest.webmanifest`（`lib/host/pwa.ts`）。`HOST_PWA_ENABLED=false` では 404。

| 項目 | 値 |
| --- | --- |
| `id` / `scope` | `/host/` |
| `name` / `short_name` | NIHO 体験ホスト / 体験ホスト（niho.life の「NIHO host」と区別する） |
| `start_url` | `/host/launch?source=pwa` |
| `display` / `lang` | `standalone` / `ja` |
| 色 | `background_color`・`theme_color` とも `#ffffff`（layout の themeColor と同じ） |
| アイコン | `public/host-app/`。サイトの印（`app/icon.svg`）を leaf（`#B2D67C`）の地に置く。192・512・maskable 512（印は中央の安全な円の内側）・apple-touch-icon 180。元の SVG は同じフォルダ |
| shortcuts | 承認待ち `/host/bookings?filter=pending`・今日の回 `/host/bookings`（これからの一覧。ホームの「今日の開催」は開催の無い日に出ない）・メッセージ・カレンダー。Android と PC だけ |

## cookie の複製と surface の印

- iOS 17 以降と macOS Safari は、ホーム画面・Dock に追加した時点でブラウザの cookie をアプリへ複製する。
- セッション cookie には NIHO app-connect の refresh token が入る。NIHO は 1 つ前の token が回転から 10 分を過ぎて使われると `REFRESH_REUSE` として接続ごと失効させる。複製された cookie をブラウザとアプリの両方で更新すると、両方がログアウトになる。
- 対策：アプリ内で始めたログイン（`/host/auth/login?surface=app`）だけが、セッションに `surface: "app"`（cookie の `a: 1`）を持つ。印のない cookie（#177 より前の cookie を含む）はブラウザのセッションとして読む。
  - アプリの refresh 呼び出しは `x-niho-host-display: standalone` を送る。refresh API は、この header があり印のないセッションに 401 `app_sign_in_required` を返し、token を回転させず cookie も消さない。画面は `/host/launch` へ移り、アプリ内で NIHO の確認画面を通して新しい接続を作る。
  - console の枠は、アプリ内で印のないセッションを見たら `/host/launch` へ移す（`HOST_PWA_ENABLED=true` のとき）。
  - `/host/launch` はセッションを更新しない。
  - 再ログインのリンク（ログイン失敗の画面・接続終了の表示・サポート設定）は `HostLoginLink` で、アプリ内なら `?surface=app` を付ける。二度ログインにならない。
- 印は NIHO 側に送らない。NIHO 側の変更は無い。

## Service Worker

`/host/sw.js`（`lib/host/service-worker.ts`）、scope `/host/`。`/host/:path+` の header で `private, no-store`。CSP（`default-src 'self'`・`script-src 'self'`）で worker と manifest が通る。

- 担当はオフラインの案内だけ。同一 origin の `/host/` 配下のページ遷移（`mode: navigate` の GET）をネットワークへ流し、失敗したら端末内で作る日本語の案内（再読み込みボタン・外部参照なし・`no-store`）を返す。
- 次には介入しない：`/host/auth/*`（NIHO ログインの往復）、`/host/calendar/google/*`（Google カレンダー接続）、`/host/api/*`、ページ遷移以外の要求、旅行者のページ。
- Cache Storage は使わない（`caches.open`・`cache.put` を呼ばない。origin を旅行者のページと共有するので、既存の cache も消さない）。予約・参加者・メッセージ・売上の HTML/API を端末に保存しない。
- P2：`push` を通知として出し（読めない内容や `/host/` 外を開く内容は、ホームを開く「お知らせがあります」に置き換える。通知を出さない push が続くと iOS・Chrome が購読を取り消すため）、タップで開いているアプリの窓をそのページへ移す（無ければ開く）。`pushsubscriptionchange` では同じ鍵で購読し直して BFF へ登録し、古い endpoint を消す。

## プッシュ通知（P2）

メールに足す経路で、置き換えない。届く種類は設定 › 通知の 7 種と ON/OFF に従う（経路別の切替は作らない）。

- **通知 job（outbox の消費。オーナー決定 2026-10-31）**：承認制の予約と予約者からの連絡の正本は、予約の移行（ADR 0002）までは NIHO にあり、体験 DB には無い。NIHO 側は変えず、体験 DB の `outbox_messages` に積まれた通知を送る job を先に置き、積む側（予約・連絡の transaction）は移行で足す。予約前の質問（旅行者の質問と返信ページの答え）と、このサイトで受けた予約の確定は積む（#285 第5段、[guest-questions.md](guest-questions.md)・[guest-booking.md](guest-booking.md) の「ホストへの通知」）。承認期限と予約者からの連絡は、それらが体験 DB に移るまで積まれない。
  - topic は 4 つ（`packages/experience-store` の `host-notification-outbox.ts`）。`host.notify.guest_question`：予約前の質問・答え 1 件ごとに 1 行（`GUEST_MESSAGE` として送り、題は「予約前の質問が届きました」。payload はスレッド ID・メッセージ ID・体験名だけ）。`host.notify.new_booking`：このサイトの予約の確定ごとに 1 行（`NEW_BOOKING`。payload は予約 ID・体験名・日時・人数だけ）。`host.notify.approval_deadline`：承認期限の 6 時間前と 1 時間前の 2 行（期限まで 1 時間を切っていれば 1 時間前の 1 行をすぐ。過ぎていれば積まない）。承認・辞退・取消・期限切れの transaction で `cancelApprovalDeadlineReminders` が未処理の行を閉じる。`host.notify.guest_message`：予約者からの連絡 1 件ごとに 1 行。payload は予約 ID・体験名・日時・人数だけで、予約者名・本文・金額の欄が無い。ほかの topic（`booking.confirmed` など）には触らない。
  - 取り出しは `available_at` を lease に使う（`FOR UPDATE SKIP LOCKED` で取り、60 秒先へずらす。終わらなければ戻ってくる）。1 回の実行で最大 50 行を、送る直前に 1 行ずつ取り出す（まとめて取ると、遅い送信の間に後ろの行の lease が切れて別の実行が二重に送る）。完了・再試行は取り出したときの `attempts` と一致する行だけを更新し、lease 切れのあと別の実行が取り直した行には効かない。送れたら `processed_at`。期限を過ぎた承認期限・24 時間より古い連絡・質問・新しい予約・形の違う行は送らずに閉じる。購読の読み出しが失敗したら 1・5・15・60 分後に再試行し、5 回で諦める。端末ごとの失敗は従来どおり購読の側に記録する。
  - 届く種類は設定 › 通知に従う。承認期限は止められない。予約者からの連絡は止められる種類で、送る前に体験 DB の設定（#109、`ProviderNotificationSettings.enabledFor`。行が無ければオン）を読む。`HOST_NOTIFICATION_SETTINGS_ENABLED=false` で設定を読めない間は送らない側に倒す。設定の読み出しが失敗したら購読の読み出しと同じく再試行する。
  - タップ先は `/host/bookings?booking=…&providerId=…`（承認期限）、`/host/messages?booking=…&providerId=…`（連絡）、`/host/messages?thread=…&providerId=…`（質問）、`/host/bookings?booking=…&source=site&providerId=…`（このサイトの新しい予約）。同じ予約の承認期限は 1 時間前の通知が 6 時間前のものを置き換える（tag）。
  - 起動は `POST /internal/host-push/v1/drain`。Cloud Scheduler（毎分）が専用 service account の Google ID token で呼ぶ（`HOST_PUSH_JOB_AUDIENCE`・`HOST_PUSH_JOB_SERVICE_ACCOUNT_EMAIL`）。未設定・`HOST_PUSH_ENABLED=false` なら 404。応答は件数だけ。Scheduler・service account・環境変数の配線はまだしていない。
- **ロック画面に出すもの**：通知の種類・体験名・日時（JST）・人数だけ。`HostPushEvent` 型に予約者名・メッセージ本文・金額の欄が無い（`lib/host/push/payload.ts`）。本文は `{ v: 1, title, body, url, tag, badge? }` の JSON で 3 KB まで。`url` は `/host/` 配下のパスだけ。push service へ渡す `Topic` は tag の digest。
- **暗号と認証**：`packages/web-push`（`node:crypto` だけ）。RFC 8291 `aes128gcm`（RFC の例とバイト単位で一致することをテストで確かめる）と RFC 8292 VAPID（ES256・12 時間）。緊急度は新しい予約・承認期限・連絡・取消が `high`、ほかは `normal`。TTL は承認期限 1 時間・前日のまとめ 12 時間・ほか 24 時間。
- **endpoint の許可リスト（SSRF 防止）**：https・既定のポート・認証情報なし・ブラウザが直列化した形で、host が `fcm.googleapis.com`・`updates.push.services.mozilla.com`・`web.push.apple.com`・`*.push.apple.com`・`*.notify.windows.com` のどれか、2048 文字まで。ほかは送る前に拒否する。redirect はたどらない。endpoint はログ・URL・エラー文に出さない。
- **購読**：体験 DB の `host_push_subscriptions`（`packages/experience-store/migrations/0004_host_push_subscriptions.sql`）。NIHO user・接続・endpoint（一意。最後に購読した人の端末になる）・鍵・端末種別（User-Agent からの粗い区分）・`last_seen_at`・失敗回数。BFF は `/host/api/push-subscriptions`（登録 POST・解除 DELETE）・`/status`・`/test`（本人の端末だけ・30 秒に 1 回）。同一 origin とセッション cookie で確かめ、NIHO は呼ばない。DB 未設定は 503。mock は検証だけして保存も送信もしない。
- **消す・送らない条件**：ログアウトと、NIHO が接続を終えた refresh（`rejected`）でその接続の購読を消す（成功した refresh は `last_seen_at` を進める。どちらも認証の流れを止めない）。30 日見ていない端末には送らない。push service が 404/410 を返したら消す。設定を開くたびに、端末の購読がまだ本人のものか確かめ、残っていれば今のセッションの接続へ付け替える（後からログインし直しても、古い接続の失効で消えない）。消えていれば「オフ」と出す。
- **許可**：設定 › この端末 › 通知のボタンからだけ求める。iPhone・iPad はホーム画面に追加したアプリの中だけ。アイコンのバッジ（承認待ち＋未返信）は Badging API がある端末だけ：プッシュの `badge` と、アプリでホームを開いたとき（表示中の提供者の件数）。
- **環境変数**：`HOST_PUSH_ENABLED`（既定 `false`。`HOST_PWA_ENABLED=true` のときだけ効く）、`HOST_PUSH_VAPID_PUBLIC_KEY`、`HOST_PUSH_VAPID_PRIVATE_KEY`（Secret Manager だけ。リポ・`.env`・ログに書かない）、`HOST_PUSH_VAPID_SUBJECT`（`mailto:` か `https:`）。http mode で有効にして鍵・subject が欠ける・形が違う・対にならないと起動しない。mock は開発用の公開鍵（秘密鍵は捨ててある）で、送らない。どの workflow もまだ有効にしていない。
- **鍵の作り方**（root で 1 回。秘密鍵は Secret Manager へ直接入れ、端末に残さない）：

  ```sh
  node --input-type=module -e "import { generateVapidKeys } from './packages/web-push/src/index.ts'; console.log(JSON.stringify(generateVapidKeys()))"
  ```

- 鍵を替えると既存の購読は使えなくなる。設定を開くと鍵の違う購読はオフと表示して再登録を案内し、「この端末で通知を受け取る」で作り直す。解除時にブラウザとサーバーの両方が失敗した場合はオン表示を維持して再試行を案内する。

## 切り替えと戻し方

- `HOST_PWA_ENABLED`（既定 `false`。`HOST_CONSOLE_ENABLED=true` のときだけ効く）。mock のプレビュー（`deploy-preview.yml`）と stg（`deploy-host-staging.yml`）は `true`、本番は未設定。
- 戻すときは `HOST_PWA_ENABLED=false` にする。manifest は 404 になり、`/host/sw.js` は自分を解除する worker を返す（404 にすると古い worker が残るため）。画面側の `HostPwaRegistrar` も `/host/` の登録を解除する。追加済みのアイコンは端末に残るが、開くと通常のページとして動く。
- `false` でも、アプリ表示（iOS 26 は追加したサイトを既定でアプリとして開く）で印のないセッションを更新しない仕組みと、ログアウト・セッション切れの行き先 `/host/launch` は残す。ブラウザの動きは変わらない。
- プッシュだけ止めるときは `HOST_PUSH_ENABLED=false`。BFF は 404、設定の「通知」の行は消える。端末の購読と表は残るが、通知 job の route も 404 になって送らない。止めている間に積まれた行は残り、戻したときに期限を過ぎた承認期限と 24 時間より古い連絡は送らずに閉じる。

## 既知の制約

- Android・PC の Chromium はブラウザとアプリで cookie を共有する。アプリで初めて開いたときに 1 回ログインが増え、ブラウザ側も印つきのセッションに置き換わる。古い接続は使われないまま NIHO の期限（最後の利用から 180 日）で切れる。
- 印のない複製 cookie のままアプリでログアウトすると（`HOST_PWA_ENABLED=false` のときなど、console の枠が `/host/launch` へ移す前）、共有している接続が消えてブラウザ側もログアウトになる。
- Chromium の追加の申し出（`beforeinstallprompt`）が画面の準備より先に来ると、次にページを読み込むまで設定に追加ボタンが出ない。

## 実機の受入（stg）

iPhone・iPad・Android・Mac Safari・PC Chrome のそれぞれで確かめる。

1. 追加：ブラウザでログインした状態から、設定「この端末」の案内どおりに追加できる。名前が「体験ホスト」、アイコンが緑の地の印。
2. 初回起動：`/host/launch` が開き、「NIHO でログイン」がある（複製された cookie でホームへ入らない）。
3. ログインの往復：NIHO の確認画面を通って、アプリの窓のホームへ戻る（ブラウザに取り残されない）。
4. ブラウザが生きている：アプリで 1 時間以上使い ID token が更新されたあとも、ブラウザ側のセッションがログアウトにならない。
5. ログアウト：アプリでログアウトすると `/host/launch` に戻る。
6. オフライン：機内モードでページを移ると、オフラインの案内が出て、通信が戻れば再読み込みで戻る。
7. 通知（P2・stg で `HOST_PUSH_ENABLED=true` にしてから）：設定 › この端末 › 通知で許可→「テスト通知を送る」がロック画面に届き、タップでアプリの設定が開く。iPhone ではブラウザのタブに「ホーム画面に追加したアプリから」と出る。別の端末でログアウトすると、その端末の設定を開き直したとき「オフ」になる。
