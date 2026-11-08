# Guide CMS の非公開写真と関連体験

## 方針の変更（2026-11-07、#476）

オーナー判断で、記事は experience.niho.life の `/write` で書き、正本は Experience DB に戻す。editor.niho.life から Experience への公開は止める。体験の OWNER は NIHO のライター権限なしで書ける。OWNER 以外のライターは NIHO のライター権限と記事連携を使う。決定の全体は [ADR 0002 ガイド記事](adr/0002-guide-content.md)の「2026-11-07」を正とする。

Store の書込みは #477、`/write` の画面と入口は #478 で追加済み。#479 で公開元をExperience DBへ切り替える配備境界と旧静的記事の移行手順を確定した。#480 では旧Editor公開API・プレビュー・関連設定を撤去し、保存済みDBデータは保持する。非OWNER writerの権限と招待同意フローは #481 が残っている。

## Store の現行書込み境界（#477）

`GuideRepository` の下書き・公開・停止・非公開写真操作は、記事が属する提供者の **現在 active な OWNER** だけに許す。作成者 ID と封印済み公開版の発行者 ID は履歴として固定し、別の OWNER が編集・写真追加しても書き換えない。旧 writer grant、記事連携の招待、EDITOR/VIEWER はこの書込み権限にも公開関連記事の権限にも使わない。将来の本人 ID 移行では確認済みの ID 対応を経由し、メールアドレスだけで履歴を統合しない。

下書きは空のタイトル・未完成の表紙・日本語メモを保存できる。公開時だけ英語宣言、タイトル、見出し・本文、カテゴリ、写真の Web 掲載確認を検査し、封印済み版を新規に作る。公開済み記事の下書きを更新しても表示中の版は変わらない。公開処理の同一 OWNER・同一 revision・同一公開範囲での直後の再送は同じ版を返す。運営停止 `OPS_STOPPED` は通常の停止と別状態で、監査付き運用手順による解除までは OWNER が公開できない。詳細は [Store README](../packages/experience-store/README.md) を参照。

## 現在の経路（2026-11-08、#479）

記事は Experience の `/write` と現行 `GuideRepository` で作成・公開し、Experience DB の current sealed publication を旅行者向けSSRの正本にする。`/write` はホスト画面と同じ現行ログインを使い、毎操作で記事提供者の active OWNER membershipを確認する。旧writer grantや招待台帳、editor app-connect、静的モジュールを現在権限や公開のfallbackにしない。

非OWNER writerと記事連携の招待・同意・取消はNIHOが正本であり #481 で接続する。#479 の切替では現在OWNERだけをwriterとして受け入れる。OWNER変更・体験停止では関連表示を次要求から隠すが、封印済み記事本文は保持する。商品・予約・顧客・売上への権限は生まれない。

現在activeなカテゴリは`/write`で選ぶ。公開直前にも現在性を確認し、表示名・順序を公開snapshotへ固定する。停止済みカテゴリの過去記事は残す。カバー写真とリードは任意で、入力された値の長さ・画像形式・掲載許諾は検証する。

現行の契約・設定・段階配備はこの文書のStore境界とdatabase gateを正とする。旧grant/outboxは保存済みデータと過去実装の履歴であり、新規執筆・認可経路には使わない。


> 2026-11-08: #477でOWNER向け`GuideRepository`書込み、#478で`/write`画面とサイト内入口、#479でDB公開元を導入した。#480は旧`/editor`を410のまま維持しつつEditor向け公開・preview API、設定、CI経路を撤去する。保存済みDBデータは保持する。非OWNER writer連携は#481で扱う。

[#215](https://github.com/niho-life/niho-experience/issues/215) では英語記事に任意のカバー写真を1枚だけ設定し、[#216](https://github.com/niho-life/niho-experience/issues/216) で同じ非公開asset境界を本文写真へ拡張した。[#189](https://github.com/niho-life/niho-experience/issues/189) は公開SSRと公開画像配信を実装するが、`EXPERIENCE_GUIDE_PUBLIC_SOURCE=database` まで既存の静的表示を維持し、公開 media route は404のままにする。

## データと権利の境界

- `/write` はホストと同じExperienceログインを使い、JPEG/PNGをExperience経由でprivate bucketに保存する。ブラウザへ署名URL、bucket名、object key、GCS URL、原本は渡さない。
- server は入力を 10MB・16MP・各辺 12,000px までの単一画像に制限し、magic と decode 結果を検査する。orientation を適用し、長辺 2400px 以内の sRGB JPEG に再エンコードする。EXIF・ICCその他の metadata と原本は保存しない。
- HEIC は production Linux の対応を契約していないため非対応とし、JPEG/PNGへの変換を案内する。対応していない形式を黙って受け入れない。
- asset ID は UUID v4 の不透明IDで、article と creator に固定する。状態は `UPLOADING` → `READY` または `REVOKED`。認証済み画像 read も毎回ホストsession、現在OWNER、記事とassetのscope、`READY` を再検査し `private, no-store` で返す。
- draft が持つのは asset ID、英語 alt、公開クレジット、Web掲載確認だけ。SNS・OG利用の同意には使わない。
- 公開時は記事行と asset を同じ transaction で lock し、revision、所有、article/creator scope、`READY`、Web掲載確認、非失効を再検査する。`guide_publication_media` に表示情報を snapshot してから publication を seal する。失敗時は記事 draft と旧公開版を維持する。
- 公開 read は snapshot に加えて現在の asset が `READY` の場合だけ cover metadata を返す。権利取消または公開停止後は返さない。publication snapshot 自体は監査用に変更しない。
- 掲載権利の取消は同じDB transactionで下書きからも写真を外し、revisionを更新する。通常の「記事から外す」は権利を取り消さない。公開済み・権利取消済みのobjectは保持期間が決まるまで物理削除しない。upload失敗後の未公開objectだけ削除を試み、削除に失敗した `REVOKED`・`ready_at IS NULL` assetは運用で再確認する。

## 配備ゲート

現行 `/write` とホストログインを候補revisionで受け入れる。bucket が未設定なら `DATABASE_GUIDE_PUBLICATIONS_ENABLED` の配備前検査で止め、実行中にstorageを読めない場合は公開画像routeを503とし、mock成功やローカル保存へfallbackしない。

database公開元を受け入れる候補 revision では、次を先に満たす。

1. 専用 GCS bucket を作り、Uniform bucket-level access を有効化し、Public access prevention を `enforced` にする。allUsers / allAuthenticatedUsers と object ACL は使わない。
2. Cloud Run runtime service account だけに、その bucket に限定した `roles/storage.objectUser`（object create/get/deleteに必要）を付与する。deployer、GitHub Actions、preview、ブラウザには付与しない。
3. bucket 名を server-only の `GUIDE_MEDIA_BUCKET` に設定する。値を `NEXT_PUBLIC_*`、HTML、ログ、エラー、GitHub変数の公開出力へ出さない。
4. `0009_guide_media.sql` を適用し、合成 JPEG/PNG の upload・private read・draft保存・公開・権利取消・404 public route を staging で確認する。実顧客写真を受入証跡に添付しない。

bucket の CORS や公開 CDN は設定しない。#189 で public SSR/画像配信を接続するときも、現在の権利を再検査する server route を先に設計し、draft object keyを公開URLへ転用しない。

## 公開SSRと画像配信（#189）

- http modeで `EXPERIENCE_GUIDE_PUBLIC_SOURCE=database` を明示したときだけDB publicationを公開元にする。公式配備では `DATABASE_GUIDE_PUBLICATIONS_ENABLED=true` がこの値と専用 `GUIDE_MEDIA_BUCKET` を同時に設定する。`EXPERIENCE_DATABASE_URL` またはbucketが無ければ配備前と起動時に失敗し、静的記事・mock・ローカル画像へfallbackしない。http/static の `PUBLISHED_GUIDES` は空で、mockだけが合成 `SAMPLE_GUIDES` を使う。
- 一覧は現在のsealed `PUBLIC` publicationだけ、詳細は`PUBLIC`または直URLを知る`UNLISTED`だけを読む。draft、`STOPPED`、過去publicationは公開しない。database modeでは静的記事をunionしない。
- `/api/public/guides/media/{assetId}` は匿名GETだけを持つ。現在`PUBLISHED`の記事のcurrent publicationにsnapshotされた、現在`READY`のassetだけをprivate bucketからJPEGとして返す。object key・bucket名・署名URLをレスポンスへ出さない。unknown、old publication、`REVOKED`は404、bucket/DB/read異常とbyte不一致は503とする。
- JPEG応答は `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex` とする。HTML・metadata・sitemapもrequestごとにDBを読み、ISR、Nextの永続cache、CDN HTML/media cacheを使わない。React `cache` は同一request内の重複読取だけに使う。
- coverと本文figureのURLはopaque asset IDのrouteだけ。Markdownの内部asset参照は現在READYのsnapshot placementと交差したものだけ解決し、取消直後の次requestで画像を消す。Web掲載確認をSNS/OG許諾へ拡張せず、DB写真はOG metadataと`Article.image`へ出さない。
- 記事→体験はpublication linkの現在権限、現在`PUBLISHED` productと現在slugを再評価し、さらに旅行者向け公開catalogと交差する。体験→記事も同じ現在有効linkを持つ`PUBLIC` publicationだけを使う。

## 非OWNER writerとの記事連携（#481）

記事連携の正本はNIHO。ホストのExperience画面から現在のNIHO権限へ招待・取消を中継し、writerはNIHOログイン後に `/write` で承諾・辞退する。#481ではこの非OWNER経路を実装する。Experience DBのcurrent OWNER確認は引き続き `/write` の権限境界とし、writer権限を体験の予約・顧客・売上へ広げない。旧`guide_writer_grants`と`guide_link_invitations`は履歴として残し、現在権限には使わない。

## database flagを開く前のゲート

1. `0067_guide_provider_ownership.sql` までの全migrationをファイル名順にstagingへ適用する。現行ホストログインで対象提供者の active OWNER を確認し、category、article、asset、publicationを実DBへ投入する。`kamakura-after-4-pm` は下記opsをまずdry-runし、同じtransactionで `guide_legacy_slug_reservations` を外して `UNLISTED` 初版を作る。実provider/OWNER ID・DB URL・object keyをGit、CI、公開ログへ残さない。
2. private bucketのUniform bucket-level access、Public access prevention、runtime SA限定IAM、`GUIDE_MEDIA_BUCKET`を確認する。bucket CORS、公開ACL、公開CDNは作らない。
3. stagingの現行ホストログインから active OWNER が新規保存・再訪・公開・公開後更新・通常停止を行えること、membership失効直後は読書きできないことを確認する。旧editor app-connectは受入条件にしない。
4. 実DBの `PUBLIC` / `UNLISTED` / draft / `STOPPED` を確認する。`UNLISTED` は直URLが200かつnoindexで、一覧・トップ・フッター・sitemap・関連記事から除外される。静的記事や合成sampleがhttpの一覧・直URL・トップ・sitemapへ混ざらないことを確認する。
5. 非公開bucketの実画像でcover/本文、再訪、公開更新、過去publication、写真権利取消直後の404を確認する。画像/storage障害は画像routeだけ503/no-store、DB障害はトップ・体験詳細・予約入口を維持して記事枠だけ隠し、`/guides` と詳細は再試行面、sitemapは失敗とする。どこにも静的fallbackしない。
6. Cloudflareは`/guides*`、公開media route、HTML、sitemapをbypassし、`CF-Cache-Status` がHITでないことを確認する。HTML/JSON/logにbucket/object keyや非公開入力を出さない。

`/write` で実書込みを始めた後は `static` へ戻さない。切戻しはデータを消さず、同じDB schemaとpublicationを読める既知のrevisionへトラフィックを戻す。`DATABASE_GUIDE_PUBLICATIONS_ENABLED` が未設定・不正なら配備前に失敗させる。

staging の公式 workflow は実行者がオーナーなら GitHub environment `host-staging-owner`、それ以外なら `host-staging` の `STG_*` 変数を読む。公開元を変える際は両 environment の `STG_DATABASE_GUIDE_PUBLICATIONS_ENABLED=true`、`STG_GUIDE_MEDIA_BUCKET=<専用private bucket>` をそれぞれ読戻す。候補 Cloud Run revision の `EXPERIENCE_GUIDE_PUBLIC_SOURCE=database` とbucket名に加え、候補URLで `UNLISTED` 記事が一覧・トップ・sitemapへ出ないことを確認してからpromoteする。

### `kamakura-after-4-pm` の非公開移行

trusted Studio の既存 `niho-experience` checkoutをcurrent directoryにし、既存 `niho-app` checkoutの公式bastion wrapperからだけ実行する。wrapperが子processへ渡すNIHO管理DB用`DATABASE_URL`はscript内で環境、localhost tunnel、管理DB名と管理userを照合し、資格情報を保持したまま同じinstanceのExperience DB名へ差し替える。URLや資格情報は出力しない。`EXPERIENCE_DATABASE_URL`を手入力・exportする経路は使わない。

先に公式migration runnerで`0067_guide_provider_ownership.sql`まで適用する。実provider/OWNER IDはechoしない`read`で受け、shell history、env file、Git、CI、公開ログへ置かない。下記の`GUIDE_TARGET_ENV`と`GUIDE_TARGET_PROJECT`は`stg` / `niho-app-stg`または`prd` / `niho-app-prd`の対応する組だけを使う。引数なしはcategory作成を含む全transactionをrollbackするdry-run、`--apply`はproject名の明示確認が一致した場合だけcommitする。出力は結果と関連体験件数だけでIDを出さない。

```sh
# trusted Studioの既存checkoutだけを使う。以下はstagingの組。productionでは両方をprdの組にする。
GUIDE_TARGET_ENV=stg
GUIDE_TARGET_PROJECT=niho-app-stg
NIHO_APP_CHECKOUT=/absolute/path/to/existing/niho-app

CONFIRM_EXPERIENCE_DB_MIGRATE="$GUIDE_TARGET_PROJECT" \
  "$NIHO_APP_CHECKOUT/scripts/dev/niho-db.sh" "$GUIDE_TARGET_ENV" --via-bastion -- \
  node scripts/gcp/apply-experience-db-migrations.mjs

printf 'Guide provider ID: ' >&2
IFS= read -r -s GUIDE_IMPORT_PROVIDER_ID
printf '\nGuide OWNER ID: ' >&2
IFS= read -r -s GUIDE_IMPORT_OWNER_ID
printf '\n' >&2
export GUIDE_IMPORT_PROVIDER_ID GUIDE_IMPORT_OWNER_ID
export GUIDE_IMPORT_CATEGORY_SLUG=evenings

# 1. dry-run: article、reservation、categoryの変更をすべてrollbackする
"$NIHO_APP_CHECKOUT/scripts/dev/niho-db.sh" "$GUIDE_TARGET_ENV" --via-bastion -- \
  node scripts/gcp/import-kamakura-after-4-pm-guide.mts

# 2. apply: wrapperが設定するNIHO_DB_ENVとこのproject確認が両方一致する必要がある
export CONFIRM_EXPERIENCE_GUIDE_IMPORT="$GUIDE_TARGET_PROJECT"
"$NIHO_APP_CHECKOUT/scripts/dev/niho-db.sh" "$GUIDE_TARGET_ENV" --via-bastion -- \
  node scripts/gcp/import-kamakura-after-4-pm-guide.mts --apply

# 3. 同じapplyを再実行し、上書きせずverifiedになることを確認する
"$NIHO_APP_CHECKOUT/scripts/dev/niho-db.sh" "$GUIDE_TARGET_ENV" --via-bastion -- \
  node scripts/gcp/import-kamakura-after-4-pm-guide.mts --apply

unset GUIDE_IMPORT_PROVIDER_ID GUIDE_IMPORT_OWNER_ID GUIDE_IMPORT_CATEGORY_SLUG
unset CONFIRM_EXPERIENCE_GUIDE_IMPORT GUIDE_TARGET_ENV GUIDE_TARGET_PROJECT NIHO_APP_CHECKOUT
```

これはカテゴリ管理の通常APIではなく、既存静的記事から初期公開データを一度だけ移す非公開ops transactionである。指定categoryが無い場合に自動作成できるのは`evenings`だけで、`Evenings` / `夕方・夜` / 表示順20 / active / revision 1としてarticleと同じtransactionに入れる。dry-runではcategoryも残らない。既存のactive `evenings`は更新せずそのままsnapshotに使い、inactiveまたは別slugの自動作成要求は変更前に拒否する。

scriptは元の静的モジュールからtitle、description、本文、author、2026-10-29の初回公開日、slug、checkedOnを取り、FAQを本文末尾へ変換する。現在公開中で同じ提供者に属する関連体験だけをsnapshotへ結ぶ。再実行は既存のimmutable初版を照合して `verified` を返し、差異があれば上書きしない。

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

## 旧Editor経路の撤去（#480）

Experienceはeditor.niho.lifeの公開APIを読まず、Editor向けpreview token、候補・関連記事check API、専用配備flagやorigin設定も持たない。旧 `/editor/*` は410を返す。過去の設計・移行経緯は [ADR 0002](adr/0002-guide-content.md) と [記事authority履歴](editor-article-authority.md) に残す。現行記事の執筆・公開は `/write` とExperience DBで行い、その画面は `test:e2e:write` で確認する。
