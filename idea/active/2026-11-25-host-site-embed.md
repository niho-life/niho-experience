# NIHO Experience：ホスト自身のサイトへの埋め込み（予約ウィジェット・企画ページ）

作成：2026-11-25。状態：**仕様確定（オーナー承認 2026-11-25）。Issue [#638](https://github.com/niho-life/niho-experience/issues/638)、仕様は [docs/embed.md](../../docs/embed.md) を正とする。** 以下は検討の記録。

関連：[構成とデータ境界](../../docs/architecture.md)、[旅行者の予約](../../docs/guest-booking.md)、[ADR 0002](../../docs/adr/0002-experience-domain-ownership.md)。先行例：niho-app の公開埋め込み（`specs/initiatives/public-embeds.md`、`docs/infosec/managed-public-embed-architecture.md`）。

現状コードの確認基点：`999c8df4`（branch `codex/experience-host-contract-v1`）。

モック：[host-site-embed-v2.html](../mock/host-site-embed-v2.html)。本番の公開ページとホスト画面（mock mode）の HTML・CSS を枠に入れて見せる。旅行者の3種類の表示、Stripe への移動、完了ページ、ホストの「体験の編集」と「自分のサイトに貼る」。

- ホストの入口：モックの「体験の編集」は mock mode（合成データ用）の画面で、右列「ページ」に 1 行を足している。本番（http mode）の編集画面は別の作りなので、実装では右列「掲載」と、体験の一覧の「予約リンクをコピー」の下に置いた。画面は `/host/experiences/{id}/embed`。
- 第1段の種類は「予約ウィジェット」と「予約ボタン」。予約ボタンは既存の予約リンク（#531）を使う。
- 親ページの script が受けるメッセージは 2 つ：高さ（`niho-experience-embed-resize`）と、段を進めたときに枠の先頭へ戻す（`niho-experience-embed-top`）。
- ページ全体の埋め込みでは、パンくず・ほかの体験・ガイド記事・写真の拡大表示を出さない。

## 1. Goal

STUDIO・WordPress・Wix などで自分のサイトを持つホストが、コードを1回貼るだけで、訪問者がそのサイト上で日程を選び、決済まで進めるようにする。

- 対象：(a) 予約部分だけ（カレンダー → 人数 → 連絡先 → 決済）、(b) 企画ページ丸ごと。
- 成功基準
  - ホストの作業は「コードをコピーして貼る」だけ。ドメイン登録や鍵の設定を要求しない。
  - スマホで崩れない。高さを自動調整できない環境でも予約できる。
  - 価格・在庫・販売者・決済の正本と経路を変えない（同じ `startGuestBooking`、同じ Connect Direct charge、確定は webhook）。
  - 埋め込み先のサイトに、予約者の名前・メールアドレス・決済URLを渡さない。
  - ホストが「自分のサイト経由の予約」を見分けられる。
- 非目標
  - ホストのドメイン上での決済（完全な白ラベル）。
  - ホストのページの DOM に直接描画する JS ウィジェット。
  - 旧 NIHO 商品（NIHO API 経由の体験）の埋め込み。対象は Experience の有効な公開版だけ。
  - 旅行者アカウント、ホストごとの自由なデザイン編集。

## 2. Current system

| 領域 | 現状 | 埋め込みに必要な変更 |
| --- | --- | --- |
| 企画ページ | `/experiences/{slug}` → `SitePublicationPage`（SSR、英語のみ）。`apps/web/src/components/pages/SitePublicationPage.tsx` | ヘッダー・フッターなしの版 |
| 予約画面 | `/experiences/{slug}/book` → `SitePublicationBooking`（client）。**日付は `<select>` で、カレンダーではない** | 月表示のカレンダー、狭い幅での段階表示 |
| 残席 | `GET /api/public/experiences/{slug}/availability`。今日から 89 日、`no-store` | 変更なし |
| 申込 | `POST /api/public/experiences/{slug}/checkout`。`fromThisSite` が Origin＝このサイト、`Sec-Fetch-Site: same-origin` を要求（`apps/web/src/lib/experience/public-http.ts`） | 変更なし（下の「効く事実」1） |
| 決済 | Stripe hosted Checkout、Connect Direct charge、カードのみ。画面は `window.location.assign(checkoutUrl)`。戻り先は `/booking/return?type=instant`、取りやめは `/experiences/{slug}?checkout=cancelled` | iframe の外（最上位）で開く。戻り先の文言 |
| ヘッダー | 全ルートに `Content-Security-Policy: … frame-ancestors 'none'`、`Permissions-Policy: payment=()`（`apps/web/next.config.ts`）。**現在はどのページも iframe に入らない** | `/embed/*` だけ別の CSP |
| レイアウト | route group ごとに root layout（`(site)`・`(ja)`・`(host)`・`(admin)`） | `(embed)` を足す |
| 流入の記録 | `booking_guests.utm`（予約者の情報と一緒に 1 年で消える）。ホストの予約一覧の「申込経路」は「体験サイト」固定 | 予約に販売経路を固定で持つ |
| 言語 | 公開版の企画ページ・予約は英語のみ（checkout は `guestLanguage: "EN"` 固定、日本語は #285 第10段） | v1 は英語 |

### 効く事実

1. iframe の中のページは `experience.niho.life` のオリジンなので、残席・申込の通信は同一オリジンのまま。CORS も `fromThisSite` も変えなくてよい。ゲスト予約は cookie を使わないので、サードパーティ cookie の制限（Safari など）を受けない。
2. Stripe の hosted Checkout は iframe の中では使えない前提で作る（Stripe 自身も、iframe の入れ子を避けるよう書いている）。決済は最上位のウィンドウで開く。
3. ビルダーは貼ったコードを sandbox の iframe に入れることがある（STUDIO は `*.studioiframesandbox.com`、Wix も sandbox）。親ページに script を置けない・最上位へ遷移できない場合がある。
4. 高さが長い iframe の中では、画面中央のダイアログや `position: fixed` が見えない位置に出る。企画ページのギャラリーの拡大表示がこれに当たる。

### niho-app の埋め込みフォーム（先行例）から引き継ぐもの

- 方式は iframe と、親ページ側の短いインライン script。外部 JS ローダーも Web Component も使っていない。発行形式は「URL」と「コード」。
- ルートは `/embed/...`。アプリのヘッダーを付けず、背景を塗らない。
- 高さは子が `postMessage`（`niho-embed-resize`）で送り、親の script が `event.origin` と `event.source` を確かめて iframe の高さを変える。子は `.niho-form` の下端を測る（`scrollHeight` は縮まないので使わない）。
- 決済は hosted Checkout だけ。iframe の中では開かず、同じタブで最上位を遷移する。予備に `target="_top"` のリンク。支払い後は NIHO の単独ページに戻り、ホストのサイトには戻らない。呼び出し側が指定する戻り先 URL は受けない。
- **token なしの企画ページ・予定表の埋め込みは `frame-ancestors https:`**（どのサイトにも貼れる）。署名 token・許可ドメイン・短命 session は、貸切・ドロップイン・問い合わせのフォームに使っている。
- 記録されている罠：STUDIO の Embed は高さ `auto`、sandbox の中では `location.assign()` が失敗するので `href` に代入、入力欄は 16px（自動ズーム防止）、エラーはボタンのそばに出す。

### niho-app と変える点

- niho-app は決済 URL を `postMessage` で親ページへ渡し、親の script が遷移する。Experience は「予約者のアドレスをホストに出さない」方針で、Stripe の画面にはメールアドレスを事前入力している。決済 URL を知ったページはその画面を開けるので、**決済 URL は親ページへ渡さず、iframe の中のリンク・ボタンから直接遷移する**。sandbox で塞がれる環境だけ、新しいタブで開く。
- Experience の申込は同一オリジンで完結し、公開サイトで誰でもできる操作なので、署名 token と短命 session は v1 では持たない（niho-app の企画ページ埋め込みと同じ扱い）。

## 3. User journey

### 旅行者（予約ウィジェット）

1. ホストのサイトを見る。ページの中にカレンダーが出ている。
2. 日付を押す → その日の開始時刻と残席が出る → 人数を選ぶ → 合計が出る。
3. 名前・メールアドレス・（あれば）ホストの質問に答え、条件に同意する。
4. 「Continue to secure checkout」→ 席を 35 分仮押さえ → 「Pay securely on Stripe」のボタン（仮押さえの期限つき）。
5. ボタンを押すと、ページ全体が Stripe の決済画面に移る。
6. 支払うと `experience.niho.life` の完了ページ。確認メールが届く。以降（予約ページ・メッセージ・取消）は今までと同じ。

4 を 2 段にする理由：決済画面への遷移を「利用者が直接押した操作」にすると、ブラウザの遷移・ポップアップの制限に掛からない。申込の通信のあとで自動的に遷移する作りは、sandbox や Safari で止められる。

### ホスト

1. `/host/experiences/{id}` の「自分のサイトに貼る」を開く（公開中の体験だけ。未公開・停止中は「公開すると使えます」）。
2. 種類を選ぶ：予約ウィジェット／ページ全体／予約ボタン。その場で実物のプレビューが出る。
3. 「コードをコピー」→ 自分のサイトに貼る。STUDIO・WordPress・Wix の貼り方を 3 行ずつ添える。
4. 予約が入ると、通知と予約一覧の申込経路に「自分のサイト（埋め込み）」。

### 失敗・例外

| 場合 | 表示 |
| --- | --- |
| 体験が停止・未公開、予約の flag が OFF、障害時の停止 | 枠の中に「Online booking is not available right now」。iframe の中で 404 を出さない |
| 89 日以内に予約できる日が無い | 「No dates available yet」。カレンダーは出す |
| 残席の読み込み失敗 | その場に「Try again」 |
| 押した日が満席になった・価格や質問が変わった | ボタンのそばに理由と、選び直し・読み直し |
| 仮押さえが切れた | 「Your hold has expired」→ 日付の選択へ戻る |
| 最上位への遷移が塞がれた（sandbox） | 同じボタンで新しいタブに開く。それも塞がれたら、単独の予約ページへのリンク |
| JavaScript が無い | `<noscript>` で体験ページへのリンク |
| 親ページに script が無い（URL だけで貼った） | 高さは固定のまま動く。ウィジェットは固定の高さに収まる段階表示にする |

## 4. Options

| 案 | 内容 | 良い点 | 悪い点 |
| --- | --- | --- | --- |
| A. iframe＋専用 `/embed` ルート | niho-app と同じ形。予約の通信は同一オリジンのまま | 決済・在庫・個人情報の境界を変えない。ホストのサイトの CSS と干渉しない。先行例と罠の記録がある | 高さの調整に親側の script が要る。決済で一度ホストのサイトを離れる |
| B. script でホストのページに直接描画 | Web Component などで DOM に描く。API を CORS で開ける | 見た目がサイトに馴染む。高さの問題が無い | 公開 API を他オリジンへ開ける（`fromThisSite` を外す）。予約者の入力がホストのページの JS から読める。ビルダーの sandbox では動かないことが多い |
| C. ボタン・リンクだけ | 「Book now」を押すと `experience.niho.life` の予約ページへ | どのサイト・SNS でも動く。実装が小さい | カレンダーが自分のサイトに出ない |
| D. ウィジェットの中で決済まで | A に Stripe の埋め込み決済を足す | ホストのサイトを離れない | Stripe は iframe の入れ子を避けるよう書いている。CSP・公開鍵・Session の作り方・戻り方をすべて変える。受入済みの決済経路が 2 本になる |

## 5. Recommendation

**A を採り、C を同じ発行画面で一緒に出す。D は後回し。B は採らない。**

- 予約の正本・決済・個人情報の境界を一切変えずに済むのは A だけ。niho-app で STUDIO の実運用まで通っている形なので、罠が分かっている。
- C は A が動かないサイト（script も iframe も貼れない無料プランなど）と SNS のための受け皿で、ほぼ追加実装が要らない。
- D は「離れずに決済」の体験は良いが、決済経路を 2 本にする費用が大きい。埋め込みの利用が出てから判断する。

### 段階

| 段 | 出すもの |
| --- | --- |
| 1 | 予約ウィジェット（カレンダー・人数・連絡先・Stripe へ）、予約ボタン、ホストの発行画面、申込経路の記録 |
| 2 | 企画ページ丸ごと（高さの自動調整つき。ギャラリーの拡大表示は埋め込み用に作り替える） |
| 3 | 見た目（背景透明・ボタン色）、日本語（#285 第10段のあと）、必要ならウィジェット内決済 |

予約ウィジェットを先にする理由：ホストは自分のサイトに紹介文と写真を既に持っている。丸ごとの埋め込みは高さ・拡大表示・検索流入（iframe の中身はホストのサイトの評価にならない）の 3 点で難しく、価値も予約部分より小さい。

### 設計の要点（第1段）

- **ルート**：`/embed/experiences/{slug}/book`（第2段で `/embed/experiences/{slug}`）。`(embed)` の root layout はヘッダー・フッター・GA4 なし、背景は塗らない。`noindex`、`no-store`。
- **ヘッダー**：`next.config.ts` に `/embed/:path*` を足し、CSP の `frame-ancestors` だけ `https:` にする（開発は localhost も）。ほかのルートは `'none'` のまま。`/embed` のページはホスト・Admin・予約ページの cookie を読まない（もともと `SameSite=Lax` で iframe には届かない）。
- **画面**：予約フォームは 1 つの実装を保つ。`SitePublicationBooking` に月表示のカレンダーを入れ（公開サイトの `/book` も同じカレンダーになる）、埋め込みでは段階表示にする。エラーは押したボタンのそば、入力欄は 16px。
- **コード（ホストが貼るもの）**：iframe と短いインライン script。script の役目は高さの調整だけ。

  ```html
  <iframe id="niho-exp-…" src="https://experience.niho.life/embed/experiences/{slug}/book"
    title="Book {title}" loading="lazy" style="width:100%;max-width:520px;height:760px;border:0"></iframe>
  <script>/* origin と source を確かめて iframe の高さを変えるだけ */</script>
  ```

  「URL だけ」の形式も出す（STUDIO の Embed に URL を入れる、Wix の「サイトを埋め込む」）。
- **メッセージ**：子 → 親は `{ type: "niho-experience-embed-resize", height }` だけ。名前・アドレス・決済 URL・予約 ID は送らない。
- **決済への遷移**：仮押さえのあとの「Pay securely on Stripe」を押したときに、①最上位を遷移 → 失敗したら ②新しいタブ → それも駄目なら ③単独の予約ページへのリンク。決済 URL は親ページへ渡さない。
- **戻り先**：支払い後は今までと同じ `/booking/return?type=instant`（最上位、`experience.niho.life`）。取りやめは体験ページ。戻り先 URL を query や親ページから受け取らない。
- **申込経路**：予約に販売経路（`SITE`／`EMBED`）を予約時に固定で持つ（予約者の情報の消去の対象外）。ホストの予約一覧・通知に「自分のサイト（埋め込み）」。埋め込み先のホスト名は第1段では持たない。
- **計測**：埋め込みでは GA4 を読み込まない（ホストのサイトの同意の範囲外）。cookie を使わない計測で `embed_view`・`embed_checkout_start` だけ。
- **flag**：`EXPERIENCE_EMBED_ENABLED`（既定 OFF）。OFF の間 `/embed/*` は 404、発行画面は出さない。
- **表記**：販売者名・取消条件・プライバシーポリシーのリンクはウィジェットの中に残す（今の予約画面と同じ）。下に「Powered by NIHO Experience」。

### 受入で確かめること

- STUDIO・WordPress（自前サーバーと WordPress.com）・Wix に実際に貼り、iPhone Safari・Android Chrome・PC で、日付の選択 → 決済 → 完了まで通す（Stripe のテストモード、stg）。
- それぞれで決済への遷移が ①②③ のどれになるかを記録する。①も②も通らないビルダーがあれば、そのビルダーだけ親 script 経由の遷移を足すか判断する（その場合は Stripe へのメールアドレスの事前入力を外す）。
- `/embed` 以外のルートが iframe に入らないこと、`/embed` のページがホスト・Admin の cookie を読まないこと。
- 埋め込み経由の予約が予約一覧で見分けられ、確認メール・予約ページ・返金が今までどおり動くこと。

## 6. Open questions（すべて括弧の推奨どおりに決定。2026-11-25）

1. 最初に出す範囲は「予約ウィジェット＋予約ボタン」で、企画ページ丸ごとは第2段でよいか。（よい）
2. 決済は Stripe の画面へ移る形で始めてよいか。ウィジェットの中で完結させるのは後でよいか。（よい）
3. 貼れるサイトを制限するか。どこにでも貼れる／ホストが登録したドメインだけ。（どこにでも貼れる。niho-app の企画ページ埋め込みと同じ）
4. 自分のサイト経由の予約の NIHO 手数料は、体験サイトと同じ率か。（同じ率で始める。変えるなら、経路の判定を偽れない作りが要る）
5. 第1段は英語だけでよいか。日本語のウィジェットが要るか。（英語だけ。日本語は公開版の日本語対応のあと）
6. ウィジェットに「Powered by NIHO Experience」を出すか。（出す。販売者の表示は必須で残す）
7. 見た目の調整（背景透明・ボタン色）を第1段に入れるか。（入れない。第3段）
8. 支払い後の完了ページに「Back to {ホストのサイト}」を出すか。（出す。ただし埋め込み先が分かるときだけ）
   - 出すには、埋め込み先のオリジンを予約に保存し、完了ページが Stripe の Session から予約を引いて読む作りが要る。query で戻り先を受け取る作りにはしない（体験サイトのページに任意のリンクを出せてしまうため）。
   - URL だけで貼った場合や sandbox の中では埋め込み先が分からないので、ボタンは出ない。

## 7. Assumptions

- 対象は Experience の有効な公開版で、このサイトで売っている体験だけ。
- 埋め込みのために NIHO 共通基盤（niho-app）の変更は要らない。
- 価格・在庫・手数料・取消条件は今までどおりサーバーが決める。ウィジェットは表示と入力だけ。

## 8. Next steps

- 第1段の PR 1：予約ウィジェット、予約ボタン、ホストの発行画面（migration なし）。
- PR 2：販売経路と埋め込み先の記録、申込経路の表示、完了ページの戻るボタン（migration を先に適用）。
- 範囲と受入は #638 と `docs/embed.md`。
