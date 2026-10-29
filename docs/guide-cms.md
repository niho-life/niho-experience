# Guide CMS のカバー写真

[#215](https://github.com/niho-life/niho-experience/issues/215) では、英語記事に任意のカバー写真を1枚だけ設定できる。本文の figure は引き続き公開前検査と store の公開 transaction の双方で拒否する。公開 SSR と公開画像配信は #189 の切替対象であり、この段階では公開 media route は常に 404、公開 HTML は写真 URL を出さない。

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
