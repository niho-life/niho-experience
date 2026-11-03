# NIHOライブラリ向けの記事カード

NIHO #19480、Experience #251/#255の連携。本文・公開版・画像はEditorが正本、NIHOはこの公開summaryだけを読む。NIHO向けの本文公開面や「鎌倉の人」の役割は設けない。承認済みwriterがExperience向けに公開し、著者が追加配信`app`を明示選択した場合だけカードにする。条件宣言のextrasは`app`だけ、既定false。

`GET /api/public/guides/app-cards?cursor=…`はversion 1の`items`と`nextCursor`を返す。summaryは記事UUID、slug、title、任意lead/cover、公開author、canonicalUrl、updatedAtだけ。本文・メール・内部NIHO ID・資格は含めない。カバー無し、リード無しも正常。

現在のEditor exp面の一覧をfresh/staleとも0で読み、liveかつextras.app=trueだけをupdatedAt降順/id昇順にする。本文取得は行わない。100件/ページ、5000件まで。cursorは公開位置であり認証ではない。対象が停止/変更されcursorを復元できない場合も安全に失敗し、NIHO側が取り直す。Editorの元canonicalが現在のsite originの`/guides/{slug}`と完全一致することを必須にする。coverは許可asset originと`/assets/{sha256}.{jpg|png|webp|avif}`だけ。

全応答はno-store/nosniff/noindex。flag OFFは空の200、不正queryは400、資格不足・不正な公開summary・Editor障害は一般化した503で返す。通常guideの既存cacheをこのendpointに流用せず、旧cacheや別CMSへfallbackしない。NIHOのBFFも1要求で1ページだけ取得し、本文やカードを永続snapshotへ保存しない。カードからExperience canonicalを開き、元のNIHO画面を戻り先として残す。

## 有効化と切戻し

公式stg/prod workflowのruntime-flags表に`STG_GUIDE_APP_CARDS_ENABLED` / `PROD_GUIDE_APP_CARDS_ENABLED`を追加した。未設定/falseはOFF。trueには既存`EDITOR_PUBLICATIONS_ENABLED`と、そのauthority/DB/数値版Secret参照の前提を要求する。資格投入は既存のowner操作だけ。実値や鍵を公開repoに記録しない。

親sourceのmerge、Editor/Experienceの公式配備、現在のwriter/同意/カテゴリ/公開版の確認後に、合成記事でapp opt-in、停止/限定公開、canonical/画像、100件境界とcursor、障害503をHTTP確認する。続いてNIHOのBFFを有効化してカードを読む。画面受入はowner指示で省略。停止はこのflagをfalseにした公式revisionへ戻し、Editor本文や公開版を削除しない。
