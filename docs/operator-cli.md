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

記録は実行の前なので、route が入力を断った（400 など）操作も残る。残るのは「何を試みたか」で、「何が変わったか」は次の既存の監査が示す。

実際に何がどう変わったかは、各対象の既存の監査（`*_niho_user_id` 列の操作者 ID など）に、管理画面と同じ形で残る。`operator_cli_requests` と突き合わせると「CLI 経由・どの AI・どの操作 ID」が分かる。

## 有効にする（配備）

- GitHub variable：`STG_`／`PROD_` ＋ `OPERATOR_CLI_ENABLED=true`、`OPERATOR_CLI_AUDIENCES=32555940559.apps.googleusercontent.com`（Google OAuth クライアント ID を `;` で区切る。空白なし）。`ADMIN_GOOGLE_LOGIN_ENABLED=true` と `ADMIN_ALLOWED_EMAILS` が前提（Admin の Google ログインと同じ許可リストを使う）。
- migration `0078` を先に適用する（runtime role は `operator_cli_requests` の INSERT だけ。`scripts/gcp/experience-db-grants.mjs` に宣言済み。監査の表なので UPDATE・DELETE は付けない）。
- 配備の表は `scripts/deploy/runtime-flags.mjs`（`EXPERIENCE_OPERATOR_CLI_ENABLED`）。flag が OFF の間は、Bearer 付きの要求は何も変わらず（cookie のセッションだけが有効）、CLI は `cli_not_open` を返す。
- **`gcloud` のクライアントを受け入れるときの注意**：このクライアントは公開されているので、Google の同意画面を出せる別のアプリが、本人の同意のうえで同じ `aud` のトークンを取り、この API に送ることは技術的には可能（フィッシングと同じ形）。許可リストにある人しか通らず、期限は1時間、返金・精算・口座は届かない、本番の変更は操作ごとに記録される、という範囲で受け入れている。より絞るなら、Desktop 型の専用 OAuth クライアントをつくって `OPERATOR_CLI_AUDIENCES` を差し替える（コードの変更は要らない）。

## 対象と操作

| 対象 | 操作 | 段階 |
| --- | --- | --- |
| `auth` | `check` | read |
| `classification` | `list`（`--slug`・`--status`・`--unclassified`）、`options` | read |
| `classification` | `apply --file 変更.json` | edit |
| `people` | `list`（`--listed`・`--unlisted`・`--provider`） | read |
| `people` | `apply --file 変更.json`、`withdraw --provider <providerId>` | publish |
| `provider` | `list` | read |
| `provider` | `create --name … --kind PERSON\|BUSINESS --consent-confirmed` | edit |
| `product` | `list`・`show`・`calendar` | read |
| `product` | `create`・`draft`・`calendar-add`・`photo-add` | edit |
| `product` | `terms`（価格・販売条件） | terms |
| `product` | `publish`・`suspend`・`resume` | publish |
| `inquiry` | `list`（`--status`・`--id`） | read |
| `inquiry` | `update --id <uuid> [--status] [--assignee] [--due] [--note]` | edit |
| `assignment` | `list`（`--provider`・`--occurrence`） | read |
| `assignment` | `claim`・`decline`・`release`（`--provider --occurrence [--subject] [--reason]`） | edit |

## よくある作業

### 商品の分類（カテゴリー・エリア・だれと・こんな日に）を入れる

分類の値は `classification options` が返す（サイトの定義が正本。`docs/product-classification.md`）。変更はファイルに書く。**書いたキーだけが変わる**（`category`・`area`・`companions`・`occasions`）。商品は `slug`、または `providerId` と `productId` で指す（同じ slug が複数の提供者にあるときは後者）。

```json
{ "items": [
  { "slug": "kita-kamakura-walk", "classification": { "category": "walk", "area": "kita", "companions": ["solo", "friends"] } },
  { "providerId": "prov-a", "productId": "p-2", "classification": { "occasions": ["rain"] } }
] }
```

```bash
node scripts/experience/ops.mjs classification list --unclassified          # まだ分類が無い商品
node scripts/experience/ops.mjs classification apply --file changes.json        # 差分だけ（何も送らない）
node scripts/experience/ops.mjs classification apply --file changes.json --yes  # 適用
```

- 結果は項目ごと（`unchanged`・`dry_run`・`applied`・`failed`・`not_attempted`）。同じファイルをもう一度流しても、すでに入っている項目は `unchanged` で、二重にならない。
- 送るのは50商品ずつ（1回の要求は全部成功か全部失敗）。各商品に、読んだ値（`expected`）を付けて送る。画面などで先に変わっていたら、その要求は保存せずに `409 conflict`（終了コード 4）。CLI はそこで止まり、済んだ分・未着手の分を返す。読み直して同じコマンドをもう一度。
- ファイルに誤り（不明な商品・曖昧な slug・定義にない値）があるときは、何も送らずに止まる。
- 分類は公開版の一部ではなく、保存するとすぐ日本語の一覧・カード・詳細に反映される（再公開は要らない）。公開してよいかの判断は人（本番は了承を取る）。

### 街の人に載せる・変える・外す

載せる・変える・外すは、日本語サイトの `/ja/people` にすぐ出る・消えるので `publish` の段階（**本番は依頼した人の了承を取ってから `--yes`**）。載せられるのは、公開プロフィールがある提供者だけ（`people list` の `publicDisplayName`・`photoReady`・`hasHostBio`・`visible` を見る。提供者の写真が許可つきで選ばれていないと、載せても表示されない）。

```json
{ "items": [
  { "providerId": "prov-a", "listing": { "slug": "yuki", "roleJa": "料理家", "areaJa": "長谷", "sortOrder": 10, "quoteJa": "台所に立つ人" } }
] }
```

```bash
node scripts/experience/ops.mjs people list --unlisted                       # まだ載っていない人
node scripts/experience/ops.mjs people apply --file people.json              # 差分だけ
node scripts/experience/ops.mjs people apply --file people.json --yes        # 載せる／変える
node scripts/experience/ops.mjs people withdraw --provider prov-a --yes      # 外す（公開プロフィールと写真は残る）
```

- 新しく載せるには `slug`（英小文字・数字・ハイフン）・`roleJa`（80字）・`areaJa`（40字）・`sortOrder`（0〜9999）が要る。`quoteJa`（160字）・`introJa`（1200字）は任意。載っている人は、書いたキーだけが変わる。値は、サーバーと同じ検証を実行の前に通す（前後に空白がある肩書などは断る）。
- 読んだ版（`expectedVersion`）を付けて送る。画面などで先に変わっていた・スラッグを他の人が使っていたときは `409 conflict`（終了コード 4）で、何も上書きしない。ほかの項目の処理は続く。

### 新しい日本語の商品を出す（stg の例。画面は使わない）

前提：商品を載せる提供者に **販売者の登録（seller workspace）** が済んでいること（`provider list` の `sellers` に出る。新しい提供者の販売者は、移行・初期登録の運用スクリプト `scripts/experience/provision-host-seller.mjs`）。日本語のみの商品（`content.japaneseOnly`）は `EXPERIENCE_JAPANESE_SITE_ENABLED` が `true` の環境でだけ保存できる。以下は `--provider <providerId>` を付ける。商品の `id` は `product list` で分かる。

1. **下書きをつくる**（`product create --file draft.json`）。`slug`・`publicTitle`（日本語のみのときは日本語の題と同じ）・`unitAmount`（円。0 か 50 以上）・`content`。日本語のみなら `content` に `"japaneseOnly": true` と `ja`（`title`・`lead`・`description`・`language`・`highlights`・`included`・`notIncluded`・`knowBeforeYouGo`・`notSuitableFor`・`timeline`）を入れ、英語の欄（`lead`・`description`・`facts.language`・配列）は空にする。同じ `slug` が既にあれば `unchanged`。
2. **原稿を直す**（`product draft --product <id> --file changes.json`）。`slug`・`publicTitle`・`content` のうち書いたものだけ。`content` は上のキーごとに混ぜる（`ja` は丸ごと置き換わる）。
3. **料金・販売条件**（`product terms --product <id> --file terms.json`、**terms の段階**）。`unitAmount` と `saleTerms`。販売条件が未設定の商品は、全項目が要る（例：`{"saleTerms":{"offerPrices":null,"childPricing":null,"minimumParticipants":1,"minimumChargeableParticipants":1,"maxPartySize":6,"cancellationPolicy":"FREE_UNTIL_24H","cancellationWindowMinutesBeforeStart":1440,"cancellationRefundBasisPoints":10000,"minimumAttendance":null,"bookingQuestions":[],"conditionsVersion":null}}`）。設定済みなら、書いたキーだけが変わる。
4. **日程の枠**（`product calendar-add --product <id> --file rule.json`）。`timeZone: "Asia/Tokyo"`・`startsOn`・`endsOn`（任意）・`localStartTime`・`durationMinutes`・`capacity`・`bookingCutoffMinutes`・`busyBufferBeforeMinutes`・`busyBufferAfterMinutes`・`recurrence`（`{"kind":"WEEKLY"}` など）。同じ内容をもう一度送っても増えない。`product calendar --product <id>` で、できた日付を見る。
5. **写真**（`product photo-add --product <id> --file 写真.jpg --alt "English alt" --alt-ja "日本語の説明" --photographer "撮影者" --permission "許諾の根拠" --rights-confirmed [--credit "公開するクレジット"]`）。jpg・png、10MB まで。**撮影者と許諾を人が確認したものだけ**。`--photographer`・`--permission` は結果（`evidence`）に sha256 とあわせて出るので、Issue か PR に貼って残す。
6. **公開できるか見る**（`product publish --product <id> --seller-confirmation WRITTEN --photo-rights-confirmed`）。`--yes` なしは、サーバーが返す公開の妨げ（`blockers`）と、いま公開できるかだけを出す。妨げが残っていれば、直してから。
7. **公開する**：同じコマンドに `--yes`。**本番は依頼した人の了承を取ってから。** 公開すると `/ja/experiences/<slug>` に出る。
8. **停止する**（`product suspend --product <id> --reason SYNTHETIC_CLEANUP --yes`）：運営停止。合成の商品の片付けなど。公開状態の版は、公開済みの商品でも読める専用の `GET /admin/api/experience-publications/providers/<p>/products/<x>` から取る（下書き用の `product show` は公開済みには答えない）。止めたあと、持ち主が再開するまで出ない（`resume` は運営停止を解くだけ）。

どの変更も、読んだときの版を付けて送る。画面などで先に変わっていたら `409`（終了コード 4）で止まり、上書きしない。`product show` は、いまの下書き・販売条件・写真・公開の妨げ・版を返す（予約者の情報は出ない）。

### 相談の受付一覧と、開催回の担当の記録

- `inquiry list` は、送り手の氏名・メールアドレス・本文・詳細を**出さない**（種別・状態・返信期限・次の期日・担当ラベル・スタッフのメモ・体験の slug だけ）。`inquiry update` は、書いた項目（`--status`・`--assignee`・`--due`・`--note`。空文字で消す）だけが変わる。相手にメールは送らない。
- `assignment list` は開催回の一覧。`--provider` と `--occurrence` を付けると、その開催回の候補者と履歴。`claim`・`decline`・`release` は、その人に代わって担当を記録する（先に取られていれば `already_assigned`（終了コード 4）。同じ記録は同じ日なら1件（再送）で、担当を外したあとに同じ人がもう一度引き受けるときは `--again`）。**合意した報酬（`SET_FEE`）は CLI では扱わない**（proxy が `403 not_available_from_cli` で断る。金額は画面で人が入れる）。

### まだ CLI に無いもの

- **記事**（#576 ⑤）：記事は `/write`（ホストと同じログイン）で提供者の OWNER が書く作りで、管理画面側の記事の編集 API が無い（「先に画面だけがある操作は API を先に整える」）。AI に記事の下書き・公開を頼むには、OWNER の代わりに事務局が書く API（商品の代理登録と同じ形の `*AsAdmin`）を先につくる必要がある。方針の決定が要るので、Issue #576 に論点を残している。
- **予約の取消・返金・精算・受取口座**：扱わない（領域に入れていない）。stg の合成データの片付けは、商品の `suspend` まで（予約の取消は返金を伴いうるので、画面で人が行う）。
- 販売者（seller workspace）の新規登録：運用スクリプト `scripts/experience/provision-host-seller.mjs`。
