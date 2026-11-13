# 運営の CLI（管理画面と同じ操作を、コマンドラインと AI から）

[#576](https://github.com/niho-life/niho-experience/issues/576)。管理画面（`/admin`）の操作を、ブラウザの画面を使わずに行う。人と、AI（Claude Code・Codex）が使う。

- **新しい書き込み口はない。** CLI は管理画面の BFF（`/admin/api/...`）をそのまま呼ぶ。検証・公開条件・同時編集の保護・監査は管理画面と同じコードを通る。DB へ直接は書かない。
- **人のアカウントで動く。** 操作する人本人の Google アカウント（`@niho.life`、`EXPERIENCE_ADMIN_ALLOWED_EMAILS` にある人）の ID トークンを付ける。AI 専用のアカウントも、長く使える固定の鍵もない（オーナー決定 2026-11-14）。
- **既定は stg。** 本番は `--env prd` を明示したときだけ。

AI が作業の前に読む手引きは `.claude/skills/operator-cli/SKILL.md`（Codex は `.agents/skills/operator-cli/SKILL.md`。同じファイル）。このページはその詳細。

## 使う

```bash
gcloud auth login <you>@niho.life          # 1回。複数のアカウントがあるなら NIHO_OPS_ACCOUNT=<you>@niho.life
node scripts/experience/ops.mjs help       # 対象と操作の一覧（段階つき）
node scripts/experience/ops.mjs auth check # サインインの確認（stg）
```

```
node scripts/experience/ops.mjs <対象> <操作> [--file 変更.json] [--dry-run | --yes] [--env stg|prd] [--ai claude-code|codex|other|human]
```

| 指定 | 意味 |
| --- | --- |
| `--env stg\|prd` | 接続先。省略は stg。`NIHO_OPS_BASE_URL` は `http://localhost` / `http://127.0.0.1` だけ（トークンの送り先を限る） |
| （なし）／`--dry-run` | 書き込みは、**いまの状態と変えたあとの差分を出すだけ**で、何も送らない |
| `--yes` | 差分のとおり適用する。読み取りには要らない |
| `--ai` | 依頼した AI の種類。省略は環境から判断（`CLAUDECODE` → `claude-code`、`CODEX_*` → `codex`、それ以外は `human`）。`NIHO_OPS_AI` でも指定できる |
| `--file` | 変更の JSON。まとめて変えるときに使う |

### 出力と終了コード

標準出力は JSON（`ok`・`env`・`target`・`action`・`tier`・`mode`（`read`／`dry-run`／`apply`）・`result`）。トークン・接続先の内部情報・予約者の連絡先は出さない。

| 終了コード | 意味 |
| --- | --- |
| 0 | 完了（dry-run を含む） |
| 1 | 拒否・失敗（入力、サーバーの拒否、CLI が開いていない） |
| 2 | 使い方の誤り |
| 3 | サインインできない（トークンなし・期限切れ・許可リストに無い・`aud` が許可されていない） |
| 4 | 読んだあとに変わっていた（版の不一致）。読み直して計画し直す |

### 操作の段階

| 段階 | 例 | CLI の扱い |
| --- | --- | --- |
| `read` | 一覧・公開状態 | 確認なし。予約者の氏名・連絡先は出さない |
| `edit` | 原稿・写真・分類・街の人・記事の下書き・日程の枠 | 差分を見て `--yes` |
| `publish` | 商品・記事・人の公開と停止 | 差分＋ `--yes`。**本番は依頼した人の了承を取ってから** |
| `terms` | 料金・販売条件・取消条件 | 同上。予約済みの条件は変えない |
| （なし） | 返金・精算・受取口座 | **CLI では扱わない。** サーバーが、許可した `/admin/api` の領域以外を `403 not_available_from_cli` で断る |

`--yes` を付けるのは、差分を読んだあと。**本番（`--env prd`）の公開・停止・料金の変更は、依頼した人にチャットで了承を取ってから `--yes` を付ける。** stg の編集は了承なしでよい。

### 同じ操作を2回しない

- 差分が無ければ何も送らない（`unchanged`）。同じ `--file` を再実行しても二重にならない。
- 書き込みには操作ごとの ID（`op-<日付>-<ハッシュ>`）が付き、サーバーは同じ ID の再送を `409 operation_already_recorded` で断る。CLI は読み直し、すでに反映済みなら `unchanged`、まだなら `-r2` を付けた新しい ID で1回だけやり直す。
- 版（revision）を持つ対象は、読んだときの版を付けて送る。画面などで先に変わっていたら `409` で止まり、上書きしない（終了コード 4）。

## 認証のしくみ

```
CLI --Bearer <Google ID トークン>--> src/proxy.ts --(sealed assertion, 60秒)--> /admin/api の route handler
        (gcloud auth print-identity-token)     │ 検証・許可リスト・監査の記録
                                              └ 失敗は route handler に届く前に 401/403/409
```

- **トークン**：`gcloud auth print-identity-token`（有効1時間）。`NIHO_OPS_ID_TOKEN` で直接渡してもよい。CLI は表示も保存もしない。
- **検証**（`apps/web/src/lib/admin/operator-cli.ts`）：Google の公開鍵での署名、`iss`、期限、`aud` が許可されたクライアント、`email_verified`、`hd=niho.life`、アドレスが `@niho.life`、**`EXPERIENCE_ADMIN_ALLOWED_EMAILS` にあること（要求のたびに）**。操作者の ID は管理画面と同じ `adm_…`（`sub` から作る。アドレスからは作らない）。
- **`aud`**：`gcloud` が出すトークンは gcloud 自身の OAuth クライアント（`32555940559.apps.googleusercontent.com`）宛て。Experience のクライアント宛てではないので、受け入れるクライアントを設定 `EXPERIENCE_OPERATOR_CLI_AUDIENCES` に明示する。
- **proxy**（`apps/web/src/proxy.ts`）：`/admin/*` で、クライアントが送った `x-niho-operator-assertion` を必ず捨てる。Bearer が正しければ、操作者・AI の種類・操作 ID・メソッド・パスを封印した assertion（`ADMIN_SESSION_SECRET`、60秒）をヘッダーに足して route handler へ渡し、`Authorization` と cookie は外す。route handler 側の `loadAdminHttpSession` は assertion を管理画面のセッションとして扱い、許可リストをもう一度見る。変更系の `adminMutationAllowed` は、同じメソッドとパスの assertion があるときだけ通す（Origin の確認は cookie 用なので使わない）。
- **領域の絞り込み**：CLI が呼べる `/admin/api` の領域は `OPERATOR_API_AREAS`（いまは `product-classifications`・`people`）。それ以外は `403 not_available_from_cli`。返金・精算・口座は、領域を足さない限り届かない。
- **GET・HEAD と変更系以外のメソッド**：GET・HEAD と、POST・PUT・PATCH・DELETE だけ通す。

### 監査

変更系の要求は、**実行の前に** `operator_cli_requests`（migration `0078`）へ1行記録する。記録できなければ実行しない（503）。

| 列 | 内容 |
| --- | --- |
| `admin_actor_id` | 操作者の `adm_…`（管理画面の操作と同じ ID） |
| `ai_kind` | `claude-code`／`codex`／`other`／`human`。**呼び出し側の自己申告**で、証明ではない |
| `operation_id` | 呼び出し側の操作 ID（`(admin_actor_id, operation_id)` は一意） |
| `http_method`・`request_path` | 何を呼んだか（クエリは含めない） |
| `body_sha256` | 本文の SHA-256（本文は残さない） |
| `recorded_at` | 記録の時刻 |

実際に何がどう変わったかは、各対象の既存の監査（`*_niho_user_id` 列の操作者 ID など）に、管理画面と同じ形で残る。`operator_cli_requests` と突き合わせると「CLI 経由・どの AI・どの操作 ID」が分かる。

## 有効にする（配備）

- GitHub variable：`STG_`／`PROD_` ＋ `OPERATOR_CLI_ENABLED=true`、`OPERATOR_CLI_AUDIENCES=32555940559.apps.googleusercontent.com`（Google OAuth クライアント ID を `;` で区切る。空白なし）。`ADMIN_GOOGLE_LOGIN_ENABLED=true` と `ADMIN_ALLOWED_EMAILS` が前提（Admin の Google ログインと同じ許可リストを使う）。
- migration `0078` を先に適用する（runtime role は `operator_cli_requests` の INSERT だけ。`scripts/gcp/experience-db-grants.mjs` に宣言済み。監査の表なので UPDATE・DELETE は付けない）。
- 配備の表は `scripts/deploy/runtime-flags.mjs`（`EXPERIENCE_OPERATOR_CLI_ENABLED`）。flag が OFF の間は、Bearer 付きの要求は何も変わらず（cookie のセッションだけが有効）、CLI は `cli_not_open` を返す。
- **`gcloud` のクライアントを受け入れるときの注意**：このクライアントは公開されているので、Google の同意画面を出せる別のアプリが、本人の同意のうえで同じ `aud` のトークンを取り、この API に送ることは技術的には可能（フィッシングと同じ形）。許可リストにある人しか通らず、期限は1時間、返金・精算・口座は届かない、本番の変更は操作ごとに記録される、という範囲で受け入れている。より絞るなら、Desktop 型の専用 OAuth クライアントをつくって `OPERATOR_CLI_AUDIENCES` を差し替える（コードの変更は要らない）。

## 対象と操作

（段階ごとに足す。いま使えるのは `auth check` だけ。）

| 対象 | 操作 | 段階 |
| --- | --- | --- |
| `auth` | `check` | read |
