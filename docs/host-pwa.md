# ホストの画面をアプリとして使う（PWA）

[#177](https://github.com/niho-life/niho-experience/issues/177)。P1 で、ホストが `/host/` をスマホのホーム画面・Mac の Dock・PC のアプリとして追加し、アプリの窓で使えるようにした。P2 で、その端末へのプッシュ通知（Web Push）を足す（[プッシュ通知](#プッシュ通知p2)）。P3 で、iOS 18.4+ / Safari の Declarative Web Push と、Android の共有シートからの写真の受け取りを足す（[Declarative Web Push](#declarative-web-pushp3)・[共有された写真](#共有された写真p3)）。

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
| `share_target`（P3） | `POST /host/share-target`・`multipart/form-data`・画像（`image/jpeg`・`image/png`）の `photos` だけ。title・text・url は受けない。Android（WebAPK）の共有シートに「体験ホスト」が出る。iOS・PC は対象外 |
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
- P3：共有シートからの写真を受ける（[共有された写真](#共有された写真p3)）。`POST /host/share-target` のページ遷移だけを答え、ほかの POST には介入しない。写真は worker のメモリにだけ置く（Cache Storage も IndexedDB も使わない）。
- P2：`push` を通知として出し（読めない内容や `/host/` 外を開く内容は、ホームを開く「お知らせがあります」に置き換える。通知を出さない push が続くと iOS・Chrome が購読を取り消すため）、タップで開いているアプリの窓をそのページへ移す（無ければ開く）。`pushsubscriptionchange` では同じ鍵で購読し直して BFF へ登録し、古い endpoint を消す。

## プッシュ通知（P2）

メールに足す経路で、置き換えない。届く種類は設定 › 通知の 8 種と ON/OFF に従う（経路別の切替は作らない）。このサイトが送るホストへのメール（#194、`EXPERIENCE_HOST_MAIL_ENABLED`）は、このサイトの予約の確定・取消と OTA の予約の新規・取消・日時変更を、push と同じ人へ同じ中身で送る（宛先は設定 › 通知 › 宛先。[guest-booking.md](guest-booking.md) の「ホストへのメール」）。push の行とは別の topic（`host.mail.*`）で、メール job が送る。

- **通知 job（outbox の消費。オーナー決定 2026-10-31）**：Experience-owned の予約・質問・開催・レビューイベントは transaction 内で Experience DB の `outbox_messages` に積み、既存 host push job が消費する。`host.notify.new_review` は公開レビューの保存 transaction が review UUID と体験名だけを積み、OWNER の `/host/reviews` を開く（#104/#108）。`host.notify.day_before_summary` は既存設定が約束する毎日18:00 JST以降、翌日の Experience 内 `CONFIRMED` booking 件数と参加人数だけを provider/date 単位で一度積み、`DAY_BEFORE_SUMMARY` の設定と `/host/bookings` を使う（#109/#376）。OTA の予約・外部チャネル・氏名はこの summary の対象に含めない。Scheduler と専用 service account の配備・受入は別途必要。
  - 主な topic は `packages/experience-store/src/host-notification-outbox.ts` に列挙する。`host.notify.guest_question` は予約前の質問・答え 1 件ごと、`host.notify.new_booking` はこのサイトの予約確定ごと、`host.notify.guest_message` / `host.notify.booking_message` は予約者からの連絡ごと、`host.notify.cancellation` は予約者かサポートが予約を取り消したとき、`host.notify.google_calendar_attention` はGoogle予定を読めず新規受付を止めたとき、`host.notify.ota_booking` はOTA台帳の新規・取消・日時変更 revision ごと、`host.notify.new_review` は投稿ごと、`host.notify.day_before_summary` は翌日の開催まとめ、`host.notify.listing_suspension` は運営停止と解除の状態変更ごとを積む。payload には通知に必要な範囲だけを入れ、レビュー本文や集合案内、通常の予約者連絡本文は含めない。
  - 承認期限の通知（旧 `host.notify.approval_deadline`、`APPROVAL_DEADLINE`）は #109 で廃止した：ここの予約は支払いで確定し、ホストが承認する流れが無い（producer を呼ぶ処理は無かった）。設定 › 通知の行も無い。
  - 掲載の運営停止・解除（#109・#369。廃止した旧事前審査の結果通知 `LISTING_REVIEW` の置き換え）：`host.notify.listing_suspension`。`suspendByOperations`（まだ止まっていない掲載を止めたときだけ）と `clearOperationsSuspension` が、状態を変えた同じ transaction で新しい状態の版ごとに 1 行積む（競合・失敗なら状態ごと積まれない）。ホスト自身の停止・公開・再開では積まない。payload は `{ v: 1, productId, experienceTitle, change: "SUSPENDED" | "CLEARED" }` だけで、理由コード・操作した事務局の ID・原稿は入れない。体験名は現在の公開版の題（無ければ下書きの題、読めなければ「体験」）。種類は `LISTING_SUSPENSION`（止められない）。宛先はその提供者の OWNER の端末だけ（`ownerRecipients`。再公開できるのは OWNER だけで、タップ先の画面は商品限定の運営者を断るため、運営者には送らない）。題は「運営が掲載を停止しました」／「運営による停止が解除されました」で、解除は本文に「オーナーが再公開すると、掲載に戻ります」を足す（解除後も `owner_resume_required` が残り、OWNER の再公開で掲載に戻る）。タップで `/host/experiences/{productId}?providerId=…`（体験の編集）、tag は商品ごとに 1 つ（解除が停止を置き換える）。24 時間より古い行は送らずに閉じる。メールは送らない。
  - OTA の予約（#194）：`host.notify.ota_booking`。台帳が新規・取消・日時変更を 1 revision に 1 行積む。payload は出どころの site・`host_ref`・商品・体験名・日時（変更は前の日時も）・人数と、予約者の名前（送ったら job が消す）。連絡先・金額・外部 ID は無い。種類は新規と日時変更が `NEW_BOOKING`、取消が `CANCELLATION`（どちらも止められない）。宛先はその商品の OWNER と運営者の端末だけ。題は「{OTA} で新しい予約」など、タップで `/host/bookings?ota=…&providerId=…`（その予約の詳細が開く）、tag は `ota-{host_ref}`。詳細は [ota-external-reservations.md](ota-external-reservations.md) の「ホストへの通知（#194）」。
  - 取り出しは `available_at` を lease に使う（`FOR UPDATE SKIP LOCKED` で取り、60 秒先へずらす。終わらなければ戻ってくる）。1 回の実行で最大 50 行を、送る直前に 1 行ずつ取り出す（まとめて取ると、遅い送信の間に後ろの行の lease が切れて別の実行が二重に送る）。完了・再試行は取り出したときの `attempts` と一致する行だけを更新し、lease 切れのあと別の実行が取り直した行には効かない。送れたら `processed_at`。24 時間より古い連絡・質問・新しい予約・形の違う行は送らずに閉じる。購読の読み出しが失敗したら 1・5・15・60 分後に再試行し、5 回で諦める。端末ごとの失敗は従来どおり購読の側に記録する。
  - 届く種類は設定 › 通知に従う。新しい予約・取消・掲載の運営停止は止められない。予約者からの連絡は止められる種類で、送る前に体験 DB の設定（#109、`ProviderNotificationSettings.enabledFor`。行が無ければオン）を読む。`HOST_NOTIFICATION_SETTINGS_ENABLED=false` で設定を読めない間は送らない側に倒す。設定の読み出しが失敗したら購読の読み出しと同じく再試行する。
  - タップ先は `/host/messages?booking=…&providerId=…`（連絡）、`/host/messages?thread=…&providerId=…`（質問）、`/host/bookings?booking=…&providerId=…`（このサイトの新しい予約）、`/host/experiences/{productId}?providerId=…`（掲載の運営停止・解除）。
  - 起動は `POST /internal/host-push/v1/drain`。Cloud Scheduler（毎分）が専用 service account の Google ID token で呼ぶ（`HOST_PUSH_JOB_AUDIENCE`・`HOST_PUSH_JOB_SERVICE_ACCOUNT_EMAIL`）。未設定・`HOST_PUSH_ENABLED=false` なら 404。応答は件数だけ。環境変数は配備 workflow の機能のフラグ（`STG_HOST_PUSH_ENABLED`／`PROD_HOST_PUSH_ENABLED`、[production-deploy.md](production-deploy.md#機能のフラグ84)）が入れる（audience はサイトの URL、service account は `experience-host-push@<project>`）。Scheduler と service account はまだ作っていない。
- **ロック画面に出すもの**：通知の種類・体験名・日時（JST）・人数だけ。`HostPushEvent` 型にメッセージ本文・金額の欄が無い（`lib/host/push/payload.ts`）。予約者の名前は OTA の予約（`ota` のある event、#194、オーナー決定 2026-11-01）だけに付き、題に OTA の名前が入る。本文は `{ v: 1, title, body, url, tag, badge? }` の JSON で 3 KB まで。`url` は `/host/` 配下のパスだけ。push service へ渡す `Topic` は tag の digest。
- **暗号と認証**：`packages/web-push`（`node:crypto` だけ）。RFC 8291 `aes128gcm`（RFC の例とバイト単位で一致することをテストで確かめる）と RFC 8292 VAPID（ES256・12 時間）。緊急度は新しい予約・連絡・取消・Google カレンダーの注意が `high`、ほかは `normal`。TTL は前日のまとめ 12 時間・ほか 24 時間。
- **endpoint の許可リスト（SSRF 防止）**：https・既定のポート・認証情報なし・ブラウザが直列化した形で、host が `fcm.googleapis.com`・`updates.push.services.mozilla.com`・`web.push.apple.com`・`*.push.apple.com`・`*.notify.windows.com` のどれか、2048 文字まで。ほかは送る前に拒否する。redirect はたどらない。endpoint はログ・URL・エラー文に出さない。
- **購読**：体験 DB の `host_push_subscriptions`（`packages/experience-store/migrations/0004_host_push_subscriptions.sql`）。NIHO user・接続・endpoint（一意。最後に購読した人の端末になる）・鍵・端末種別（User-Agent からの粗い区分）・`last_seen_at`・失敗回数。BFF は `/host/api/push-subscriptions`（登録 POST・解除 DELETE）・`/status`・`/test`（本人の端末だけ・30 秒に 1 回）。同一 origin とセッション cookie で確かめ、NIHO は呼ばない。DB 未設定は 503。mock は検証だけして保存も送信もしない。
- **消す・送らない条件**：ログアウトと、NIHO が接続を終えた refresh（`rejected`）でその接続の購読を消す（成功した refresh は `last_seen_at` を進める。どちらも認証の流れを止めない）。30 日見ていない端末には送らない。push service が 404/410 を返したら消す。設定を開くたびに、端末の購読がまだ本人のものか確かめ、残っていれば今のセッションの接続へ付け替える（後からログインし直しても、古い接続の失効で消えない）。消えていれば「オフ」と出す。
- **許可**：設定 › この端末 › 通知のボタンからだけ求める。iPhone・iPad はホーム画面に追加したアプリの中だけ。アイコンのバッジ（承認待ち＋未返信）は Badging API がある端末だけ：プッシュの `badge` と、アプリでホームを開いたとき（表示中の提供者の件数）。
- **環境変数**：`HOST_PUSH_ENABLED`（既定 `false`。`HOST_PWA_ENABLED=true` のときだけ効く）、`HOST_PUSH_VAPID_PUBLIC_KEY`、`HOST_PUSH_VAPID_PRIVATE_KEY`（Secret Manager だけ。リポ・`.env`・ログに書かない）、`HOST_PUSH_VAPID_SUBJECT`（`mailto:` か `https:`）。http mode で有効にして鍵・subject が欠ける・形が違う・対にならないと起動しない。mock は開発用の公開鍵（秘密鍵は捨ててある）で、送らない。stg・本番の workflow は、上の機能のフラグで既定 OFF のまま渡せる（まだどの環境でも有効にしていない）。
- **鍵の作り方**（root で 1 回。秘密鍵は Secret Manager へ直接入れ、端末に残さない）：

  ```sh
  node --input-type=module -e "import { generateVapidKeys } from './packages/web-push/src/index.ts'; console.log(JSON.stringify(generateVapidKeys()))"
  ```

- 鍵を替えると既存の購読は使えなくなる。設定を開くと鍵の違う購読はオフと表示して再登録を案内し、「この端末で通知を受け取る」で作り直す。解除時にブラウザとサーバーの両方が失敗した場合はオン表示を維持して再試行を案内する。

## Declarative Web Push（P3）

送る JSON は、これまでの `{ v: 1, title, body, url, tag, badge? }` に、[W3C Push API §3.3](https://www.w3.org/TR/push-api/) の宣言的な形を足した 1 つのまま（`lib/host/push/payload.ts`）。

```json
{
  "v": 1, "title": "...", "body": "...", "url": "/host/bookings?...", "tag": "...", "badge": 2,
  "web_push": 8030, "mutable": true,
  "notification": { "title": "...", "body": "...", "navigate": "https://<site>/host/bookings?...", "tag": "...", "lang": "ja", "dir": "ltr", "data": { "url": "https://<site>/host/bookings?...", "badge": 2 }, "icon": "https://<site>/host-app/icon-192.png", "app_badge": "2" }
}
```

- **対応するブラウザ（iOS 18.4+ の Safari・ホーム画面のアプリ）**は `web_push: 8030` を見て、worker を起こさずに自分で通知を出す。worker が止まっていても通知が出るので、「通知を出さない push が続くと購読が取り消される」心配が減る。
- **対応しないブラウザ（Chrome・Firefox・古い Safari）**は従来どおり worker の `push` が `v`〜`badge` を読む。余分なキーは無視される。
- `mutable: true` で worker の `push` event も呼ばれる（アプリのバッジ・開いている画面の更新を worker が行うため）。**この event には `event.data` が無く（null）、ブラウザが用意した通知が `event.notification` で渡る**（[Push API の push message の受信](https://www.w3.org/TR/push-api/#receiving-a-push-message)）。ブラウザは、worker が `showNotification()` を呼ばなかったときに、用意した通知を出す。そのため worker は**通知を出さない**（出すと、本物の通知の代わりに汎用の通知が出てしまう。#426 のレビューで指摘された）。worker は `event.notification.data.badge` でアプリのバッジを付け（0 は消す）、開いている画面に更新を伝えるだけ。タップ先は `event.notification.data.url`（`notificationclick` が従来どおり読む）。
- `event.notification` が無い通知（Chrome・Firefox・宣言的でない Safari）は、従来どおり `event.data` の `v`〜`badge` を読んで worker が通知を出す。
- `navigate` は `/host/` 配下だけ（`hostPushUrl` が今までどおり検査する）。サイトの origin が分かるとき（本番の job・テスト通知）は絶対 URL、分からないときは path（ブラウザが購読の scope で解く）。`icon` も同じ。
- `app_badge` は WebKit の例どおり**文字列**で、0 のときは付けない（0 で消すのは worker の `clearAppBadge`）。W3C の草案には無いメンバーで、対応しないブラウザは無視する。
- ロック画面に出す内容は変わらない（種類・体験名・日時・人数。OTA の予約だけ予約者の名前）。本文は 3 KB 以内を今までどおり検査する。
- **実機は未確認。** iOS 18.4+ の実機で、(1) 宣言的な通知が 1 つだけ出る（汎用の「お知らせがあります」に置き換わらず、本文・タップ先が正しい）、(2) worker が止まっていても出る、(3) タップで `navigate` が開く、(4) `app_badge` が付く、を確かめる（[実機の受入](#実機の受入stg) 8）。余分なキーを拒む実装だった場合も、従来の worker 経路にそのまま戻るだけで、通知は出る。

## 共有された写真（P3）

Android の共有シート（ギャラリー・カメラ・Google フォトなど）で写真を選び、共有先に「体験ホスト」を選ぶと、その写真を体験の写真の入力へ渡せる。

1. 共有シートがマニフェストの `share_target`（`POST /host/share-target`）へ写真を送る。
2. `/host/sw.js` がそのページ遷移を答える。**最初の使える画像 1 枚**（JPEG か PNG・10 MB 以下。体験の写真の入力と同じ条件）を自分のメモリに置き、`/host/experiences?shared=photo` へ 303 で送る。使える画像が無ければ `?shared=none`。
3. 移った先で `HostSharedPhotoReceiver`（ホストの root layout）が worker に **1 回だけ**写真を求め（`MessageChannel`。worker は渡した時点で忘れる）、URL から `shared` を消し、ページのメモリ（`lib/host/shared-photo.ts`）に置く。
4. コンソールの上に「共有された写真「…」を受け取りました」が出る（`HostSharedPhotoNotice`。受け取れなかったときは「受け取れませんでした。もう一度共有してください」）。体験の編集画面の写真の入力の上に「この写真を使う」が出て（`HostSharedPhotoOffer`）、押すとその写真が選ばれた状態になる。
5. **写真の説明（英語・日本語）と権利の確認、アップロードの操作は、通常の写真と同じ。** 共有しただけで写真が保存されたり公開されたりすることはない。

- **端末にもサーバーにも保存しない。** worker のメモリ（最長 5 分）とページのメモリ（最長 30 分）だけ。URL・Cache Storage・IndexedDB・localStorage・サーバーのどこにも置かない。`/host/share-target` の route は、worker が答えなかったときの受け皿で、アップロードを読まず `?shared=none` へ 303 を返すだけ。
- 保持中の写真はアプリの「裏から戻ると読み込み直す」動き（`HostResumeRefresh`）の対象外（未保存の編集と同じ扱い）。ページを読み込み直すか、worker が止まっていた場合は写真が消えるので、もう一度共有してもらう。
- 管理画面（`/admin`）の商品編集には出ない（root layout の受け取りがホストの画面だけにある）。
- `HOST_PWA_ENABLED=false` では、マニフェストと `/host/share-target` は 404、worker は自分を解除する。

## 切り替えと戻し方

- `HOST_PWA_ENABLED`（既定 `false`。`HOST_CONSOLE_ENABLED=true` のときだけ効く）。mock のプレビュー（`deploy-preview.yml`）と stg（`deploy-host-staging.yml`）は `true`、本番は未設定。
- 戻すときは `HOST_PWA_ENABLED=false` にする。manifest は 404 になり、`/host/sw.js` は自分を解除する worker を返す（404 にすると古い worker が残るため）。画面側の `HostPwaRegistrar` も `/host/` の登録を解除する。追加済みのアイコンは端末に残るが、開くと通常のページとして動く。
- `false` でも、アプリ表示（iOS 26 は追加したサイトを既定でアプリとして開く）で印のないセッションを更新しない仕組みと、ログアウト・セッション切れの行き先 `/host/launch` は残す。ブラウザの動きは変わらない。
- プッシュだけ止めるときは `HOST_PUSH_ENABLED=false`。BFF は 404、設定の「通知」の行は消える。端末の購読と表は残るが、通知 job の route も 404 になって送らない。止めている間に積まれた行は残り、戻したときに 24 時間より古い連絡は送らずに閉じる。

## 既知の制約

- Android・PC の Chromium はブラウザとアプリで cookie を共有する。アプリで初めて開いたときに 1 回ログインが増え、ブラウザ側も印つきのセッションに置き換わる。古い接続は使われないまま NIHO の期限（最後の利用から 180 日）で切れる。
- 印のない複製 cookie のままアプリでログアウトすると（`HOST_PWA_ENABLED=false` のときなど、console の枠が `/host/launch` へ移す前）、共有している接続が消えてブラウザ側もログアウトになる。
- 共有シートから写真を受け取れるのは Android（インストール済みの PWA）だけ。iOS・PC の Safari は `share_target` に対応しない。
- 共有された写真は worker のメモリに置くため、共有から 5 分以上たつ・worker が止まる・ページを読み込み直すと消える。そのときはもう一度共有する。ログインが切れていると `/host/experiences` からログインに移るので、ログインしてから共有する。
- Chromium の追加の申し出（`beforeinstallprompt`）が画面の準備より先に来ると、次にページを読み込むまで設定に追加ボタンが出ない。

## 実機の受入（stg）

iPhone・iPad・Android・Mac Safari・PC Chrome のそれぞれで確かめる。

1. 追加：ブラウザでログインした状態から、設定「この端末」の案内どおりに追加できる。名前が「体験ホスト」、アイコンが緑の地の印。
2. 初回起動：`/host/launch` が開き、「NIHO でログイン」がある（複製された cookie でホームへ入らない）。
3. ログインの往復：NIHO の確認画面を通って、アプリの窓のホームへ戻る（ブラウザに取り残されない）。
4. ブラウザが生きている：アプリで 1 時間以上使いNIHO Web access tokenが更新されたあとも、ブラウザ側のセッションがログアウトにならない。
5. ログアウト：アプリでログアウトすると `/host/launch` に戻る。
6. オフライン：機内モードでページを移ると、オフラインの案内が出て、通信が戻れば再読み込みで戻る。
7. 通知（P2・stg で `HOST_PUSH_ENABLED=true` にしてから）：設定 › この端末 › 通知で許可→「テスト通知を送る」がロック画面に届き、タップでアプリの設定が開く。iPhone ではブラウザのタブに「ホーム画面に追加したアプリから」と出る。別の端末でログアウトすると、その端末の設定を開き直したとき「オフ」になる。
8. Declarative Web Push（P3・iPhone / iPad の iOS 18.4+ と macOS の Safari）：「テスト通知を送る」と、実際の通知（新しい予約など）で、(1) 通知が 1 つだけ出る（2 つ並ばない）、(2) アプリを完全に終了してからでも出る、(3) タップでその予約・スレッドが開く、(4) アイコンのバッジが付く、を確かめる。Chrome（Android・PC）では従来どおり 1 つだけ出る。
9. 共有された写真（P3・Android の Chrome でインストールしたアプリ）：ギャラリーで写真を選んで共有→「体験ホスト」を選ぶ。(1) アプリが開き 体験 に「共有された写真「…」を受け取りました」が出る、(2) ホームなどへ移っても残る、(3) 体験の編集画面で「この写真を使う」を押すと写真の入力が選ばれた状態になり、説明と権利の確認の入力は通常どおり、(4) 「この写真を使わない」で消える、(5) PDF など画像以外を共有すると「受け取れませんでした」が出る、(6) アプリを入れた直後（worker がまだ無い）に共有しても「受け取れませんでした」になり、もう一度共有すれば受け取れる。
