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

## database flagを開く前のゲート

1. `0005`、`0008`、`0009`、`0010`、`0011`を含む全migrationをstagingへ適用し、category、writer/provider authority、article、asset、publicationを非公開の移行手順で投入する。#147 の限定公開URLを維持する場合、同じslugの `UNLISTED` 公開版へ移し、切替後も直接URLがnoindexで読めることを確認する。実ID・未公開原稿・object keyをGit、CI、公開ログへ残さない。
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
