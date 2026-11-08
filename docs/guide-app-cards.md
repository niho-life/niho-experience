# NIHO向け記事カード互換API

EditorからExperienceへの公開経路は#480で撤去した。`GET /api/public/guides/app-cards` はNIHO consumerの応答形を維持し、旧cursorを含むqueryを無視して常に `{ "version": 1, "items": [], "nextCursor": null }` を返す。`Cache-Control: no-store`、`X-Robots-Tag: noindex`、`X-Content-Type-Options: nosniff` を付け、外部Editor APIを読まない。

Experience DBの記事にはNIHOアプリ掲載への選択と公開カードの契約がまだない。カードを再び出すには、そのデータ・同意・認可・公開DTOを別Issueで定義し、NIHO consumerと一緒に受け入れる。旧 `GUIDE_APP_CARDS_ENABLED` は撤去済みで、設定だけでは有効化できない。
