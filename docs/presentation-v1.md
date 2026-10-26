# Portable presentation v1

Phase A は、公開サイトの英語 code-default 表示を `@niho/experience-presentation/v1` として固定する。公開 Next アプリは metadata、routing、`PageDocument` 選択、API read、availability、analytics、booking／payment の権限を引き続き持つ。presentation package は home、catalogue、detail、gallery、booking の2画面と detail booking card、help、host、card、chrome の実表示構造を持つ。

NIHO staff preview は公開サイトと同じ view component を利用する設計とし、認証付き管理画面への接続は niho-app#19260 で行う。実管理画面は選別された公開表示データと編集中の訳を使い、検証用 fixture は合成データとする。preview の callback は no-effects とし、別実装の見た目を再現しない。公開サイトの published `PageDocument` は従来どおり code-default fallback 全体を置き換える。Phase A は authored document の block 解釈を変更しない。

## package と version identity

固定SHAのraw URLにある `dist/experience-presentation-v1.tgz` を通常のnpm依存として導入し、次を公開する。

- `@niho/experience-presentation/v1`: React view、型、manifest、copy／asset helper
- `@niho/experience-presentation/v1/styles.css`: `.nexp-v1` に scope した CSS と固定 font
- `@niho/experience-presentation/v1/metadata`: React 非依存の version／copy metadata export
- `@niho/experience-presentation/v1/metadata.json`: schema 2 の完全な静的 copy 定義

`PRESENTATION_MANIFEST_V1` は renderer、legacy copy、static copy、decorative assets、CSS、font、React peer を SHA-256 で識別する。consumer は `assertPresentationIdentityV1` で完全一致を検証し、不明／改ざん identity を最新版として再解釈しない。将来の redesign は `/v2` を追加し、保存済み snapshot 用の `/v1` を残す。

React と ReactDOM は `^18.2.0 || ^19.0.0` の peer であり、Next、workspace web app、API client、router、auth、DB、payment runtime は package dependency に含めない。

## view model と behavior seam

全 view は公開可能な display string／media と狭い callback を受け取る。

- `HomeViewModelV1`: hero、finder seam、theme、experience card、editorial feature、video strip、host feature、figure、postcard
- `DetailViewModelV1`: typed gallery、host／fact、timeline、provider、inclusion、typed meeting、typed cancellation、typed detail booking card
- `BookingSelectionViewModelV1`: option、date status／card、guest counter、表示済み total／line。callback は選択、retry、show-more、continue のみ
- `BookingCheckoutViewModelV1`: availability 状態、contact、4種の question、review rows、canonical terms／consent、action 状態。callback は controlled field／answer／consent／submit のみ
- `DetailBookingCardModelV1`: price／schedule／assurance と、availability controller が作る `DetailBookingDatesV1` の狭い dates seam
- `DetailGalleryModelV1`: safe image、alt、back href。公開 wrapper は swipe index と dialog open/close だけを持つ

package は価格、在庫、seat、checkout、terms／consent version の決定をしない。公開 controller が権威ある値を計算・検証し、presentation には表示値と操作通知だけを渡す。preview の action は disabled／no-effects にする。

decorative asset は安定 ID、`src`／`srcset`／`alt`／`position` と content digest で binding する。listing、host、provider の写真は package にコピーせず、safe display model として都度渡す。`SAMPLE_MEDIA` release gate は維持する。

## copy registry

- schema 1: NIHO selected public UI registry 239 keysを byte-stable な legacy metadata codec として保持
- schema 2: schema 1 全239 keysと、実 code-default で不足した97 keysを合わせた完全な336-key static registry

schema 2 は home の2見出しを whole rich message として持つ。`{em}...{/em}` は保護された paired marker であり、順序を変えた翻訳でも `RichMessageV1` が text／emphasis segment だけを描画する。HTML、eval、DOM replacement は使わない。key 集合、placeholder multiset、marker の種類／回数／balance／order は入力時に完全一致を要求する。

追加97 keysには、分割されていた home／brand／price／host-line 見出し、home model の固定 label、gallery の件数表示、booking selection／checkout／detail card の残存固定 UI、canonical terms／consent 周辺、controller が view に渡す error copy、navigation／notice の accessibility label を含む。編集／feature／host／listing 名、日時、価格、人数などの可変内容は翻訳 UI key ではなく明示的 display model である。現時点で共有 v1 view に残る未登録の固定 UI copy はない。

## 実ブラウザでの最終補修

公開Server Componentからclient moduleの関数を直接実行しないよう、booking cardの純粋なmodel変換を中立moduleへ分離した。availabilityはclient componentとして渡し、価格・在庫の権限は従来のcontrollerに残す。日付読込後の価格はrich messageとして描画し、装飾markerを持つkeyをtext()へ渡す誤用を型でも拒否する。既存ENのhero見出しは原文どおり維持する。

## PC の組み替え（2026-10-21）

既存デザインの PC 対応として `/v1` のまま組み替えた（スマホの描画は変えない。redesign ではないので `/v2` は足さない）。consumer 向けに足したのは既定で従来どおりの任意 prop だけ。

- `BookingPageViewV1` の `wide`（既定 false）：lg からページの幅を通常の容器幅にする。公開サイトは公開文書が無いときだけ渡す。
- `BookingSummaryV1` / `BookingBarV1` の `aside`・`className`（既定 false / 空）：予約の2画面の中で使う。部品の幅が `@4xl`（56rem）以上なら、要約は右列の縦長のカード、バーは右列で追従するカードになる。
- 予約の2画面の root は size container（`container-type: inline-size`）。幅が内容で決まる枠（flex の行や auto の grid の列）に直接置くと幅が 0 になるので、幅のある block の中に置く。
- 詳細は文書の順を「パンくず・見出し → 写真 → 本文」に変え、スマホではギャラリーを `order-first` で見た目だけ先頭に出す。

## 旅行者の一周の追加（2026-10-22・Epic #103）

`/v1` のまま、既定では今までと同じ表示になる任意の項目だけを足した（redesign ではないので `/v2` は足さない）。**copy registry の key 集合は変えない**（key を足すと、NIHO が持つ保存済みの日本語の訳が不完全になり、日本語の画面が出せなくなるため）。足した表示の文言は、consumer が表示用の文字列として model で渡す。

- `DetailViewModelV1.conditions`（`DetailConditionV1[]`：アイコン・要点・補足）：「Good to know」の先頭に行として並べる。提供者の一覧（`know`）はその下に残る。
- `DetailViewModelV1.askHost`（ReactNode）：「Good to know」の下に置く差し込み口。Good to know が空の体験では取消の前に単独で置く。質問の部品そのもの（状態・通信）は consumer が持つ。
- `BookingCheckoutViewModelV1.conditions`：同意の対象の条件を並べる枠と同意の欄（"Before you book"）。あると step が 1 つ増え、`details` は 4、確認は 5 になる。
- `BookingCheckoutViewModelV1.guestPhone`：任意の携帯電話の欄（`type="tel"`・24 字まで）。
- `BookingCheckoutViewModelV1.hostQuestionsHeading`：質問の見出しの置き換え。
- callbacks：`onGuestPhoneChange`・`onConditionsAgreementChange`。
- `DetailViewModelV1.reviewHeadline`（`{ label, accessibleLabel?, href?, isNew? }`）：題名の下の 1 行。`href` があれば内部リンク、`isNew` なら "New" のバッジ。
- `DetailViewModelV1.reviews`（`{ title, content }`）：取消の前に置く節（`id="reviews"`・`scroll-margin` 付き）。見出しの文言と中身は consumer が渡す。
- `ExperienceCardModelV1.reviewLine`（`{ text, label }`）：カードの所要時間・言語の行の末尾（見た目の文と読み上げの文）。

## 体験ページの追加とフッターのリンク（2026-10-26・#145 #146）

同じく `/v1` のまま、既定では今までと同じ表示になる任意の項目だけを足した。copy registry の key 集合は変えない（文言は consumer が渡す）。

- `DetailViewModelV1.provider.bios`（`{ name, text }[]`）：「Your host(s)」のホストのチップの下に、ホスト紹介文を書式なしの文で出す。ホストが 2 人以上いるときだけ名前を前に付ける。
- `DetailViewModelV1.upcoming`（ReactNode）：題名（とレビューの 1 行）の下、ホストの行の前の差し込み口。公開サイトはブラウザで読んだ次の開催日（`CardDates`）を置く。
- `DetailViewModelV1.video`（ReactNode）：facts の後、ギャラリーの前の差し込み口。公開サイトは掲載同意のある公開動画だけを置き、再生ボタンが押されるまで YouTube を読み込まない。
- `DetailViewModelV1.faq`（`{ title, items: { question, answer }[] }`）：取消の前の節（`id="faq"`・h2 と質問ごとの h3）。項目が空なら出さない。
- `SiteFooterV1.links`（`{ href, label }[]`）：フッターの固定のリンク（体験・提供者・ヘルプ）の後に足すリンク。公開サイトはガイド記事があるときだけ `/guides` を渡す。

## 依存配布の分離

workspaceとbuild scriptを持つサイトrepository自体をGit依存にすると、npmの準備処理がサイト全体の依存導入を起動する（[npm公式仕様](https://docs.npmjs.com/cli/v10/configuring-npm/package-json/#git-urls-as-dependencies)）。サイトの通常workflowを維持し、固定SHAで参照する生成済みtgzを配布する。中身は版固定distとREADMEと最小manifestのみで、scripts・workspaces・devDependenciesを含めない。生成器は全ファイルとtgzを決定的に比較し、通常のReact18 consumer installで不要runtimeが入らないことを確認する。
