# 計測ツールと同意の方式（決定案）

最終更新：2026-11-03。対象：[#14](https://github.com/niho-life/niho-experience/issues/14)、[#37](https://github.com/niho-life/niho-experience/issues/37)、[#70](https://github.com/niho-life/niho-experience/issues/70)。担当1から依頼された「計測ツール、同意の取り方、保存期間」への回答。
**アカウントの作成はオーナーが行う。** 有料プランの契約と広告タグの導入は、それぞれの授権の後にする。

## #70 のExperience公開設定

2026-11-03の #70 / NIHOapp #19255 により、Umamiを予約ファネルの計測先として維持しつつ、NIHOappが公開したExperience専用設定からGA4のページビューを送る経路を追加する。GA4は承認済み測定ID・本番origin・HTTPS・index許可が揃った場合だけ動作し、Do Not Track、プレビュー、別origin、非公開予約ルートでは送信しない。予約ファネルイベントや売上・確定予約はGA4へ送らない。

このコード契約は訪問者の同意や公開ポリシーの承認を代替しない。GA4はcookieを使うため、Eは公開設定を有効にする前に同意・プライバシー公表の扱いを確認する。公開設定のGA4 IDが未選択なら、タグは読み込まれない。

## 結論

| 項目 | 決定案 |
| --- | --- |
| 計測ツール | **Umami Cloud**（予約ファネル）と、#70の承認済み公開設定がある場合に限るGA4（ページビューのみ） |
| 同意 | Umamiのcookie・端末保存・独自訪問者IDを使わない範囲では、**同意バナーを出さない案**。GA4 の同意と公表は下の「[GA4 の設定と同意の扱い](#ga4-の設定と同意の扱い2026-11-07)」で決定済み |
| 保存期間 | Hobbyプランの保存期間（6か月）に従う。長く残す数字は、月ごとの集計を非公開台帳に写す |
| 送るもの | Umamiへ許可済みファネルイベントとサニタイズ済みページビュー。GA4へは承認済み公開設定がある場合だけページビューを送り、PII・token・予約queryを送らない |
| 見送るもの | 広告タグ・session replay。広告の授権が出たときに、同意の取得（CMP）と一緒に改めて検討する |

## GA4 の設定と同意の扱い（2026-11-07）

オーナーが、GA4 のプロパティの作成と同意の扱いを「一般的な推奨で」決めることを任せた（2026-11-07）。決めたこと：

- **プロパティ**：アカウント `NIHO` に新しいプロパティ `NIHO Experience`（property ID `562961860`、タイムゾーン日本、通貨 JPY、業種は旅行）。Web のデータストリーム `https://experience.niho.life`（stream ID `16287810605`、測定 ID **`G-KY52XDEG81`**。測定 ID はページに出る公開値）。コーポレートサイトの `niho.life` プロパティ（`487223355`）とは、サイトも同意も保存期間も別にするため分けた。
- **プロパティの設定**：拡張計測は OFF（ページビューはコードから手動で1回送るので、履歴変更の自動計測と二重になる）、Google シグナル OFF、User-ID OFF、ユーザー提供データの収集 OFF、イベントデータとユーザーデータの保持は 2 か月（最短）。アカウント共通の「データ共有設定」は、既存のプロパティにも効くため変えていない。
- **同意（バナーなし）**：Google の Consent Mode で、広告の保存・ユーザーデータ・パーソナライズは**どこでも denied**。分析の保存（`_ga` cookie）は、事前の同意が要らない地域では granted、**EEA・英国・スイスでは denied**（cookie を置かない ping だけ）。同意の取得ツール（CMP）が無いので、denied を granted にする手段はない。ブラウザの Do Not Track は尊重する（送らない）。ページビューだけを送り、予約・返信ページと `/host`・`/admin` には送らない。cookie は 60 日（`apps/web/src/lib/ga4-consent.ts`）。
- **公表**：`/privacy` の「Visit counts」と Cookies の追記は、GA4 のタグが読み込まれる間（NIHO の公開設定に測定 ID があるとき）だけ出す。日本語のプライバシーポリシー（NIHO 側）に、Google Analytics への外部送信（送信先・送る情報・目的）の記載が要る（電気通信事業法の外部送信規律）。これは NIHO 側の作業。
- **有効化の手順（残り）**：NIHO の `apps/api/src/ops/niho-web-analytics/catalogue.ts` の `experience` に GA4（propertyId・streamId・measurementId・タイムゾーン `Asia/Tokyo`・公開済みの根拠）を登録して配備すると、`https://niho.life/api/public/experiences/site-settings` が測定 ID を返し、このサイトがタグを読み込む。それまで GA4 は出ない。
- **限界**：EEA・英国・スイスの訪問は cookie なしの ping で、標準のレポートにはほとんど出ない（Google のモデル化の条件を満たしたときだけ）。日本など他の地域の訪問は通常どおり数える。EEA 向けの計測が要るときは CMP を入れ、`gtag("consent", "update", …)` で granted にする。

## 選んだ理由

2026-10-19にUmamiの公式ページで次を確認した（[料金](https://umami.is/pricing)、[設定](https://docs.umami.is/docs/tracker-configuration)）。

- Hobbyプラン：月10万イベントまで無料、保存期間6か月。Proプラン：月100万イベントで月$20、保存期間2年。
- 独自イベント・イベントの値・ファネルが無料プランから使える。
- cookieを使わず、個人データを集めないとしている。
- オープンソースで、自前で運用することもできる。規模や保存期間が合わなくなったら、Cloud Runでの自前運用に移せる。

v1の規模（少数の体験、30日の検証）では、無料枠と6か月の保存期間で足りる見込み。ただしイベント数は実測で確かめる。

### 比べた他の選択肢

| ツール | 見送った理由 |
| --- | --- |
| Google Analytics 4 | cookieや広告識別子などの利用と地域別の同意設計が必要になる。GoogleのConsent Mode自体は同意を集める画面を提供しないため、公開設定を本番で有効にする前にCMP等の取得方法と地域別要件を確認する（[Google](https://support.google.com/analytics/answer/9976101)）。#70ではGA4イベントを追加せず、ページビューのみ接続する |
| Plausible | cookieを使わない点は同じ。2026-10-19の時点で公式の料金ページを確認できず、ファネルとイベントの値が含まれるプランと料金を検証できなかった |
| PostHog | session replayなど、v1では使わない機能が多い。cookieを使わない設定（`persistence: "memory"`）ではページをまたぐと同じ訪問者として扱われず、ファネルが成り立たない（[PostHog](https://posthog.com/docs/libraries/js/persistence)） |
| Cloudflare Web Analytics | 独自イベントがなく、ファネルを測れない |

## 設定（担当1が実装）

| 設定 | 値 | 理由 |
| --- | --- | --- |
| `data-domains` | 公開ドメイン（決定後） | プレビューや別のホストで動かさない |
| `data-do-not-track` | `true` | ブラウザのDo Not Trackを尊重する |
| `data-exclude-hash` | `true` | URLのハッシュを送らない |
| `data-before-send` | 関数を用意する | pageviewと許可したファネルイベントだけ通す。クエリ文字列は `utm_source`・`utm_medium`・`utm_campaign`・`utm_content` だけを残す。`/experiences/*/book` と `/booking/*` はクエリをすべて落とす。予約入力の値は送らない |
| `data-distinct-id` | 使わない | 訪問者に識別子を付けない |
| `data-performance` | 使わない（必要になったら検討） | v1の目的に要らない |

- UTMをページビューで受け取るため、`data-exclude-search` は使わず、上の `data-before-send` で残す値を絞る。
- Umamiの自動click収集を無効にし、pageviewはNext.jsのroute変更から手動送信する。ファネルイベント以外は `data-before-send` で破棄する。
- Tracker scriptは `cloud.umami.is/script.js` の2026-10-19時点のSHA-384 SRIで固定する。更新時はhashをレビューして同時に更新する。CSPはscript取得先 `cloud.umami.is` と送信先 `gateway.umami.is` を個別に許可する。
- プレビュー（mock）では送らない（現状どおり `window.__nihoEvents` に記録）。
- NIHO運営の内部アクセスは、Umamiの「自分の訪問を除外」の機能で除く。手順はアカウント作成後に公式の案内で確認する。

## サイト登録と実装

- Umami Cloudのサイト名は `NIHO Experience`、登録ドメインは `experience.niho.life`。
- Website IDは `f7a8b3ed-ef71-4a35-969e-955b88f01902`。公開IDのためコードへ直書きせず、`UMAMI_WEBSITE_ID` の実行時環境変数で渡す。
- `UMAMI_WEBSITE_ID` が設定され、APIモードが `http` で、`SITE_URL` が `https://experience.niho.life` と完全一致する場合だけトラッカーを読み込む。preview（mock）と他ホストでは送信しない。
- 現時点で本番サービス・本番配備workflowは未作成。将来、本番サービスを作る際にこのIDを本番サービスだけへ設定し、プライバシーポリシーへ計測内容を追記してから送信を有効にする。previewには設定しない。
- ブラウザの `Do Not Track` を尊重し、URLは許可したUTMだけ残す。予約入力URL・予約結果URLのqueryや予約結果識別子、URL hash、リファラーのpath/queryは送らない。
- オーナー決定（2026-10-20）：checkoutでは `utm_source` / `utm_medium` / `utm_campaign` / `utm_content` だけを予約行へ任意送信できる。Do Not Track が有効なら送らない。サイト内の移動中はメモリだけで値を保持し、cookie・session/local storage・独自訪問者IDを使わない。NIHO側は予約データの既存保持期間と閲覧権限を継承し、確定予約のUTM別集約にだけ使う。Umami visitorとは結合しない。
- Cloud tracker scriptは `cloud.umami.is/script.js` の取得内容をSHA-384 SRIで固定する（2026-10-19 snapshot: `sha384-na2rtfGcck2U+oedd3Fj+22SUyB41DM4F/gLssqYa9ELN6oF1aJzA2p80zu7Vy6a`）。上流のscriptが変わるとブラウザが実行を拒否するため、更新は内容を確認したPRで行う。

## 同意と公表

- 同意バナーは出さない。計測をブロックされても予約は同じように動く（担当1の実装どおり）。
- この案は、cookie・端末保存・独自の訪問者IDを使わない計測と、4項目のUTMによる確定予約の集約に限る。`attribution_id` やUmami visitorとの個人単位の照合は実装しない。
- プライバシーポリシーに、計測ツールの名前、送る情報（閲覧したページ、イベント、おおよその地域・端末の種類など）、目的、保存期間を書く。文面はNIHOの既存のポリシーとそろえ、他の追記と合わせて後でまとめて行う（2026-10-19 オーナー決定）。[公開文案](privacy-copy.md)を用意し、本番で計測の送信を始める前に掲載する。
- 電気通信事業法の外部送信規律：今回の内容（この文書の計測）までは問題ないことをオーナーが確認した（2026-10-19）。送る情報や送信先を増やすときは改めて確認する。
- cookieを使う計測や広告タグを入れる場合は、先に同意の取得を設計する。地域ごとの初期設定もそのときに決める。

## 役割

| 作業 | 担当 |
| --- | --- |
| Umami Cloudのアカウントとサイトの登録（無料プラン）。サイトIDを担当1に渡す（秘密ではない） | オーナー |
| 送信処理、`data-before-send`、CSP、計測をブロックしても予約できることのE2E | 担当1 |
| ファネル（`experience_view` → `slot_continue` → `booking_form_view` → `checkout_start`）とUTM別の表示の設定、週次の振り返り | 担当3 |
| 予約確定・売上の集計（計測ツールではなく共通基盤から） | 担当2 |

ファネルの分母と重複排除は [funnel-measurement.md](funnel-measurement.md) の「ファネルの分母と重複排除」に定義した。
