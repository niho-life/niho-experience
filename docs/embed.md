# ホストのサイトへの埋め込み（予約ウィジェット）

[#638](https://github.com/niho-life/niho-experience/issues/638)。オーナー決定 2026-11-25。設計の経緯とモックは [idea/active/2026-11-25-host-site-embed.md](../idea/active/2026-11-25-host-site-embed.md)。

STUDIO・WordPress・Wix などで自分のサイトを持つホストが、コードを 1 回貼ると、訪問者がそのサイト上で日程を選び、決済へ進める。価格・在庫・販売者・決済の正本と経路は [旅行者の予約](guest-booking.md) のまま変えない。

**現在地**：第1段（予約ウィジェットと予約ボタン）と、予約への販売経路の記録・ホストの申込経路・完了ページの戻るリンク（PR 2）。`EXPERIENCE_EMBED_ENABLED` は既定 OFF で、下の「受入」が済むまで本番で ON にしない。

## 決めたこと

| 論点 | 決定 |
| --- | --- |
| 方式 | iframe と専用ルート `/embed/...`。ホストのページの DOM に直接描画する JS は作らない |
| 第1段の範囲 | 予約ウィジェット、予約ボタン、ホストの発行画面 |
| 決済 | Stripe の hosted Checkout のまま。iframe の中では開かず、最上位のウィンドウで開く |
| 貼れるサイト | 制限しない（`https:` のサイト） |
| NIHO の手数料 | 体験サイトと同じ率 |
| 言語 | 英語だけ |
| 表記 | 「Powered by NIHO Travel」を出す。販売者・取消条件・プライバシーポリシーの表示は予約ページと同じ |
| 見た目の調整 | 入れない |

niho-app の公開埋め込み（`specs/initiatives/public-embeds.md`）と同じ形にした。違いは 2 つ。

- 署名 token・許可ドメイン・短命 session を持たない。申込は同一オリジンで完結し、公開サイトで誰でもできる操作と同じだから（niho-app の企画ページ埋め込みと同じ扱い）。
- 決済 URL を親ページへ渡さない。Stripe の画面には予約者のメールアドレスを事前入力していて、URL を知ったページはその画面を開ける。このサイトは予約者のアドレスをホストに出さない。

## 仕組み

### ルート

`/embed/experiences/{slug}/book`。route group `(embed)` の root layout は、サイトのヘッダー・フッター・計測（Umami・GA4）を持たず、背景を塗らない。ページは公開サイトの予約ページと同じ `SitePublicationBooking` を `layout="embed"` で出す。

| 場合 | 表示 |
| --- | --- |
| `EXPERIENCE_EMBED_ENABLED` が OFF | 404（「This page isn't available.」だけの短いページ） |
| 公開中で、予約を受けている | 予約ウィジェット |
| 公開していない・停止中・slug が無い・予約の flag が OFF・障害時の停止 | 枠の中に「Online booking is temporarily unavailable for this experience.」。iframe の中で 404 を出さない |
| `?preview=1`（ホストの発行画面のプレビュー） | 予約ウィジェット。日付と人数までで、申込はできない |

### ヘッダー

`next.config.ts` の `/embed/:path*` だけ、CSP の `frame-ancestors` を `https:` にする（開発時は localhost も）。ほかの指令と、ほかのルートの `frame-ancestors 'none'` は変えない。`/embed` は `Cache-Control: private, no-store`・`X-Robots-Tag: noindex, nofollow`。

`/embed` のページは cookie を読まない。ホスト・Admin・予約ページの cookie は `SameSite=Lax` で、別サイトの iframe には届かない。

ホストの画面（`/host` 以下）だけ、発行画面がプレビューを枠に出せるように `frame-src` に `'self'` を足す。ホストの画面はページを読み直さずに画面を移るので、発行画面のルートだけに付けると、ほかの画面から来たときに枠が止まる。このオリジンで枠に入れるのは `/embed` だけなので、ホストの画面がほかのページを枠に入れることはできない。それ以外のルートの CSP は 1 文字も変えない。

### 通信

残席（`GET /api/public/experiences/{slug}/availability`）と申込（`POST .../checkout`）は、枠の中のページから同一オリジンで呼ぶ。`fromThisSite` も CORS も変えない。ゲスト予約は cookie を使わないので、サードパーティ cookie の制限を受けない。

### 親ページへのメッセージ

枠の中のページが `window.parent.postMessage` で送るのは次の 2 つだけ。宛先は `*`（中身に秘密が無い）。

| `type` | 中身 | 親の動き |
| --- | --- | --- |
| `niho-experience-embed-resize` | `height`（px） | iframe の高さを変える |
| `niho-experience-embed-top` | なし | iframe の先頭が見える位置へスクロールする（段を進めたとき） |

名前・メールアドレス・決済 URL・予約 ID・エラーの中身は送らない。親ページからのメッセージは受け取らない。

## 旅行者の流れ

1. **日付と人数**：月のカレンダーで日付を押す。押せるのは残席照会の `bookable` な日。押すと開始時刻（JST）と残席が出る。人数を入れると合計が出る。
2. **連絡先と同意**：選んだ内容（日時・人数・合計）と取消条件、ホストの質問、名前、メールアドレス、メモ、同意。同意の文が指す取消条件を、同意する画面にも出す。
3. **申込**：今までと同じ `POST .../checkout`。応答の `checkoutUrl` で分かれる。
   - **Stripe の URL**（支払いのある即時予約）：「Pay securely on Stripe」を出す。押すと最上位のウィンドウを Stripe へ移す。最上位への遷移を止められたら（sandbox）、新しいタブで開く。ボタンの下に「Open payment in a new tab」のリンクも置く。
   - **このサイトの URL**（無料の予約、予約リクエスト、支払い済みの再送）：ホストのサイトを離れず、枠の中で完了ページと同じ言葉を出す（確認メールが届くこと、リクエストは NIHO が確認すること）。

遷移を「利用者が直接押したボタン」に限るのは、申込の通信のあとの自動遷移がブラウザや sandbox に止められるため。席は申込の時点で 35 分仮押さえされている（[guest-booking.md](guest-booking.md)）。

段を替えると、親ページに枠の先頭へのスクロールを頼み、枠の中のスクロールも先頭へ戻す（「URL だけ」で貼った固定の高さの枠のため）。押した日が満席になっていたら 1 段目に戻し、理由を 1 段目のいちばん上に出す。高さは、変わったときと、最初の表示の 1.5 秒後にもう一度送る（親の script があとから動き出すサイトのため）。

支払い後は今までどおり `/booking/return?type=instant`、取りやめは体験ページ（どちらもこのサイト、最上位）。戻り先 URL を query や親ページから受け取らない。

埋め込み先のオリジンを予約に保存できたとき（下の「流入の印」）だけ、この申込で新しく作る Stripe の Session の戻り先に `&cs={CHECKOUT_SESSION_ID}` を足す（Stripe が Session の ID に置き換える）。完了ページは `cs` の Session の予約から保存したオリジンを読み（`findEmbedReturnOrigin`）、ほかの操作の並びに「Back to {ホストのサイト}」（`/ja` は「{ホストのサイト} に戻る」）のリンクを 1 つ出す。リンク先はオリジン（`https://host[:port]`）だけで、path・query を付けない。

- **出す条件**：埋め込みの予約で、オリジンを保存していて、予約が支払い済み・支払いの確認中、または仮押さえが生きている（`HOLD` で期限前）こと、かつ申込から 2 時間以内。取消・期限切れ・古い予約、体験サイトの予約、知らない Session、`cs` の形の誤り（`cs_` で始まる英数字と `_` だけ。合わなければ DB を読まない）、DB が 1.5 秒以内に答えない・読めない、flag が OFF のときは出さず、ページは今までと同じ。承認後にメールの支払いリンクから払う予約リクエストには出さない（その Session の戻り先は今までどおり）。
- **`cs` の扱い**：`cs` は URL の query に載るので、基盤（Cloudflare・Cloud Run）のアクセスログには残る（[guest-booking.md](guest-booking.md) の前提どおり、query はアクセスログへ漏れるものとして扱う）。アプリのログ・計測（完了ページの計測は query を落とす）・Referer（`no-referrer`、戻るリンクは `rel="noopener noreferrer"`）には出さず、DB の新しい場所にも保存しない。`cs` を知っても読めるのは、上の条件を満たす間の埋め込み先のオリジンだけで、予約の内容・状態・予約者は読めない。
- 完了ページは今までどおり予約の内容・状態を出さない。

公開サイトの `/experiences/{slug}/book` も同じカレンダーを使う。そちらは今までどおり 1 画面で、申込のあと自動で決済へ移る。

### 流入の印

埋め込みの申込には、流入の印が無ければ `utm_source=provider`・`utm_medium=embed` を付ける。既存の「提供者経由の予約リンク」（#531、`utm_source=provider`）と同じ系列で、Do Not Track なら送らない。iframe の URL に `utm_*` を付ければそちらを使う。

流入の印とは別に、予約は販売経路を固定で持つ（`booking_guests.sales_channel`：体験サイトは `SITE`、埋め込みは `EMBED`。migration `0089`）。埋め込みの申込は `salesChannel: "embed"` と、分かれば `embedOrigin` を送る。Do Not Track のときはオリジンを送らず、サーバーも `DNT: 1` の申込ではオリジンを保存しない（流入の印と同じ扱い。`salesChannel` は送り、保存する）。オリジンは `location.ancestorOrigins` の最後（最上位のページ）から、無いブラウザでは枠が最上位のページの直接の子のときだけ `document.referrer` から取り、`https:` で、このサイトでないものだけを使う。サーバーは `https:` のオリジン（小文字、255 文字まで）に直し、形の合わないものは「無し」として申込を受ける。同じ `clientRequestKey` で経路やオリジンだけが違う再送は `REQUEST_MISMATCH`。体験サイトの申込の保存と `request_fingerprint` は経路を足す前と同じ。ホストの予約一覧・詳細の申込経路は、埋め込みからの予約を「自分のサイト（埋め込み）」と出す（オリジンはホストに出さない）。

## ホストが貼るもの

発行画面は 2 つの形式を出す。

**コード**（iframe と、高さを合わせる短い script）：

```html
<iframe src="https://travel.niho.life/embed/experiences/{slug}/book"
  title="Book {title}" loading="lazy" style="width:100%;max-width:520px;height:760px;border:0"></iframe>
<script>(function(){var f=document.currentScript.previousElementSibling;
if(!f||f.tagName!=="IFRAME")return;
window.addEventListener("message",function(e){
  if(e.origin!=="https://travel.niho.life"||e.source!==f.contentWindow)return;
  var d=e.data||{};
  if(d.type==="niho-experience-embed-resize")f.style.height=Math.max(240,Math.ceil(d.height))+"px";
  if(d.type==="niho-experience-embed-top")f.scrollIntoView({block:"start"});
});})();</script>
```

同じページに複数の体験を貼る場合も、それぞれの script は直前の iframe だけに紐付きます。

**URL だけ**：`https://travel.niho.life/embed/experiences/{slug}/book`。URL しか受け付けない埋め込み枠に使う。高さは枠の設定で決まり、ウィジェットは 3 段なのでそのまま使える。

**予約ボタン**：既存の予約リンク（`/experiences/{slug}?utm_source=provider&utm_medium=referral`）を指す `<a>`（新しいタブ）。iframe もコードも貼れない場所で使う。

script は `event.origin` と `event.source` を確かめ、iframe の高さとスクロール位置しか変えない。外部の JS は読み込まない。

## ホストの画面

- **入口**（flag が ON のときだけ）：体験の編集の右列「掲載」と、体験の一覧の「予約リンクをコピー」の下に「自分のサイトに貼る」。出すのは、予約リンクと同じく「公開中で、保存した内容が公開内容と同じ」体験だけ。mock mode の編集画面では右列「ページ」に同じ入口を出す。
- **`/host/experiences/{id}/embed`**：種類（予約ウィジェット・予約ボタン）、プレビュー（`?preview=1` の実物）、コード（「コード」「URL だけ」とコピー）、貼り方（STUDIO・WordPress・Wix）。体験の編集を開ける人が開ける。商品は既存の `GET /host/api/products/{id}` で読み、新しい API は足さない。
- 公開していない体験・保存していない変更がある体験は「この体験を公開すると使えます」と出し、コードを出さない（下書きの slug は公開ページに届かない）。
- 日本語だけで公開している体験（#59）は、第1段では埋め込めない（枠の中は英語のページを読む）。発行画面でそう伝え、予約リンクを案内する。
- コードも URL も秘密ではない（公開ページの URL と同じ）。

## データの境界

| 情報 | 扱い |
| --- | --- |
| 名前・メールアドレス・回答・メモ | 枠の中のページからこのサイトの API へだけ送る。親ページの JS からは読めない（別オリジンの iframe） |
| 決済 URL・予約 ID | 親ページへ渡さない |
| 埋め込み先のサイトの URL | オリジン（`https://host`）だけを予約に保存する。path・query は保存しない。Do Not Track なら送らない・保存しない。体験の 1 年後に予約者の情報と一緒に消す。ホストには出さない。プライバシー通知に書く |
| 計測 | 枠の中では Umami・GA4 を読み込まない |

## flag と配備

- `EXPERIENCE_EMBED_ENABLED`（既定 `false`、repo variable は `EMBED_ENABLED`、配備の前提は「ホストの画面」）。OFF の間 `/embed/*` は 404、ホストの入口と発行画面は出ない。予約そのものは `EXPERIENCE_GUEST_BOOKING_ENABLED` と `BOOKINGS_ENABLED` に従う。mock mode では公開版が無いので、枠の中は「予約できません」の表示になる（ホストの発行画面は合成データで見られる）。
- migration `0089_booking_sales_channel.sql`（`booking_guests` に `sales_channel`・`embed_origin` と制約、`checkout_session_ref` の部分 index）を、新しい版より先に適用する（列を足すだけで、今の版はこの列を読み書きしない）。新しい Secret・runtime role の権限は増えない（`booking_guests` は今までどおり INSERT・UPDATE）。
- `0089` が未適用のまま新しい版が動くと、列が無いため次が失敗する：ホストの予約一覧・詳細・この回の名簿・通訳の予約読込み（`sales_channel` を読む）、予約者情報の消去の段（`embed_origin` を消す）、埋め込みの申込（列を足した INSERT）。体験サイトの申込・再送は SQL が変わらないので動く。完了ページの戻るリンクは読めずに出ないだけ。
- `EXPERIENCE_EMBED_ENABLED` が OFF の間、申込の `salesChannel`・`embedOrigin` は読み捨てて体験サイトの予約として保存し、完了ページは `cs` があっても DB を読まずリンクを出さない。ON から OFF に戻すと、開いたままのウィジェットからの再送（同じ `clientRequestKey`）は経路が変わるため内容不一致（`REQUEST_MISMATCH`）になる。ウィジェットを読み直せば新しい申込として申し込み直せる。
- ヘッダーはビルド時に決まるので、flag が OFF でも `/embed/:path*` の CSP は `frame-ancestors https:` になる。ページが 404 なので、枠に入るものは無い。

## 受入（flag を ON にする前）

1. stg（Stripe のテストモード）で、STUDIO・WordPress（自前サーバーと WordPress.com）・Wix に貼り、iPhone Safari・Android Chrome・PC で、日付の選択 → 決済 → 完了まで通す。
2. それぞれで決済への遷移が「最上位へ移動」「新しいタブ」のどちらになるかを記録する。どちらも通らないサイトがあれば、そのサイトの扱いを決める。
3. 「コード」で貼ると高さが中身に合うこと、「URL だけ」で貼ると固定の高さで申込まで進めることを確かめる。
4. `/embed` 以外のルートが iframe に入らないこと、`/embed` のページがホスト・Admin の cookie を読まないことを確かめる。
5. 埋め込み経由の予約で、確認メール・予約ページ・返金・ホストへの通知が今までどおり動くことを確かめる。
6. 貼り方の文言を、各サービスの実機の画面に合わせて直す。
7. プライバシー通知（`/privacy`「What we keep」）の、ホストのサイトの予約フォームから予約したときにサイトのアドレスを保存する文言を、オーナーが確認する。

## 次の段

| 段 | 内容 |
| --- | --- |
| 第2段 | 企画ページ丸ごとの埋め込み。パンくず・ほかの体験・ガイド記事・写真の拡大表示は出さない |
| 第3段 | 背景透明・ボタン色、日本語、必要ならウィジェット内での決済 |
