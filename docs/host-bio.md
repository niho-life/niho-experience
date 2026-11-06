# ホスト紹介文（bio・#146）

## 目的

旅行者が「誰が体験を案内するのか」を予約前に知れるよう、ホスト（提供者の OWNER）が自分で書いた紹介文を体験ページに出す。オーナー決定により **提供者ごとに 1 つ**。体験ごとには持たない。

- 日本語で書き、英語は機械翻訳の案をホストが確認・修正してから公開する。
- 体験の公開の可否には影響しない（公開 blocker にしない）。書かなければ節を出さないだけで、仮文は置かない。

## データと同意

テーブル `provider_host_bios`（migration `0062_provider_host_bios.sql`）。1 提供者 1 行。

| 列 | 内容 |
| --- | --- |
| `provider_id` | 主キー。`experience_providers` を参照 |
| `bio_ja` | 日本語の本文。1〜600 文字（コードポイント）、前後の空白なし、改行（LF）可、その他の制御文字不可 |
| `bio_en` | 英語の本文（任意）。1〜1500 文字、条件は同上 |
| `english_source_fingerprint` | 英語を確認した時点の `bio_ja` の sha256（小文字 hex 64 桁）。`bio_en` と同時に null / 非 null |
| `consent_version` / `consented_at` / `consented_by_niho_user_id` | 公開への同意。保存のたびに、保存した人・DB 時刻・現在の同意版で更新する。同意者は同じ提供者の membership（外部キー） |
| `version` | 楽観ロック用。初回 1、保存ごとに +1 |

- 上限と同意版は `packages/experience-store/src/host-bio-rules.ts` の `HOST_BIO_LIMITS`（ja 600 / en 1500）と `HOST_BIO_CONSENT_VERSION`（`host-bio-consent-v1`）が正。DB の CHECK、Store の検証、Host API、翻訳、Host 画面が同じ値を使う。画面はパッケージの subpath `@niho-experience/experience-store/host-bio-rules` から読む（Node・DB に依存しない）。
- 保存前の正規化: CRLF/CR → LF、前後の空白を除く、3 つ以上続く改行は 2 つ（空行 1 つ）に詰める。文字数は正規化後のコードポイントで数える（PostgreSQL の `char_length` と同じ）。
- 同意の文言（画面）: 「ここに書いた内容は、あなたの体験ページ（日本語・英語）に公開されます。電話番号・メール・住所など、公開したくない情報は書かないでください。」文言を変える時は同意版も上げる。
- 書けるのは現在の OWNER（`provider_memberships.active=true AND role='OWNER'`）だけ。EDITOR・VIEWER・他提供者は Store が拒否する。
- 履歴表・command receipt 表は持たない。結果が分からない保存は、画面が現在値を読み直して確かめる（同じ版で盲目的に再送しない）。

## 英語の公開条件（fingerprint）

- 英語は、ホストが「英語を確認しました」にチェックして保存した時だけ送られる。サーバーはその時の正規化済み `bio_ja` の sha256 を計算して `english_source_fingerprint` に保存する。クライアントの fingerprint は受け取らない。
- 画面で日本語を変えると確認のチェックが外れ、そのまま保存すると英語は送られない（`bio_en` と fingerprint は null になる）。
- 読む側（公開ページと Host 画面の両方）でも、`bio_en` が非 null かつ fingerprint が現在の `bio_ja` の sha256 と一致する時だけ英語を有効とする。DB で `bio_ja` だけが変わった場合も英語は出ない。Host 画面は `englishConfirmed=false` のとき「英語はまだ公開されていません」と示す。

## 撤回

`DELETE /host/api/host-bio`（`expectedVersion` 必須）で行を削除する。公開ページは次の表示から節を出さない。撤回後に書き直すと版は 1 から始まる。

## 公開面

- 体験詳細ページ（`SitePublicationPage`）の「Know before you go」「Where you'll meet」の後、レビューの前に `<section id="host">`。見出しは英語ページ「About your host」、日本語ページ「ホストについて」。内容は `publication.sellerDisplayName`（太字）と本文（`whitespace-pre-line` のプレーンテキスト。HTML・Markdown として解釈しない）。
- 英語ページは確認済みの英語がある時だけ、日本語ページは日本語がある時だけ出す。無ければ節ごと出さない。
- 読むのは `getSitePublicExperience`（詳細ページ）だけ。`ProviderHostBioRepository.getPublicBySlug` は販売者表示と同じ「現在公開中」の条件（公開状態が停止・運営停止・再開待ちでない、現在の公開版、seller profile と NIHO アカウント・Connect の一致、現在の OWNER が有効）で結合し、`{ ja, en }` だけを返す。提供者 ID・NIHO ID・同意者は返さない。読めない・失敗した時は null（ページは壊さない）。カード一覧（`listSitePublicExperiences`）は読まず `hostBio: null`。
- JSON-LD には入れていない。

## API（`/host` 配下・OWNER のみ）

販売者表示（`seller-disclosure-http.ts`）と同じ境界: NIHO の現在の本人 → 対応づけ済みの Experience OWNER、書き込みは same-origin、厳格 JSON（余分なキー拒否・`application/json`・16KB 上限）、`private, no-store`、host publication API の flag が無効なら 404。本文をログ・計測・URL に出さない。実装は `apps/web/src/lib/experience/host-bio-http.ts`。

| メソッド | パス | 本文 | 応答 |
| --- | --- | --- | --- |
| GET | `/host/api/host-bio` | — | `{ hostBio: { version, bioJa, bioEn, englishConfirmed, consentVersion, updatedAtUtc }, consentVersion }`。未保存は version 0 と null |
| PUT | `/host/api/host-bio` | `{ bioJa, bioEn: string \| null, expectedVersion: number \| null, consentVersion }` | `{ hostBio }` |
| DELETE | `/host/api/host-bio` | `{ expectedVersion }` | `{ hostBio }`（version 0） |
| POST | `/host/api/host-bio/translation` | `{ bioJa }` | `{ bioEn }`（保存しない） |

エラー: 400 `INVALID_INPUT`（形式）、413（大きすぎる）、422 `INVALID_INPUT`（Store 検証）、401/403（認証・権限）、409 `VERSION_CONFLICT`（版の競合・初回の重複）、503 `UNAVAILABLE` / `TRANSLATION_UNAVAILABLE`。

翻訳は Claude API（`apps/web/src/lib/translation/prompts.ts` の `hostBioToEnglish`、タイムアウト 45 秒）。入力は指示ではなくデータとして扱い、事実・経歴・連絡先・URL を足さず、段落を保ち、英語本文だけを返すよう指示する。出力は正規化し、空・制御文字・1500 文字超は 503 とする。

## Host 画面

`/host/profile`（`HOST_PROFILE_PATH`。メニューの「販売者表示」の隣に「ホスト紹介」、OWNER のみ表示）。部品は `apps/web/src/components/host/HostBioForm.tsx`、純関数は `host-bio-form-model.ts`。

- 日本語の textarea（文字数と残り、超過は `role="alert"` で読み上げ）→「英語案を作る」→ 英語の textarea（編集可）→「英語を確認しました」→ 公開の同意 →「保存」。主操作は「保存」1 つ（48px）。
- 撤回は `<dialog>` で確認する。保存中は入力と操作を無効にする。
- ネットワーク失敗・5xx・読めない応答は「結果不明」とし、入力を残したまま「再読込して現在の内容を確認」だけを出す。再読込後、保存されていたかどうかを示す。409 は現在値を読み直し、入力は残す。401/403 は入力を画面から消す。

## 境界

- NIHO の個人情報（プロフィール・本人確認）や Stripe の情報を自動で取り込まない。ホストが自分で書いた文だけを出す。
- 公開契約（`packages/api-client/contract`、OpenAPI）と `packages/experience-presentation` は変えていない。体験原稿（manuscript）のキー・fingerprint にも触れない。
- 新しい環境変数・flag は無い。runtime の DB 権限は `scripts/gcp/experience-db-grants.mjs` の `provider_host_bios: INSERT/UPDATE/DELETE`。

## 既知の未確認事項

- OWNER が交代した場合、前の OWNER が書いた bio は（新しい OWNER が撤回・上書きするまで）そのまま出る。同意者が現役であることは公開条件にしていない。
- 撤回後に書き直すと版が 1 に戻るため、撤回前の版 1 を持った古い画面からの保存が通りうる（ABA）。履歴表を持たない設計上の割り切り。
- 機械翻訳の品質、不適切な内容の検知（モデレーション）は行っていない。公開内容の責任はホストの確認と同意に置く。
- 実ブラウザでの 320px・360px 表示とキーボード操作は、単体テストではなく目視確認が必要（未実施）。
