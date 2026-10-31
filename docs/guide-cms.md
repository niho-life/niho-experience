# Guide CMS の非公開写真と関連体験

[#215](https://github.com/niho-life/niho-experience/issues/215) では英語記事に任意のカバー写真を1枚だけ設定し、[#216](https://github.com/niho-life/niho-experience/issues/216) で同じ非公開asset境界を本文写真へ拡張した。[#189](https://github.com/niho-life/niho-experience/issues/189) は公開SSRと公開画像配信を実装するが、`EXPERIENCE_GUIDE_PUBLIC_SOURCE=database` まで既存の静的表示を維持し、公開 media route は404のままにする。

## データと権利の境界

- ブラウザは認証済み `/editor` API へ JPEG または PNG を送る。GCS の署名 URL、bucket 名、object key、GCS URL、原本は受け取らない。
- server は入力を 10MB・16MP・各辺 12,000px までの単一画像に制限し、magic と decode 結果を検査する。orientation を適用し、長辺 2400px 以内の sRGB JPEG に再エンコードする。EXIF・ICCその他の metadata と原本は保存しない。
- HEIC は production Linux の対応を契約していないため非対応とし、JPEG/PNGへの変換を案内する。対応していない形式を黙って受け入れない。
- asset ID は UUID v4 の不透明IDで、article と creator に固定する。状態は `UPLOADING` → `READY` または `REVOKED`。認証済み画像 read も毎回 editor session、記事所有、現在の writer/provider authority、asset scope、`READY` を再検査し `private, no-store` で返す。
- draft が持つのは asset ID、英語 alt、公開クレジット、Web掲載確認だけ。SNS・OG利用の同意には使わない。
- 公開時は記事行と asset を同じ transaction で lock し、revision、所有、article/creator scope、`READY`、Web掲載確認、非失効を再検査する。`guide_publication_media` に表示情報を snapshot してから publication を seal する。失敗時は記事 draft と旧公開版を維持する。
- 公開 read は snapshot に加えて現在の asset が `READY` の場合だけ cover metadata を返す。権利取消または公開停止後は返さない。publication snapshot 自体は監査用に変更しない。
- 掲載権利の取消は同じDB transactionで下書きからも写真を外し、revisionを更新する。通常の「記事から外す」は権利を取り消さない。公開済み・権利取消済みのobjectは保持期間が決まるまで物理削除しない。upload失敗後の未公開objectだけ削除を試み、削除に失敗した `REVOKED`・`ready_at IS NULL` assetは運用で再確認する。

## 配備ゲート

`EDITOR_CONSOLE_ENABLED` は NIHO 側の editor app-connect と受入が完了するまで既定値 `false` を維持する。bucket が未設定のまま editor を開いた場合、upload/read は `503 media_storage_unavailable` とし、mock成功やローカル保存へ fallback しない。

editor を受け入れる候補 revision では、次を先に満たす。

1. 専用 GCS bucket を作り、Uniform bucket-level access を有効化し、Public access prevention を `enforced` にする。allUsers / allAuthenticatedUsers と object ACL は使わない。
2. Cloud Run runtime service account だけに、その bucket に限定した `roles/storage.objectUser`（object create/get/deleteに必要）を付与する。deployer、GitHub Actions、preview、ブラウザには付与しない。
3. bucket 名を server-only の `GUIDE_MEDIA_BUCKET` に設定する。値を `NEXT_PUBLIC_*`、HTML、ログ、エラー、GitHub変数の公開出力へ出さない。
4. `0009_guide_media.sql` を適用し、合成 JPEG/PNG の upload・private read・draft保存・公開・権利取消・404 public route を staging で確認する。実顧客写真を受入証跡に添付しない。

bucket の CORS や公開 CDN は設定しない。#189 で public SSR/画像配信を接続するときも、現在の権利を再検査する server route を先に設計し、draft object keyを公開URLへ転用しない。

## 公開SSRと画像配信（#189）

- http modeで `EXPERIENCE_GUIDE_PUBLIC_SOURCE=database` を明示したときだけDB publicationを公開元にする。`EXPERIENCE_DATABASE_URL` または `GUIDE_MEDIA_BUCKET` が無ければ起動時に失敗し、静的記事・mock・ローカル画像へfallbackしない。flag off/mockは従来の静的記事とpreviewを維持する。
- 一覧は現在のsealed `PUBLIC` publicationだけ、詳細は`PUBLIC`または直URLを知る`UNLISTED`だけを読む。draft、`STOPPED`、過去publicationは公開しない。database modeでは静的記事をunionしない。
- `/api/public/guides/media/{assetId}` は匿名GETだけを持つ。現在`PUBLISHED`の記事のcurrent publicationにsnapshotされた、現在`READY`のassetだけをprivate bucketからJPEGとして返す。object key・bucket名・署名URLをレスポンスへ出さない。unknown、old publication、`REVOKED`は404、bucket/DB/read異常とbyte不一致は503とする。
- JPEG応答は `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex` とする。HTML・metadata・sitemapもrequestごとにDBを読み、ISR、Nextの永続cache、CDN HTML/media cacheを使わない。React `cache` は同一request内の重複読取だけに使う。
- coverと本文figureのURLはopaque asset IDのrouteだけ。Markdownの内部asset参照は現在READYのsnapshot placementと交差したものだけ解決し、取消直後の次requestで画像を消す。Web掲載確認をSNS/OG許諾へ拡張せず、DB写真はOG metadataと`Article.image`へ出さない。
- 記事→体験はpublication linkの現在権限、現在`PUBLISHED` productと現在slugを再評価し、さらに旅行者向け公開catalogと交差する。体験→記事も同じ現在有効linkを持つ`PUBLIC` publicationだけを使う。

## 関連体験への招待 API（#190）

`/editor/api/guide-link-invitations` はログイン中のwriter本人に未応答の招待だけを返す。`/{id}/accept`・`/{id}/decline` は同一originのPOSTで`{generation}`を受け、Storeが現在のwriter grant・招待したOWNER・世代・状態を同一transactionで再検査する。`/host/api/guide-link-invitations/providers/{providerId}` は現行OWNERの招待一覧と新規招待、`/{id}/revoke` は`{generation}`を受けて現在のOWNER・世代・状態を再検査する。host BFFは各要求でNIHO `GET /api/auth/me`のuser IDをsealed sessionと照合し、401・ID不一致ではcookieを消す。DTOにはwriter・招待者のNIHO user ID、名前、メールを出さず、すべて`private, no-store`で返す。

ホストの新規招待POSTは同一originのJSON `{email}` または `{nihoUserId}` を受ける。先にStoreで現行OWNERを検査し、その後NIHO #19462の `POST /api/experience-guide-writers/resolve` へserver-held host AppConnection tokenとExperience runtime service accountのGoogle ID tokenを送る。NIHOは両方を検証してverified email・有効アカウントを解決するだけで、Experience Storeが現行writer grantとOWNERをtransactionで再検査して招待を保存する。NIHOの対象不適格404は`X-NIHO-Guide-Writer-Resolver: v1`で未配備・flag OFFの404と区別する。resolverの401・403ではhost cookieを消さず503にし、host tokenの失効は先行する`/api/auth/me`で判断する。NIHO APIが未配備、service identityが取得不能、またはhost app-connect #19277が未配備なら招待は開かない。editor/host flagがOFFなら404。ブラウザが指定したuser IDをStoreへ直接通さない。既存hostのCOHOST権限は流用せず、招待を受諾しても商品編集・予約・顧客・売上への権限は生まれない。

## database flagを開く前のゲート

1. `0005`、`0008`、`0009`、両方の`0010`、`0011`、`0012`を含む全migrationをファイル名順にstagingへ適用し、category、writer/provider authority、article、asset、publicationを非公開の移行手順で投入する。#147 の限定公開URLを維持する場合、同じslugの `UNLISTED` 公開版へ移し、切替後も直接URLがnoindexで読めることを確認する。実ID・未公開原稿・object keyをGit、CI、公開ログへ残さない。
2. private bucketのUniform bucket-level access、Public access prevention、runtime SA限定IAM、`GUIDE_MEDIA_BUCKET`を確認する。bucket CORS、公開ACL、公開CDNは作らない。
3. NIHO editor app-connect/auth（niho-app #19459/#19462）のstaging受入を完了し、writer/provider権限失効、公開、更新、停止、UNLISTEDを確認する。editorの有効化とpublic sourceの切替は別々に判断する。
4. 合成記事でPUBLIC/UNLISTED/draft/STOPPED、category順、初回公開日と更新日、canonical/Article JSON-LD/noindex、home/list/detail/footer/sitemap、体験との双方向linkを確認する。静的記事がdatabase集合へ混ざらず、DB停止時に静的fallbackしないことも確認する。
5. 合成JPEGでcover/本文、過去publication、権利取消直後の404、storage異常の503、全no-store header、HTML/JSON/logにobject keyが無いことを確認する。Cloudflareは`/guides*`、公開media route、HTML、sitemapをbypassする。

切戻しは新しいrevisionで `EXPERIENCE_GUIDE_PUBLIC_SOURCE=static` に戻す。DB publication/assetを削除せず、editor flagや検索公開を同時に開閉したことにしない。

## 本文写真（#216）

本文写真は `0010_guide_body_media.sql` 適用後に利用する。Markdown の新規写真形式は、行単独の `![English alt](niho-guide-asset:<uuid-v4>)` だけとする。本文が持つのは記事scopeの opaque asset ID、配置順、文脈依存の英語altだけで、object key・署名URL・公開クレジット・許諾記録は持たない。外部URL、`/sample/`、raw HTML、未知・別記事・`UPLOADING`・`REVOKED` assetは、storeを直接呼んでも保存・公開できない。1記事の配置は10か所以内で、同じassetを複数位置に置ける。

editor は TipTap の atom `guideFigure` をカーソル位置へ置く。popover から記事専用写真をuploadまたは既存の `READY` assetから選び、英語alt・公開クレジット・Web掲載確認を設定する。画像は認証済み `private, no-store` routeだけで表示し、ブラウザへobject keyを返さない。既存の外部URL写真はネットから取得せず、原文を持つ unresolved node として表示する。明示的に内部assetへ差し替えるまで保存・公開を拒否し、失敗時も原文を画面内に保持する。

公開transactionは article をlockしてから参照assetをUUID順にlockし、記事・作成者scope、`READY`、初回確認時に固定された公開クレジットとWeb掲載確認、非失効を再検査する。`guide_publication_media` は coverを `slot=0 / placement=COVER`、本文を `slot=1..10 / placement=FIGURE` として、alt・credit・順序をimmutable snapshotへ保存する。公開read modelはsnapshotと現在も `READY` の本文写真metadataだけを返す。#189のrouteは上記database flagのときだけ公開HTMLへ接続し、flag offでは404を維持する。

本文写真の設定から「掲載権利を取り消す」を実行できる。権利取消ではobjectを物理削除せず、publication snapshotとMarkdownも監査・差替えのため残す。本文参照があればarticle revisionを進め、公開readからは直ちに非表示にする。以後の保存・再公開は差替えまで拒否する。通常の「記事から外す」はMarkdownから配置を削除するだけで、assetの権利取消ではない。coverの既存draft・snapshot・取消契約は維持する。

## 関連体験（#223）

`0011_guide_draft_product_links.sql` は、記事ごとに最大3件の `(provider_id, product_id)` と表示順だけを下書きとして保持する。個人名・メール・招待情報は複製しない。記事本文と関連体験は同じ `guide_articles.revision` を楽観ロックに使い、下書き保存transactionで記事更新と選択行の全置換を行う。PATCHで選択を省略した既存クライアントは現在値を維持する。

新しく選ぶ体験は現在 `PUBLISHED` で、保存actorが現在のOWNER/EDITOR、または有効なwriter grant・受諾済み招待・link membershipをすべて持つ場合だけ追加できる。提供者主体の記事はその提供者の商品に限定する。権限失効後も既存選択は下書きから失われず、並べ替え・削除はできるが、新規追加として権限を迂回できない。候補APIは先に記事所有と現在のsubject authorityを確認し、記事のsubjectから導いた範囲だけを `private, no-store` で返す。

公開commandは関連体験を入力に取らず、lockした記事の保存済み選択を読む。現在の商品状態・subject制約・membership・招待・writer grantを再検査し、すべて有効な場合だけ既存のimmutable publication linkへactor・permission basis・表示順をsnapshotしてpublicationをsealする。公開readはこの表示順を使い、旧公開版の順序未記録行は従来のprovider/product順で読む。0件は有効で、1件でも失効していれば旧公開版を切り替えない。preflightも失効を「関連する体験」設定から外す問題として返すが、競合を防ぐ根拠は公開transaction内の再検査とする。

## NIHO Adminからのgrant/category管理（#224）

Experienceは、受諾済みwriter grantとGuide categoryの正本・監査だけを持つ。NIHOはverified email、本人性、招待と受諾、通知配送、outboxを持ち、招待のemail・氏名・本文・tokenをExperienceのDB、API response、logへ送らない。相関用`sourceInvitationId`はNIHOの招待内容の複製ではない。`0005`で作成済みのgrantは`0012_guide_admin.sql`適用時に`sourceVersion=0`となり、より新しいcommandが来るまで従来どおり有効である。既存categoryは`revision=1`から始まる。

内部契約は`/internal/guide-admin/v1`、HTTP mode限定、`GUIDE_ADMIN_API_ENABLED=false`が既定である。有効化には`GUIDE_ADMIN_AUDIENCE`、許可する1つの`GUIDE_ADMIN_SERVICE_ACCOUNT_EMAIL`、`EXPERIENCE_DATABASE_URL`をすべて必要とする。audienceはCloud Runのservice URLか明示設定したcustom audienceを使う（custom domainそのものは既定のaudienceにしない）。`Authorization: Bearer <Google service account ID token>`のGoogle署名・issuer・期限、設定audienceとの完全一致、verified email claimと許可emailとの完全一致をserverで検査する。Firebase user token、通常の`/admin` cookie、`/editor` session、`/host` sessionは認証材料にしない。flag offは認証・DBより先に404、identity不正は401、署名鍵取得等の検証停止とDB停止は503とし、対象の存在を未認証callerへ示さない。tokenはrequest memoryだけに置き、log・browser・receiptへ出さない。全responseは`private, no-store`かつ`noindex`である。

### Writer grant

- `GET /internal/guide-admin/v1/writers/{nihoUserId}`は`{writer:{nihoUserId,active,sourceVersion,sourceInvitationId?}}`で1つの安定NIHO user IDの現在状態を返す。未作成は`active=false, sourceVersion=0`として扱う。
- `PUT /internal/guide-admin/v1/writers/{nihoUserId}`のJSONは正確に`{active:boolean,sourceVersion:positive safe integer,sourceInvitationId:UUIDv4}`、headerは`Idempotency-Key: UUIDv4`と`X-NIHO-Admin-Actor-Id: <stable NIHO user ID>`である。NIHOは招待受諾後だけ送る。
- userごとの`sourceVersion`は単調増加とする。保存済みversionより小さいcommandは409。同じversionでdesired stateとinvitation IDが同一なら副作用なしで成功し、異なれば409となる。したがって遅延したactivationは新しいrevokeを戻せない。

### Category

- `GET /internal/guide-admin/v1/categories`は`{categories:[{slug,labelEn,labelJa,displayOrder,active,revision}]}`でinactiveを含む全categoryとrevisionを返す。PUT成功は更新後の`{writer}`または`{category}`を返す。競合は409と`{error:"conflict",reason}`を返す。
- `PUT /internal/guide-admin/v1/categories/{slug}`のJSONは正確に`{labelEn,labelJa,displayOrder,active,expectedRevision}`、headerはwriter PUTと同じである。slugは1〜80文字のlowercase英数字と単一hyphenで不変、labelは空白だけを不可として各120文字以内、orderは`0..1000000`の整数とする。
- `expectedRevision=0`は未作成slugだけをrevision 1で作成する。正の値は現在revisionとの一致時だけ更新し、revisionを1進める。DELETEは設けない。editorのcategory候補は従来どおりactiveだけ、publicationはcategory label/order snapshotを保持するため、category変更やinactive化で公開済み版を書き換えない。

### IdempotencyとNIHO callerの責務

全PUTはroute、actor、target、意味上のbodyをcanonical JSONにしてSHA-256 hashを計算する。Store transactionは最初にidempotency key、次に対象をlockし、mutationまたはversion/revision conflictの結果と同じtransactionでimmutable receiptをcommitする。receiptはkey、hash、actor/target ID、action、result、timestampだけのappend-only auditである。同じkeyと同じpayloadのretryは保存済み結果を返し、別payloadなら409となる。別keyの同一targetもserializeするため、grant versionとcategory revisionを並行commandで迂回できない。

NIHO callerは次を守る。

1. commandごとに現在のplatform ADMINを検査し、その安定NIHO user IDをactor headerへ設定する。
2. verified identityと招待受諾をNIHO側で確認し、writerごとに永続的で単調増加する`sourceVersion`を割り当てる。
3. outbox retryでは同じidempotency keyと同じpayloadを維持し、送信ごとに短命なservice account ID tokenだけを新しく発行する。
4. ExperienceのACKを受けるまで管理UIを成功表示にしない。timeout後の同一command replayは安全である。

NIHO側のADMIN UI、招待、outboxはこのリポジトリでは実装しない。

## editor.niho.life の公開 API を読む（#252 #253・editor v1 契約）

[#252](https://github.com/niho-life/niho-experience/issues/252) は `/guides`・`/guides/{slug}`・トップの Kamakura Journal・体験詳細の関連記事・sitemap の読み取り元に editor.niho.life の公開 API を足し、[#253](https://github.com/niho-life/niho-experience/issues/253) は下書きのプレビューと発信先の条件の宣言を足す（Epic #251、editor 設計 §8・§9）。**editor 公開（設計 §14 の段階 3）が本番で使えるまで、どの環境でも `EXPERIENCE_GUIDE_PUBLIC_SOURCE=editor` を有効にしない。** 記事の正本を editor に置く判断は [ADR 0002](adr/0002-guide-content.md) の「2026-10-30」。

契約は niho-editor の v1 で確定した（正本: `docs/security/editor-publish-api-v1.md` と型・検証・合成例の `packages/editor-publish-contract`）。当初は設計文書からの**仮契約**で実装していたが、このリポの読み取り側を v1 に合わせた（Epic #251）。パス・項目名・形の読み取りは `apps/web/src/lib/editor-publication/contract.ts` の1ファイルに閉じ込めてあり、契約が変わるときはまずこのファイルとテスト（`contract.test.ts`、fixture）を直す。

Secret Manager・配備 workflow への `GUIDE_EDITOR_API_*` の配線は、editor 公開が本番で使えるまで行わない（変更なし）。NIHO の面の資格は、現行の editor では不透明な Bearer 資格（editor 側に SHA-256・audience `exp`・期限だけを置く暫定の方式。署名つきのサービス間 token の契約ができるまで）で、これまでの固定の `Authorization: Bearer ${GUIDE_EDITOR_API_TOKEN}` のまま読める。ただし**資格には期限がある**。期限切れ・失効・再発行前の旧資格は 401 で、キャッシュがあっても必ず失敗させる（下記）。資格の払い出しと期限切れ前の入れ替えは配備の運用に入れる。`api.editor.niho.life` の DNS・ALB は別作業。

### 契約（editor v1）

- base URL は設定値 `GUIDE_EDITOR_API_BASE_URL`（版のパスを含む。editor は `https://api.editor.niho.life/v1`）。以下 `{base}`。handle は `exp`（NIHO Experience の予約語。面の資格は自分の面の handle だけ読める）。
- `GET {base}/exp/published.json?limit=100&include=unlisted[&cursor=…]` → `{ "contractVersion": "1", "items": [ListItem, …], "nextCursor": string | null }`（`updatedAt` の新しい順、同時刻は `id` の昇順）。`nextCursor` が null になるまで辿る。`include=unlisted` を付けたときだけ限定公開が載る。
- `GET {base}/exp/published/{id}.json` → ListItem ＋ `blocks`・`markdown`・`assets`・`contractVersion`。公開をやめた記事は 410（`movedTo` が付くことがあるが使わない）、未知・資格なしは 404。
- `GET {base}/preview/{token}.json` → 下書き（PublishedDoc ＋ `preview`）。token は `pv_` ＋ base64url 43 文字で、有効期限は発行から 15 分以内。
- 認証は `Authorization: Bearer ${GUIDE_EDITOR_API_TOKEN}`。`ETag` / `If-None-Match` を使う。`403` は使われず、資格のない handle は 404、資格なし・期限切れは 401。エラーの本体は `{ "error": { "code", "requestId", "retryable" } }`。

| 型 | 項目 | 受け取り方 |
| --- | --- | --- |
| 一覧の本体 | `contractVersion` | `"1"` 以外・欠落は**応答全体**を契約違反として失敗させる。`items` が配列でない、100件超、`nextCursor` が null でも `^[A-Za-z0-9._~-]{1,512}$` でもない場合も同じ |
| ListItem | `id` | 不透明ID（editor は UUID）。`^[A-Za-z0-9_-]{1,128}$` |
| | `slug` | 小文字英数字と単一ハイフン、80文字以下（editor の上限は160。80超はこのサイトでは読み飛ばす）。`preview` は `/guides/preview` と衝突するため拒否 |
| | `dest` | `exp` 以外は読み飛ばす（理由 `dest is not exp` をログに出す）。欠けも読み飛ばす |
| | `range` | `live`（一覧・sitemap・体験導線に出す）か `unlisted`（直URLだけ・noindex）。欠け・未知値は契約違反 |
| | `lang` | `en` 以外は読み飛ばす（editor は `ja` も流せる） |
| | `title` / `lead` | `title` は必須・110文字以下。`lead` は null・空を読み飛ばし、160文字以下（`GUIDE_LIMITS`）。`lead` は記事の description |
| | `cover` | null か Asset。null は表紙なし |
| | `category` | `string \| null`。**null は読み飛ばす**（このサイトの公開条件でカテゴリは必須）。文字列は slug の形（小文字英数字とハイフン、80文字以下）だけ受け、表示名は slug から導く（`day-trips` → `Day trips`）。並び順は付かず最後（1000）。**editor にカテゴリの入力欄ができるまで editor 起点の新規記事はここを通らない**（下の「残る差」） |
| | `author` | `{ name, handle \| null, url \| null }`。`name` だけ使う。`handle`・`url` は読むが保持も表示もしない |
| | `publishedAt` / `updatedAt` | ISO 8601 の日時。表示とsitemapは日付部（`slice(0, 10)`）。`updatedAt` は「いまの公開版を公開した時刻」（下書きの編集では動かない） |
| | `canonicalUrl` | 受け取っても信頼しない。canonical は常に `SITE_URL` + `/guides/{slug}` |
| | `related` | 体験slugの形のものを重複除去して使う（申告で、認可の根拠にならない）。一覧の値を正とし、本文の取得結果からは読まない |
| | `version`・`extras` | 使わない |
| Full | ListItem ＋ `markdown`、`blocks`、`assets`、`contractVersion` | 本文は `markdown`（editor の AST の投影）を既存の safe Markdown renderer で描画する。`blocks` は配列であることだけ確かめ、中身は読まない。HTML文字列は受けない。`id`・`dest`（`exp`）・`contractVersion`（`"1"`）が一覧と合わない記事は読み飛ばす |
| Asset | `{ id, url, contentType, bytes, sha256, alt, credit \| null }` | `url` は https かつ許可 origin だけ。**寸法も `licensed` も契約に無い**（下の「写真」）。`alt` は空文字がありうる。`credit` は写真直下のキャプションに使う |
| Preview | `title`・`markdown` だけ必須 | 他は欠けても不正でもよい（`preview.expiresAt` は読まない）。`dest` または `preview.dest` が `exp` 以外なら 404、`contractVersion` が `"1"` でなければ書き手に理由を返す |

一覧の項目（とくに `range`）は一覧を正とし、本文の取得結果は本文だけに使う。本文を `updatedAt` ごとに保持しても、古い `range` で表示しない。

#### 写真

editor の Asset には寸法と共有の権利の宣言が無い。このサイトでは次のように扱う（掲載許諾の規則は落とさない）。

- **`licensed` は常に false**。従来の「`true` の明示宣言だけが OG・`Article.image` を許す」規則を保つので、editor 記事の表紙は記事ページにだけ出て、OG 画像と構造化データの `image` には出ない。editor の公開条件の `cover.consent`（掲載許諾）は「ページに載せてよい」の確認で、共有（OG・構造化データ）の権利とは分けて扱う。
- 寸法が無いので表紙は名目の 1600×900 で描く（`EDITOR_COVER_ASSUMED_SIZE`）。実画像の比率は `h-auto` が使うが、16:9 でない画像は読み込み後にレイアウトがずれうる。
- `alt` が空の表紙は装飾画像として扱う。`sha256`・`bytes`・`contentType` は形を確かめるだけで、画像の複製や検証はしない（写真は許可 origin から直接読む）。

#### 著者

editor の著者は `{ name, handle, url }` で、`role`・`bio` が無い。表示は名前だけ（`name · Published`、フッターも名前のみ）、Article JSON-LD の `author` も名前だけ（`jobTitle` は役割があるときだけ）。静的・database の記事は従来どおり役割と紹介文が必須。

### 設定

| 設定 | 内容 |
| --- | --- |
| `EXPERIENCE_GUIDE_PUBLIC_SOURCE=editor` | http mode 限定。mock mode では選べず `static` のまま |
| `GUIDE_EDITOR_API_BASE_URL` | 必須。https のみ（ローカルの fixture 用に loopback の http だけ例外）。末尾 `/` は除く |
| `GUIDE_EDITOR_API_HANDLE` | 必須。`exp` のみ（このサイトは面 `exp`。他の handle は発信先が `site` になり1件も読めないため、起動時に失敗させる） |
| `GUIDE_EDITOR_API_TOKEN` | 必須。server-only の秘密。`NEXT_PUBLIC_*`・HTML・JSON-LD・ログ・エラーへ出さない。editor の面の資格（`exp`）。期限と入れ替えは配備の運用 |
| `GUIDE_EDITOR_ASSET_ORIGINS` | 任意。写真を配信する https origin のカンマ区切り。未設定なら base URL の origin だけ（editor の写真は別の origin から配られるので、実際には明示する） |

必須の3つのどれかが無い、または形が不正なら起動時に失敗する。static・mock・ローカル画像へ黙って fallback しない。

### 表示と取得の振る舞い

- editor 時は静的 `PUBLISHED_GUIDES`・mock sample・下書き・既存の unlisted editorial preview を一切使わない（同一 slug の二重表示なし）。`/guides` は database と同じくカテゴリ棚で並べる。
- 一覧を `nextCursor` が null になるまで辿り（1ページ100件、最大50ページ。超過・同じ cursor の再出現は契約違反で失敗）、`live` の本文を同時6件までで取得して記事にする。初期HTMLに本文・metadata・JSON-LD が出る。
- 応答はインスタンスごとのメモリに URL 単位で持つ。30秒以内は再取得せず、その後は `If-None-Match` で再検証し 304 なら再利用する。本文は一覧の `updatedAt` が同じ間は取得しない。Next の data cache は使わない（`cache: "no-store"`）。タイムアウト5秒、一覧（1ページ）2MB・本文/プレビュー1MBの上限。再ビルドなしで公開・更新・停止が次の再検証で反映される。
- ネットワーク障害・タイムアウト・5xx・429 のときだけ、最後に確認した版を最大10分まで返す（失敗後30秒は再試行せず待たせない）。10分を超えたら記事ページ・`/guides`・sitemap は失敗する。フッターのリンク・トップの Journal・体験一覧と詳細の関連記事だけは記事を隠して表示を続け、予約導線を巻き込まない。
- 401/403 は「記事が無い」ではなく設定・認証の不具合として、キャッシュがあっても必ず失敗させる。**一覧の 404/410 も同じ**（v1 は資格のない handle を 404 にするため、「記事が0件」と区別できない）。
- 1記事の契約違反、slug 不正・予約語・重複（新しい方を残す）、category が null・slug の形でない、Markdown が subset 外、図・カバー・資産の URL が https の許可 origin でない、`niho-guide-asset:` 参照、本文の 410/404 は、その記事だけを読み飛ばし、`console.error` に ID・slug・理由（項目名だけ）を出す。本文・トークン・URL・クエリは出さない。
- `CONFIRM` の印は既存のパーサーどおり描画する（受信時の拒否条件にはしない。公開前の条件として宣言する）。
- 一覧に無い `/guides/{slug}`（公開停止・未公開・綴り違い）は、slug が妥当で `/guides` に記事があれば `/guides` へ 307 で転送する（再公開は同じ URL なので恒久転送にしない）。`/guides` が空なら 404。不正な形の slug は通信せず 404。editor が返す `movedTo`（NIHO の別の面へ移した記事の 410）は使わない。
- `unlisted` は直URLだけで読め、`noindex, nofollow`。一覧・sitemap・トップ・体験導線には出さない。

### 本文（Markdown と囲み）

editor の本文は AST が正本で、`markdown` はその投影（`##` `###`、段落、`-` / `1.`、独立した行の `![alt](src "caption")`、`:::note` … `:::`、`**` `*` `[text](href)` `[CONFIRM: …]`、句読点の `\` エスケープ）。この範囲は `lib/guide-markdown.ts` が受ける範囲に合わせて作られており、editor の囲み（`note`）は `:::note`（段落と箇条書きだけ）に投影され、experience では `note` ブロックとして描画される。引用は段落に、区切り線は省略、取り消し線・コードは素のテキストに投影される（見た目の意味が消えるので、宣言で受けないと伝える）。editor の合成例の `markdown` をそのまま `parseGuideMarkdown` に通すテストで固定してある（`markdown-compat.test.ts`）。

囲み・エスケープ・`%28` を含む URL は既存のパーサーでそのまま通ったが、editor が太字かつ斜体の文字に出す `***both***`（と `***a** b*`・`***a* b**`・`**a *b***`・`*a **b***`）だけは拒否され、記事ごと読み飛ばされていた。そのため `lib/guide-markdown.ts` がこれらを受けるようにした（同時に閉じるときは太字が外側）。パーサーは静的・database の記事と共有なので、これらの記法はそちらでも書ける（以前は拒否）。`****`・空白つきの `***`・閉じていない `***` は従来どおり拒否（fail-closed）。

### プレビュー（#253）

- `/guides/preview?token=…` は `GET {base}/preview/{token}.json` をキャッシュなし・同じ認証で読み、通常の記事ページと同じ部品（`components/pages/GuideArticle.tsx`）で描画する。「Preview from editor.niho.life · not published · link expires soon」を出し、JSON-LD は出さない。
- トークンなし・形式不正（`^pv_[A-Za-z0-9_-]{43}$` 以外）・失効（404/410）・source が editor 以外は 404。401/403・5xx・タイムアウトは 500 で、古い下書きは返さない。
- 下書きは条件を満たさなくてよい（リード・カバー・カテゴリ・著者・関連体験の欠けは既定値で埋める）。安全性の検査は公開版と同じで、Markdown が通らなければ行番号つきの理由を 200 で返す（トークンを持つ書き手向け）。
- 応答は `Cache-Control: private, no-store`、`X-Robots-Tag: noindex, nofollow`、`Referrer-Policy: no-referrer`、metadata の robots も noindex。robots.txt は `/guides/preview?` を disallow する（`/guides/preview-…` という slug は塞がない）。sitemap・一覧・内部リンクにプレビューURLを出さず、計測（Umami）は対象外のパスとして送らない。
- **トークンの取り扱い注意**：トークンは URL のクエリにあるため、Cloud Run のリクエストログ（と前段の CDN・proxy のログ）に残りうる。コードでは防げないので、editor 側のトークンは短命・単一記事・読み取り専用を前提にする（v1 は発行から15分以内、1つの page・1つの dest に拘束し、token だけでは読めない）。`next dev` は開発時だけリクエスト URL を端末に表示する。アプリ自身のログ・エラー・例外はトークンとURLを含めない。

### 書き手の入口（#254）

公開サイトのフッター「For writers」とホストの画面の「記事を書く」（PC のサイドバーの下、スマホのアカウントのメニュー。商品運営者には出さない）は、`GUIDE_EDITOR_SITE_ORIGIN` を設定したときだけ出て、その origin へ飛ぶ。値は https の origin だけ（パス・クエリ不可、ローカル開発の loopback の http だけ例外）で、形が不正なら起動時に失敗する。未設定なら両方とも出ない。editor.niho.life がまだ開けない間に壊れたリンクを出さないためで、公開の source flag とは独立している（書き手は公開元の切替より先に editor で書き始められる）。

### 発信先の条件の宣言（#253）

`GET /api/public/guides/publication-requirements` は、editor が「公開の前に」で読む**発信先の宣言**（editor の `DestinationDeclaration`、`schemaVersion: 1`）を返す（source flag に関係なく常に配信、秘密なし、`Cache-Control: public, max-age=300`、`Access-Control-Allow-Origin: *`、`X-Robots-Tag: noindex`）。editor は配備設定 `EDITOR_DESTINATION_DECLARATIONS`（JSON `{"exp": "<この URL>"}`）の https の URL から読む。editor の語彙は閉じていて、**未知の `kind`・未知の欄・型の違いは宣言ごと拒否され、experience は「いまは公開できません」になる**。このサイトの宣言は editor の検証規則を写したテスト（`requirements.test.ts`）で固定してある。

中身は `id: "exp"`、`label`、`host`（`SITE_URL` のホスト）、`path: "guides"`（URL は `https://{host}/guides/{slug}`）、`ranges: ["live", "unlisted"]`、`extras: []`、`accepts`（ブロックは段落・見出し・箇条書き・図・囲み、マークは太字・斜体・リンクだけ）と `requires`。editor の `kind` との対応:

| 条件 | 仮契約の `kind`（旧） | editor v1 の `kind` | 備考 |
| --- | --- | --- | --- |
| 英語 | `lang`（`equals: en`） | `lang`（`equals: "en"`） | |
| カバー（掲載許諾あり） | `cover`（`required`・`requireLicensed`） | `cover`（`consent: true`） | 共有の権利ではなく掲載許諾（上の「写真」） |
| リード | `lead`（`required`・`maxLength`） | `lead`（`max`） | 上限は `GUIDE_LIMITS`（160） |
| 題名 | `title`（`maxLength`） | **該当なし** | v1 に kind が無いため宣言から外した。110文字超は受信時に読み飛ばす |
| カテゴリ | `category`（`required`） | `category`（`oneOf` なし） | 入力欄は editor 側に無い（下の「残る差」） |
| 見出し1つ以上 | `min-headings`（`min`） | `headings`（`min`） | |
| `CONFIRM` なし | `no-confirm-marker` | `noConfirm` | |
| 関連体験が掲載中 | `related-experiences-listed`（`lookup`） | `relatedLive` | 外の事実は editor がサーバーの `facts` として渡す。`lookup` は不要 |

experience が受信時に再確認するのは安全に関わるもの（英語、Markdown subset、https の許可 origin の写真）と、宣言できない上限（題名110・slug80）だけで、編集上の条件は editor の公開前チェックに任せる。関連体験の再判定（権限・掲載状態）は #255。

### 切替・切戻し

1. 段階 3 の editor 公開 API が staging で使えることを確認し、合成記事で live / unlisted / 公開停止 / 更新 / 410、ETag の 304、401 の失敗、10分の stale 上限、プレビューの 404 と no-store を確認する。
2. 専用の配備変更で `EXPERIENCE_GUIDE_PUBLIC_SOURCE=editor` と上の設定を渡す。トークンは Secret Manager から渡し、公開出力に出さない。editor 側で `EDITOR_DESTINATION_DECLARATIONS` にこのサイトの宣言の URL を設定し、`EDITOR_FACE_CREDENTIALS` に `exp` の資格（SHA-256・期限）を入れる。
3. 切戻しは新しい revision で `EXPERIENCE_GUIDE_PUBLIC_SOURCE` を `database`（受入済みの場合）か未設定（`static`）へ戻す。editor 側のデータは消さない。

### ローカルで確かめる

合成 fixture（`apps/web/src/lib/editor-publication/fixtures/editor-publications.json`、`*.example` だけ。v1 の形で、handle は `exp`）を配る fixture サーバーがある。live 3本（うち1本は本文 410）、本文が 410 で `movedTo` つきの1本、unlisted 1本、契約違反の負例（dest 違い・range 欠落・http のカバー・`javascript:` のリンク・不正/予約/重複 slug・外部ホストの図・内部 asset 参照・日本語・category が null・lead が null）、プレビュー用の下書きを含む。

```sh
node apps/web/scripts/editor-publication-fixture-server.mjs   # http://127.0.0.1:4319/v1
# 別の端末で（体験の公開APIは無くても記事ページは描画できる）
EXPERIENCE_API_MODE=http EXPERIENCE_GUIDE_PUBLIC_SOURCE=editor \
GUIDE_EDITOR_API_BASE_URL=http://127.0.0.1:4319/v1 GUIDE_EDITOR_API_HANDLE=exp \
GUIDE_EDITOR_API_TOKEN=synthetic-fixture-token-not-a-secret GUIDE_EDITOR_ASSET_ORIGINS=https://assets.editor.example \
NEXT_PUBLIC_NIHO_WEB_ORIGIN=http://127.0.0.1:4392 SITE_URL=http://127.0.0.1:3000 \
npm -w @niho-experience/web run dev
```

サーバーは v1 と同じく、Bearer の不一致を 401、資格のない handle を 404、未知・重複した query や不正な `limit`・`include`・`cursor` を 400 にし、`include=unlisted` が無ければ限定公開を載せず、`nextCursor` でページを返す。`EDITOR_FIXTURE_PAGE_SIZE=4` で1ページの件数を小さくできる（一覧が複数ページになる）。

同じ組み合わせ（fixture サーバー、NIHO の公開 API の合成 mock、http mode のサイト）を Playwright が立てて確かめる：`npm -w @niho-experience/web run test:e2e:guide-editor`（CI の e2e job でも実行。`playwright.guide-editor.config.ts`。1ページ4件で起動するので、ページを辿ることも通る）。一覧と sitemap は live 3本だけ、限定公開は noindex、公開をやめた記事と未知の slug は `/guides` へ 307、不正な slug は 404、初期 HTML に本文・canonical・Article JSON-LD、editor の表紙は `licensed: false` なので OG 画像と JSON-LD の `image` が出ない、著者は名前だけ（`jobTitle` なし）、プレビューは noindex で JSON-LD・canonical なし、失効・別の発信先・トークンなしは 404、条件の宣言、フッターの「For writers」。プレビューの HTML では、Next のルーターが `<script>` に要求された URL（アドレスバーと同じ値）を埋めるのでトークンがそこには現れる。リンク・画像・meta・canonical に出ないことを確かめている。

手で見るときは `/guides`、`/guides/sample-evening-walk`、`/guides/sample-direct-link-only`（noindex）、`/guides/sample-http-cover`（`/guides` へ転送）、`/guides/preview?token=pv_synthetic-preview-not-a-secret-draft-000001`（条件未達の下書き）、`…-000002`（Markdown エラー面）、`…-000003`（別の発信先で 404）、失効のトークン（404）を確かめる。`EDITOR_FIXTURE_STATUS=503` で起動すると障害時の stale を、`EDITOR_FIXTURE_PORT` でポートを変えられる。写真は `*.example` の URL なので読み込まれない。

### v1 に合わせた記録と残る差（Epic #251）

仮契約（niho-docs#40 の本文と設計 §9 からの想定）からの変更点:

| 項目 | 仮契約 | 確定 v1（いまの実装） |
| --- | --- | --- |
| 一覧の本体 | `{ items }` | `{ contractVersion, items, nextCursor }`。`contractVersion` が `"1"` でなければ失敗（fail-closed）。ページを辿る |
| `dest` | `niho-experience` | `exp`（handle も `exp`） |
| 限定公開 | 一覧に `range: unlisted` で載る | `include=unlisted` を付けたときだけ載る（付けて読む） |
| 本文 | `markdown` を描画 | 同じ（AST が正本で `markdown` はその投影。`blocks` は読まない） |
| 認可の失敗 | 401/403 を失敗 | 同じ。加えて資格のない handle は 404 なので一覧の 404/410 も失敗 |
| 著者・写真 | `author { name, role, bio }`、写真に寸法・`licensed` | `author { name, handle, url }`（名前だけ表示）。写真に寸法・`licensed` が無い（名目寸法・`licensed: false`） |
| カテゴリ | `{ slug, label, order? }` | `string \| null`（slug から表示名を導く） |
| 認証 | 固定の Bearer | 面の資格（現行 editor では不透明な Bearer。期限あり）。名前・配線は `GUIDE_EDITOR_API_TOKEN` のまま |
| 公開条件の語彙 | `min-headings`・`no-confirm-marker`・`related-experiences-listed` ほか独自の形 | editor の `DestinationDeclaration`（`headings`・`noConfirm`・`relatedLive` ほか。閉じた語彙） |
| プレビュー token | `^[A-Za-z0-9_-]{16,256}$` | `^pv_[A-Za-z0-9_-]{43}$` |

**残る差・オーナー判断が要る点**（勝手に緩めていない）:

1. **カテゴリ**：このサイトは category が必須だが、editor には入力欄が無い（`docs/architecture/editor-publish-core.md` は「シートに出していないもの：カテゴリ・関連する体験の欄」）。このままだと editor 起点の新規記事は `category` が null で、宣言の条件（`category`）も満たせず**公開できない**。選択肢：(a) editor に入力欄を足し、宣言の `category` に `oneOf`（experience のカテゴリ一覧）を付ける（別リポ。推奨：書き手に選ばせ、表示名と並び順の正本を experience に置ける）、(b) experience で必須を緩め、カテゴリ無しは「未分類」の棚に出す（棚の表示が増える）、(c) 当面はカテゴリ無しを出さず、editor の欄ができるまで公開元を `editor` にしない。
2. **共有の権利と OG 画像**：editor v1 は写真の共有権利を宣言しないので OG・`Article.image` は出ない。editor が Asset に明示の宣言（例：共有可否）を足せば、`licensed` に写像する。
3. **写真の寸法**：契約に無い。editor が `width`・`height` を Asset に足せば名目値をやめられる（互換を壊さない追加）。
4. **著者の役割・紹介文・プロフィール URL**：契約に `role`・`bio` が無く、`handle`・`url` は使っていない。著者ページを作る判断は別。
5. **「体験ページに載せる」（`extras.xp`）**：未対応。宣言は `extras: []` で、editor に選択肢を出さない。関連体験を選べば、体験の詳細に記事が出る（従来どおり）。
6. **`movedTo`**：NIHO の別の面へ移した記事の 410 に付くが、旧 URL から新 URL への転送は実装していない（`/guides` へ 307）。
7. **`checkedOn`（確認日）**：v1 に無いので editor 記事では表示しない。
8. **画像の複製と `sha256`**：editor の仕様は「本人のサイトは取り込むときに複製する」だが、面の experience は許可 origin から直接読む。availability は editor の写真置き場に依存する。
9. **面の資格**：editor は署名つきサービス間 token の契約ができるまでの暫定の方式。置き換わるときは `client.ts` の認証だけを直す。
10. **見出しの数え方**：editor の `headings` 条件は `##` と `###` を数えるが、このサイトの目次は `##` が前提。`###` だけの記事は目次が空になりうる（表示は崩れない）。
11. **未配備**：`api.editor.niho.life` の DNS・ALB、本番の flag・Secret の配線、editor の NIHO ログイン。

### 契約が変わったときに直す箇所

- `contract.ts`：パス、項目名、`range`・`dest`・`lang` の値、Asset と `licensed`／寸法の写像、カテゴリの読み取り。
- `client.ts`：認証方式（いまは Bearer）、ページング、410/404 の使い分け。
- `requirements.ts`：宣言の `kind` と欄（editor 側の閉じた語彙に合わせる。未知はすべて拒否される）。
- `convert.ts`：表示モデルへの写像（著者・表紙・カテゴリ）。
- fixture とテスト、この節。
