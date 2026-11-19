# 計測ツールと同意の方式（決定案）

最終更新：2026-11-03。対象：[#14](https://github.com/niho-life/niho-experience/issues/14)、[#37](https://github.com/niho-life/niho-experience/issues/37)、[#70](https://github.com/niho-life/niho-experience/issues/70)。担当1から依頼された「計測ツール、同意の取り方、保存期間」への回答。
**アカウントの作成はオーナーが行う。** 有料プランの契約と広告タグの導入は、それぞれの授権の後にする。

## 現行のGA4同意方針（オーナー決定 2026-11-16）

ExperienceではGA4を使い続け、全地域で **basic consent mode の明示的なオプトイン**を取る。訪問者が「Allow analytics」を選ぶまでGoogleタグを読み込まず、未選択・拒否・撤回の状態ではイベントもcookieless pingも送らない。選択はブラウザー内に最大180日保存し、`/privacy` の「Change analytics settings」からいつでも変更できる。Do Not Trackが有効な間は、許可済みでも送信しない。

許可後は公開ページのページビューに加え、訪問・セッション集計に使われるGA4標準イベント（`first_visit`、`session_start`等）が自動送信される場合がある。予約・会員・ホスト・管理画面ではGoogleタグを停止し、予約関連のカスタムイベントは送らない。送るURLは既存の許可リストを通し、予約情報・個人情報を含めない。外部リファラーはoriginだけ、内部リファラーもExperienceのoriginだけを送る。広告保存・ユーザーデータ・広告パーソナライズ・Google Signals・User-IDは引き続き無効。GA4 cookieはExperienceホスト専用prefixで最大60日で、仮名のブラウザ識別子とセッション情報を保持する。選択保存には識別子を含めず、GA4のユーザー／イベント保持は2か月。

公開前にExperience `/privacy` とNIHOの日本語プライバシーポリシーへ送信先・送信情報・目的・拒否／撤回方法を記載する。地域差分や広告目的の計測へ広げる場合は、別途同意設計と公開文面を見直す。

## #70 のExperience公開設定

2026-11-03の #70 / NIHOapp #19255 により、Umamiを予約ファネルの計測先として維持しつつ、NIHOappが公開したExperience専用設定からGA4のページビューを送る経路を追加する。GA4は承認済み測定ID・本番origin・HTTPS・index許可が揃った場合だけ動作し、Do Not Track、プレビュー、別origin、非公開予約ルートでは送信しない。予約ファネルイベントや売上・確定予約はGA4へ送らない。

このコード契約は訪問者の同意や公開ポリシーの承認を代替しない。GA4はcookieを使うため、Eは公開設定を有効にする前に同意・プライバシー公表の扱いを確認する。公開設定のGA4 IDが未選択なら、タグは読み込まれない。

## 結論

| 項目 | 決定案 |
| --- | --- |
| 計測ツール | **Umami Cloud**（予約ファネル）と、#70の承認済み公開設定がある場合に限るGA4（ページビューのみ） |
| 同意 | Umamiはcookie・端末保存・独自訪問者IDを使わずバナーを出さない。GA4は全地域で明示的なオプトイン後だけ読み込む（上記の2026-11-16決定） |
| 保存期間 | Hobbyプランの保存期間（6か月）に従う。長く残す数字は、月ごとの集計を非公開台帳に写す |
| 送るもの | Umamiへ許可済みファネルイベントとサニタイズ済みページビュー。GA4へは明示同意後、承認済み公開ページのページビューと訪問・セッション集計の標準イベントを送り、PII・token・予約queryを送らない |
| 見送るもの | 広告タグ・session replay。広告の授権が出たときに、同意の取得（CMP）と一緒に改めて検討する |

## GA4 プロパティ設定（2026-11-07）

オーナーが、GA4 のプロパティの作成と同意の扱いを「一般的な推奨で」決めることを任せた（2026-11-07）。決めたこと：

- **プロパティ**：アカウント `NIHO` に新しいプロパティ `NIHO Experience`（property ID `562961860`、タイムゾーン日本、通貨 JPY、業種は旅行）。Web のデータストリーム `https://experience.niho.life`（stream ID `16287810605`、測定 ID **`G-KY52XDEG81`**。測定 ID はページに出る公開値）。コーポレートサイトの `niho.life` プロパティ（`487223355`）とは、サイトも同意も保存期間も別にするため分けた。
- **プロパティの設定**：拡張計測は OFF（ページビューはコードから手動で1回送るので、履歴変更の自動計測と二重になる）、Google シグナル OFF、User-ID OFF、ユーザー提供データの収集 OFF、イベントデータとユーザーデータの保持は 2 か月（最短）。アカウント共通の「データ共有設定」は、既存のプロパティにも効くため変えていない。
- **旧同意案（2026-11-07、2026-11-16に置換）**：広告の保存・ユーザーデータ・パーソナライズを denied とし、分析cookieを地域別に許可する案だった。日本を含む同意UIのない地域でも計測されるため、現在は採用しない。
- **公表**：Experience `/privacy` と日本語のNIHOプライバシーポリシーに、Google Analyticsへの外部送信（送信先・送る情報・目的）を記載する。
- **公開設定**：2026-11-16時点でExperience専用APIは登録済みの測定IDを返す。タグの読み込みは、Experience側の明示的な同意実装が公開されてから行う。
- **旧同意案の限界（参考）**：旧案ではEEA・英国・スイスの訪問をcookieなしのpingで計測し、日本など他地域では初期状態でcookieを使っていた。これは2026-11-16の全地域オプトイン方針に置き換えた。

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
| Google Analytics 4 | Cookieを使う任意計測として継続する。Google Consent Mode basic方式で、全地域の明示的な許可後だけタグを読み込む。予約・会員情報と予約関連カスタムイベントは送らず、公開ページのページビューと訪問・セッション用標準イベントに限る |
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

- Umamiのファネル計測は従来どおりcookieや端末識別子を使わず、同意バナーを出さない。GA4は別の任意計測として、全地域で同意UIを表示し、許可されるまでGoogleタグを読み込まない。
- この案は、cookie・端末保存・独自の訪問者IDを使わない計測と、4項目のUTMによる確定予約の集約に限る。`attribution_id` やUmami visitorとの個人単位の照合は実装しない。
- プライバシーポリシーに、計測ツールの名前、送る情報（閲覧したページ、イベント、おおよその地域・端末の種類など）、目的、保存期間を書く。文面はNIHOの既存のポリシーとそろえ、他の追記と合わせて後でまとめて行う（2026-10-19 オーナー決定）。[公開文案](privacy-copy.md)を用意し、本番で計測の送信を始める前に掲載する。
- 電気通信事業法の外部送信規律：今回の内容（この文書の計測）までは問題ないことをオーナーが確認した（2026-10-19）。送る情報や送信先を増やすときは改めて確認する。
- 広告タグを導入する場合は、広告目的の同意範囲とCMP要否を改めて決める。GA4のcookie同意は本書冒頭の全地域オプトインを適用する。

## 役割

| 作業 | 担当 |
| --- | --- |
| Umami Cloudのアカウントとサイトの登録（無料プラン）。サイトIDを担当1に渡す（秘密ではない） | オーナー |
| 送信処理、`data-before-send`、CSP、計測をブロックしても予約できることのE2E | 担当1 |
| ファネル（`experience_view` → `slot_continue` → `booking_form_view` → `checkout_start`）とUTM別の表示の設定、週次の振り返り | 担当3 |
| 予約確定・売上の集計（計測ツールではなく共通基盤から） | 担当2 |

ファネルの分母と重複排除は [funnel-measurement.md](funnel-measurement.md) の「ファネルの分母と重複排除」に定義した。
