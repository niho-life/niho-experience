# Guide CMS の非公開写真

[#215](https://github.com/niho-life/niho-experience/issues/215) では英語記事に任意のカバー写真を1枚だけ設定し、[#216](https://github.com/niho-life/niho-experience/issues/216) で同じ非公開asset境界を本文写真へ拡張する。公開 SSR と公開画像配信は #189 の切替対象であり、この段階では公開 media route は常に 404、公開 HTML は写真 URL を出さない。

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

## 本文写真（#216）

本文写真は `0010_guide_body_media.sql` 適用後に利用する。Markdown の新規写真形式は、行単独の `![English alt](niho-guide-asset:<uuid-v4>)` だけとする。本文が持つのは記事scopeの opaque asset ID、配置順、文脈依存の英語altだけで、object key・署名URL・公開クレジット・許諾記録は持たない。外部URL、`/sample/`、raw HTML、未知・別記事・`UPLOADING`・`REVOKED` assetは、storeを直接呼んでも保存・公開できない。1記事の配置は10か所以内で、同じassetを複数位置に置ける。

editor は TipTap の atom `guideFigure` をカーソル位置へ置く。popover から記事専用写真をuploadまたは既存の `READY` assetから選び、英語alt・公開クレジット・Web掲載確認を設定する。画像は認証済み `private, no-store` routeだけで表示し、ブラウザへobject keyを返さない。既存の外部URL写真はネットから取得せず、原文を持つ unresolved node として表示する。明示的に内部assetへ差し替えるまで保存・公開を拒否し、失敗時も原文を画面内に保持する。

公開transactionは article をlockしてから参照assetをUUID順にlockし、記事・作成者scope、`READY`、初回確認時に固定された公開クレジットとWeb掲載確認、非失効を再検査する。`guide_publication_media` は coverを `slot=0 / placement=COVER`、本文を `slot=1..10 / placement=FIGURE` として、alt・credit・順序をimmutable snapshotへ保存する。公開read modelはsnapshotと現在も `READY` の本文写真metadataだけを返すが、#189までは公開HTMLや公開画像routeへ接続しない。公開routeは引き続き404とする。

本文写真の設定から「掲載権利を取り消す」を実行できる。権利取消ではobjectを物理削除せず、publication snapshotとMarkdownも監査・差替えのため残す。本文参照があればarticle revisionを進め、公開readからは直ちに非表示にする。以後の保存・再公開は差替えまで拒否する。通常の「記事から外す」はMarkdownから配置を削除するだけで、assetの権利取消ではない。coverの既存draft・snapshot・取消契約は維持する。
