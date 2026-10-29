# Editor app-connect 認証基盤

このディレクトリは `/editor` のサーバー側認証境界です。niho-app #19459
のブラウザ接続は専用契約で実装済みですが、配備・結合受入までは `EDITOR_CONSOLE_ENABLED` の既定値は `false` です。
HTTP mode、明示 flag、editor 専用 cookie secret、NIHO Firebase Web API key、
登録済み editor origin がすべて揃わない限り route は 404 を返します。
mock login や本番用 bypass はありません。

NIHO 側の専用契約は次のとおりです。

- client: `niho-experience-editor`
- confirmation: `/connect/niho-experience-editor`
- exchange/refresh/revoke: `/api/auth/experience-editor-connect/*`
- verification: `GET /api/auth/experience-editor-connect/session`
- verification body: `{ actor: { id }, connection: { id, expiresAt }, account: { active } }`

flag を有効にする前に NIHO の配備と結合受入を確認します。ブラウザへ
渡すのは seal 済みの HttpOnly / Secure / SameSite=Lax cookie だけです。
session と login cookie の Path はそれぞれ `/editor` と `/editor/auth` で、
editor 専用の seal purpose を使います。Firebase custom/ID token と、回転する
editor connect refresh token はサーバーだけが保持します。
editor session は初回ログインから最大 7 日で期限切れとなり、refresh で延長しません。

editor の認証済み操作は毎回先に `loadEditorSession()` を呼び、NIHO で現在の
account active と connection identity を再確認します。後続 UI の session 維持は
直接 POST せず `client-session.ts` の `refreshEditorSession()` を使い、Web Locks
で複数 tab の回転を直列化します。Web Locks 非対応なら refresh を送らず再接続を促します。
この第一段階では UI から refresh を呼びません。
回転要求が曖昧に失敗した場合は旧 token を破棄します。NIHO から新しい refresh
token を受け取った後段で通信失敗した場合だけ、回転済み token を再 seal します。

ログイン後は常に `/editor/guides` へ移動し、任意の return target は受け付けません。
writer grant の管理 UI と editor UI はこの段階の対象外です。

## PRIVATE guide draft API (editor v1)

`/editor/api/guides` 以下は同一 origin の非公開 JSON API です。各 request で
`loadEditorSession()` により現在の NIHO account と connection を再確認し、DB 接続が
無い場合や NIHO / PostgreSQL が利用できない場合は `503` を返します。すべての response は
`private, no-store` / `noindex, nofollow` です。mutation は `Origin` と
`Sec-Fetch-Site: same-origin` を要求し、request body は厳密な UTF-8 JSON として最大 1 MiB まで
streaming で読み取ります。

- `GET /editor/api/guides`: 本人が作成し、現在も subject 権限を持つ article の一覧
- `POST /editor/api/guides`: server-generated ID の private draft 作成
- `GET/PATCH /editor/api/guides/[articleId]`: 本人の private snapshot の取得と revision 付き全量保存
- `GET /editor/api/guides/categories`: active category
- `GET /editor/api/guides/subjects`: writer grant と OWNER/EDITOR membership 由来の書込可能 subject

この API に publish / stop や public read は含めません。公開前の Markdown・写真・権利検査と
公開操作は #187 の別契約です。
