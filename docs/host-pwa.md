# ホストの画面をアプリとして使う（PWA）

[#177](https://github.com/niho-life/niho-experience/issues/177) の P1。ホストが `/host/` をスマホのホーム画面・Mac の Dock・PC のアプリとして追加し、アプリの窓で使えるようにする。プッシュ通知は P2 で足す。

## 範囲

- 対象はホストの画面だけ（scope `/host/`）。旅行者のページ（`(site)`・`(ja)`）と英語の紹介 `/host` は範囲外で、manifest も Service Worker も出さない。
- 入口はホストの root layout（`(host)/host/layout.tsx`）だけ。`HOST_PWA_ENABLED=true` のとき manifest・apple-touch-icon・`apple-mobile-web-app-*` を出し、`HostPwaRegistrar` が `/host/sw.js` を登録する。`viewportFit: "cover"` は付けない（上端の safe area は今のまま）。
- 起動先は `/host/launch`（console の枠の外）。アプリ内で始めたログインのセッションならホームへ、それ以外はログイン画面を出す。ブラウザで開いてセッションがあればホームへ進む。
- アプリでは、ログアウト（アプリ内でログインしたセッション）と、画面が見つけたセッション切れの行き先を `/host` ではなく `/host/launch` にする（範囲の外へ出ない）。`HOST_PWA_ENABLED=true` のとき、cookie が無い・期限切れの状態で console の URL を開いた場合の転送先も `/host/launch`（ブラウザでも日本語のログイン画面になる）。1 分以上裏にいたあと戻るとページを読み込み直す（編集中は除く。予約・メッセージは一覧を画面側で持つので、`router.refresh()` ではなく全体を読み込む）。
- 設定に「この端末」を足す（「アプリ」の行。追加済み・Chromium の追加ボタン・iPhone/iPad と Mac Safari の手順）。P2 で「通知」の行を足す。

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
- プッシュは P2 で足す。

## 切り替えと戻し方

- `HOST_PWA_ENABLED`（既定 `false`。`HOST_CONSOLE_ENABLED=true` のときだけ効く）。mock のプレビュー（`deploy-preview.yml`）と stg（`deploy-host-staging.yml`）は `true`、本番は未設定。
- 戻すときは `HOST_PWA_ENABLED=false` にする。manifest は 404 になり、`/host/sw.js` は自分を解除する worker を返す（404 にすると古い worker が残るため）。画面側の `HostPwaRegistrar` も `/host/` の登録を解除する。追加済みのアイコンは端末に残るが、開くと通常のページとして動く。
- `false` でも、アプリ表示（iOS 26 は追加したサイトを既定でアプリとして開く）で印のないセッションを更新しない仕組みと、ログアウト・セッション切れの行き先 `/host/launch` は残す。ブラウザの動きは変わらない。

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
