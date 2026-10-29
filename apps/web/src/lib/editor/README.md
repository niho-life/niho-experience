# Editor app-connect 認証基盤

このディレクトリは `/editor` のサーバー側認証境界です。niho-app #19459
は未実装・未配備のため、`EDITOR_CONSOLE_ENABLED` の既定値は `false` です。
HTTP mode、明示 flag、editor 専用 cookie secret、NIHO Firebase Web API key、
登録済み editor origin がすべて揃わない限り route は 404 を返します。
mock login や本番用 bypass はありません。

NIHO 側の仮契約は次のとおりです。

- client: `niho-experience-editor`
- confirmation: `/connect/niho-experience-editor`
- exchange/refresh: the standard app-connect endpoints
- verification: `GET /api/auth/app-connect/experience-editor/session`
- verification body: `{ actor: { id }, connection: { id, expiresAt }, account: { active } }`

flag を有効にする前に NIHO の正式な書き出し契約と照合します。ブラウザへ
渡すのは seal 済みの HttpOnly / Secure / SameSite=Lax cookie だけです。
session と login cookie の Path はそれぞれ `/editor` と `/editor/auth` で、
editor 専用の seal purpose を使います。Firebase custom/ID token と、回転する
app-connect refresh token はサーバーだけが保持します。
editor session は初回ログインから最大 7 日で期限切れとなり、refresh で延長しません。

editor の認証済み操作は毎回先に `loadEditorSession()` を呼び、NIHO で現在の
account active と connection identity を再確認します。後続 UI の session 維持は
直接 POST せず `client-session.ts` の `refreshEditorSession()` を使い、Web Locks
で複数 tab の回転を直列化します。Web Locks 非対応なら refresh を送らず再接続を促します。
この第一段階では UI から refresh を呼びません。
回転要求が曖昧に失敗した場合は旧 token を破棄します。NIHO から新しい refresh
token を受け取った後段で通信失敗した場合だけ、回転済み token を再 seal します。

ログイン後は常に `/editor/guides` へ移動し、任意の return target は受け付けません。
guide/article API、writer grant、editor UI はこの段階の対象外です。
