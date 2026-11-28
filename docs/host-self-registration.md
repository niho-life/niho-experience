# 自分でホスト登録する（Epic #700、段階 2b＝#708）

NIHO アカウントを持つ人が、事務局を通さずにホストとして登録する流れの、画面と入口です。登録の store（provider・公開名・OWNER・規約の同意・連絡用アドレス）は段階 2a（#707）。用語は [用語集](glossary.md)、モックは `idea/mock/host-self-registration-v2/index.html`。

`EXPERIENCE_HOST_SELF_REGISTRATION_ENABLED`（既定 `false`、配備変数 `HOST_SELF_REGISTRATION_ENABLED`）が `true` のときだけ動く。OFF のあいだは、`/host/start`・`/host/terms`・`/host/api/registration` は 404、`/host/auth/login?intent=register` の `intent` は無視され、ふつうのログイン、未登録の案内も今のまま。http では `HOST_CONSOLE_ENABLED`・`EXPERIENCE_HOST_ACCOUNTS_ENABLED`・`EXPERIENCE_HOST_NIHO_LOGIN_ENABLED`・`EXPERIENCE_HOST_MAIL_ENABLED`・DB（migration 0093）が必須。プレビュー（mock）は NIHO ログインだけで動き、何も保存しない。**ホームの入口（`/host`、`/ja/host`）の切り替えは段階 5（#712）。この段階では変えない。**

## 流れ

```
/host/auth/login?intent=register ──▶ NIHO（本人確認だけ）──▶ /host/auth/callback
     ├ NIHO アカウントに結び付いた hst_ がある ──▶ ふつうのサインイン → /host/home（今と同じ）
     └ 無い（flag ON なら、ふつうのログインでも）──▶ 登録 cookie を置いて /host/start（DB には何も作らない）

/host/start（サーバーで状態を決める）
     ├ 有効な登録 cookie ──▶ フォーム（NIHO の表示名を、個人のときの掲載名の初期値に）
     ├ cookie なし・ホストのセッションあり・どのホストのオーナーでもない（ライター・メンバー）──▶ 同じフォーム（アカウントにホストを足す）
     ├ すでにどこかのオーナー ──▶ /host/home（2 つ目を足すのは段階 2c）
     └ どちらでもない ──▶ /host/auth/login?intent=register

POST /host/api/registration ──▶ registerHostSelf（cookie）／registerHostSelfForAccount（セッション）──▶ /host/home?providerId=…
```

## 登録 cookie

| 項目 | 値 |
| --- | --- |
| 名前 | `__Secure-niho_host_registration` |
| 中身 | NIHO user ID・NIHO でログインした時刻（`authTime`）・NIHO の表示名（80 文字まで。無ければ入れない）・期限（暗号化。`cookie-seal.ts`、用途 `host-registration`。トークン・メールは入らない） |
| 期限 | 30 分 |
| 属性 | HttpOnly・Secure・SameSite=Lax・`Path=/host`（`/host/start` と `/host/api/registration` が読む。ブラウザの JavaScript には渡さない） |
| 消えるとき | 登録できたとき、すでに登録済みと分かったとき |

NIHO の表示名は、app-connect の exchange が返すもの。新しい本人確認の方式（`EXPERIENCE_NIHO_IDENTITY_LOGIN_ENABLED`）の ID トークンには名前が無いので、そのときは空欄から（NIHO に `profile` を足してもらってから）。表示名はサーバーの中だけで扱い、ログ・計測には出さない。NIHO のプロフィール写真（`iconUrl`）は、この段階では使わない（登録の時点ではホストが無く、写真を保存できない。登録後の「ロゴ・写真」で扱う）。

## 登録 API

`POST /host/api/registration`（同一 origin のみ・JSON・4 KiB まで・`private, no-store`）

入力：`{ providerKind: "PERSON"|"BUSINESS", publicDisplayName, publicDisplayNameEn: string|null, notificationEmail, hostTermsVersion, termsAccepted: true }`（この 6 つだけ）。誰が登録するかは、body ではなく cookie から決める。

成功：`200 { ok: true, redirect }`（新しいホストのホーム）。cookie の登録では、既存のサインインと同じやり方でセッション cookie を置き、前のセッションを終える。

失敗：`{ error: { code, field?, limit? } }`

| code | status | 意味 |
| --- | --- | --- |
| `PUBLIC_NAME_INVALID` | 422 | 掲載名が空・100 文字超・制御文字など（`field`: `name`／`nameEn`） |
| `PUBLIC_NAME_RESERVED` | 422 | NIHO・事務局を名乗る名前 |
| `EMAIL_INVALID` | 422 | メールの形 |
| `TERMS_REQUIRED` | 422 | 規約に同意していない |
| `OWNER_LIMIT_REACHED` | 409 | 3 つまで（`limit`） |
| `ACCOUNT_SUSPENDED` | 403 | アカウントの停止 |
| `ALREADY_REGISTERED` | 409 | すでに結び付いている（cookie を消す。ふつうにログインへ）。すでにオーナーの人のセッションにも同じ |
| `REGISTRATION_EXPIRED` | 401 | cookie が無い・期限切れ・改ざん。かつセッションも無い |
| `RATE_LIMITED` | 429 | 確認のメールの回数（1 時間 5 通）。`retry-after` つき |
| `FORBIDDEN` | 403 | 同一 origin でない |
| `INVALID_INPUT` | 400／409／413／415／422 | 形が違う、規約の版が古い など |
| `UNAVAILABLE` | 503 | store に届かない |

失敗しても入力は画面に残る。

## ホスト規約

`apps/web/src/lib/host/host-terms.ts` の `HOST_TERMS_VERSION`（いまは `2026-11-28`）と、`/host/terms`（flag OFF なら 404）。内容は、公開前の審査が無いこと・事後に止められること、掲載内容の正確さと権利はホストの責任、手数料は予約の受付を始めるときに選ぶプラン、個人情報の扱い、禁止事項。

**文言は法務の確認待ちの下書き。自分での登録を開く（段階 5）前に確定し、版を上げる。** ページにも同じ注記を出している。

## 連絡用アドレスの確認とページの公開（`NOTIFICATION_ADDRESS_REQUIRED`）

ホストにオーナーがいて、そのオーナーの誰にも、ホスト宛てのメールが届く宛先が無いあいだは、ページを公開できない（`publishPage`・`openBooking`・従来の `publish` のどれでも）。登録で入れたアドレスは、確認のメールのリンクを開くまで宛先に数えない。判定は `packages/experience-store/src/host-mail-shared.ts` の `HOST_MAIL_DESTINATION_READY`（メールの宛先を決める SQL と同じ条件）を 1 か所に置き、メールの受け手の選定と `ownerMailDestinationMissing`（この検査）の両方が読む。全ホストに「次のページ公開の操作から」適用する（オーナーが 1 人もいないホスト、つまり事務局が代理で登録して NIHO が販売者になるものには、通知する相手がいないので適用しない）。いま公開中のページは止めない。ホーム「公開までの道のり」には、この理由が残っているときだけ「連絡用メールアドレスの確認」の行が出て、設定 › 通知へ行く。

## 入口の案内

flag ON のとき、`/host/auth/error` の「このアカウントは、ホストに登録されていません」と、ホストに属していないアカウントの案内（`HostNoHostGuide`）に「ホストとして登録」が出る。

## ローカルで画面を見る（プレビュー）

`EXPERIENCE_API_MODE=mock`（既定）で、`HOST_CONSOLE_ENABLED=true`・`EXPERIENCE_HOST_NIHO_LOGIN_ENABLED=true`・`EXPERIENCE_HOST_SELF_REGISTRATION_ENABLED=true` を付けて起動し、`/host/auth/mock-login?mock=unregistered`（または `/host/auth/login?intent=register`）を開くと、合成の NIHO アカウント（表示名「森 ゆき」）で `/host/start` に着く。登録を押すと、何も保存せず、合成のホストのホームへ進む。
