# ADR 0003: Experience を NIHO 本体から独立させる（ホストの本人・受取口座・Admin）

- 状態: 採用（2026-11-07。オーナーの方針を受けて、構成はこの ADR で決めた）
- 補足（オーナー 2026-11-07）: ホストのログインの本来の形は NIHO ログイン。§1 のメールのリンクは一時的な運用で、後で NIHO ログインへ戻す。戻す時期と手順は別に決める。戻すときはセッションを `/host` だけでなく記事の `/write` にも届く形にする（[ADR 0002 ガイド記事](0002-guide-content.md)の「2026-11-07」）。
- 方針: オーナー指示（2026-11-07）「できるだけ niho-experience で独立させる。セキュリティ上どうしても必要な場合だけ niho-app の非公開リポを使う。口座の構成も最適を考える」
- 置き換えるもの: [ADR 0002](0002-experience-domain-ownership.md) のうち、次の 3 点
  - NIHO アカウントを、ホストの共通の本人確認に使う
  - NIHO が、Connect 口座の接続・本人確認・readiness の正本を持つ
  - Admin の認証を、NIHO の Admin session で行う
- 関連: [#456](https://github.com/niho-life/niho-experience/issues/456)、#15、#330、#369、niho-coliving/niho-app#19917・#19864・#19121

## 背景

商品・公開版・開催枠・予約・在庫・決済・返金・台帳・DB・配備は、すでに Experience の正本にある。本番の公開を止めているのは、ホストの「本人は誰か」と「その人の口座を使ってよいか」を NIHO の API から受け取る作りだけである。

- 本番の NIHO に Host v1 の入口が無い（`api.niho.life/api/experience-host/identity` が 404）。契約は niho-app #19712 で merge 済みだが、本番の設定と配備は niho-app 側の作業になる（niho-app #19917）。
- 口座の再利用同意を本人が登録する導線は、niho-app #19864 で未実装。
- Experience は fail-closed のため、どちらかが欠けると公開と予約が閉じる。

この依存の結果、Experience の本番の公開が、別リポの開発・配備・CI 予算に左右されている。

### いまの NIHO への依存（2026-11-07 の main）

販売を止めるのは上の 4 行で、下の 2 行は機能ごとの flag で分かれている。

| 依存 | Experience が受け取っているもの | 止まると |
| --- | --- | --- |
| ホストのログイン（NIHO app-connect の交換・更新・失効） | NIHO のアクセストークン（cookie に封入。サーバー側のセッション表は無い）、表示名 | `/host` 全体 |
| 本人の照会（Host v1 `identity`。ホストの要求ごとに 1 回） | NIHO user ID と `ACTIVE`。これで `provider_memberships` と販売者 profile を引く | `/host` の全ページと操作 |
| 口座の照会（Host v1 `connect-account`） | 口座 ID、readiness、再利用同意。5 分有効の snapshot にして公開の判定に使う | 下書き・編集・公開・再開（checkout は Stripe に直接照会するので止まらない） |
| Admin のログイン（app-connect と NIHO Firebase の custom token、要求ごとの Admin session 照会） | NIHO user ID | `/admin` 全体（DB だけで動く予約・掲載先・運営停止も含む） |
| NIHO にある業務 API | Admin の支援・運営・手数料、ホストの支援設定・履歴、共同ホスト、通訳ルーム、記事連携、準備 | それぞれの flag の機能 |
| 公開サイトの解析設定 | 解析の ID | 解析だけ（失敗時は送らない） |

NIHO の user ID は、`provider_memberships.niho_user_id`、販売者 profile の `seller_niho_account_ref`、公開の readiness、push の購読（NIHO の connection ID も）と、操作者を記録する約 15 の migration の `*_niho_user_id` 列に入っている。

## 決定

### 1. ホストの本人は Experience が持つ

- Experience にホストのアカウントを置く。ログインはメールの使い捨てリンク（パスワードなし）。Google でのログインは、必要になったら追加できる形にする。
- 提供者の権限（OWNER・EDITOR・VIEWER・OPERATOR）は、Experience のホストアカウントに結び付ける。最初の OWNER は Admin が登録し、運営者は OWNER がメールで招待する。
- NIHO アカウントとの結び付けは必須にしない。記事連携など、NIHO の機能を使うときだけ任意で結び付ける。

### 2. 販売者と受取口座は Experience が持つ

- 販売者は Experience の提供者（事業者）であり、個人ではない。受取口座（Stripe の connected account ID）は提供者に保存し、Experience の販売ではこれを正本にする。
- 口座が使えるか（readiness）は、Stripe へ直接照会する。checkout ではすでにそうしている（`retrieveConnectedAccount`、2026-10-31 のオーナー決定）。公開の判定も同じ照会に揃える。
- Experience での口座の利用同意は、OWNER が Experience の画面で、版付きで記録する（掲載同意と同じ形）。NIHO 側の再利用同意（niho-app #19864）は使わない。
- NIHO で接続済みの既存口座（初回のコミュニティディナーの受取口座など）は、Admin が事業者と口座を確認して登録する。登録は監査ログに残す。
- 新しい販売者の口座は、Experience が Stripe の Express アカウントを作り、Stripe がホストする本人確認（Account Links）で接続する。Experience は本人確認書類を扱わない。

### 3. Stripe のプラットフォームは共有し、キーと webhook は分ける

- Stripe のプラットフォームは NIHO と同じものを使い続ける。プラットフォームを分けると、既存の口座は本人確認からやり直しになる（Stripe の口座は 1 つのプラットフォームにしか属せない）。プラットフォームは Stripe 上の資源で、niho-app のコードではないので、共有しても Experience の配備は NIHO に依存しない。
- Experience は、NIHO アプリのキーを共有しない。Experience 専用の制限付きキー（呼ぶ API だけの権限）と、Experience 専用の webhook endpoint を使う。
- プラットフォームの分離は、外部の販売者が増えたとき、または事故時の影響範囲を NIHO と分ける必要が出たときに再判断する。

### 4. Admin の認証は Experience が持つ

- Admin は Google Workspace（`niho.life`）のアカウントでログインし、Experience 側の許可リストで権限を決める。Workspace の 2 段階認証を前提にする。
- NIHO の Admin session（`/api/auth/app-connect/experience-admin/session`）は使わない。

### 5. NIHO にある業務 API は販売の前提にしない

- 共同ホストの招待は Experience で行う（`provider_memberships` は既に Experience にある）。NIHO の `experience-providers/{id}/members` は使わない。
- Admin の予約・掲載先・運営停止・代理公開は、Experience の DB だけで動く。Admin のログインが Experience に移れば、NIHO が止まっても使える。
- 旧 NIHO の支援・運営・手数料・準備の API（`ADMIN_SUPPORT_READ_API_ENABLED` などの flag）は使わない。Experience に同等の機能があるものはそれを使い、無いものは必要になった時点で Experience に作る。
- 通訳ルームと記事連携は NIHO の機能なので、任意の連携として flag の裏に残す。販売の前提にはしない。
- 公開サイトの解析の ID は、Experience の設定（環境変数）に持つ。

### 6. niho-app に残すもの

- NIHO アプリ自身の口座管理（NIHO の会員と Stripe の結び付け）は NIHO に残す。Experience の販売には使わない。
- 記事ライターの権限と招待（Editor 連携）は NIHO と Editor の機能なので残す。Experience の販売とは独立した flag で扱う。
  - 2026-11-07 補足：Editor から Experience への公開は止めた。記事は Experience の `/write` で書く。ライター権限と記事連携の正本は NIHO のまま残し、OWNER 以外のライターは NIHO ログインへ戻した後に `/write` で書く（[ADR 0002 ガイド記事](0002-guide-content.md)の「2026-11-07」、#481）。
- 非公開リポは、公開できない業務コードがセキュリティ上必要になった場合だけ作る。現時点で該当するものは無い。秘密は Secret Manager に置き、リポには置かない。

## セキュリティ

- **メールのログインリンク**: 32 バイトの乱数で、保存は SHA-256 だけ。15 分・1 回限り。リンクを要求したブラウザに結び付ける（同じブラウザの cookie と照合）。トークンは URL の fragment に置き、ログ・計測・Referrer に出さない。メールアドレスと IP ごとに回数を制限し、アカウントの有無で応答を変えない。
- **セッション**: サーバー側に保存し（ハッシュ）、cookie は HttpOnly・Secure・SameSite=Lax。アイドルと絶対の期限、ログアウト、Admin による強制失効。権限は毎回 DB から読む。
- **重要な操作**: 受取口座の Stripe ダッシュボードを開く、口座の利用に同意する、公開する、の 3 つは、直近のログイン（30 分以内）を要求する。
- **口座の取り違え防止**: 口座 ID をブラウザから受け取らない。Admin が登録したもの、または Experience が作ったものだけを使う。
- **Stripe のキー**: Experience 専用の制限付きキーにし、権限は呼ぶ API だけにする（Checkout、PaymentIntent・Charge の読取、返金、Account の読取と作成、Account Links、ログインリンク、残高・入金の読取、手数料の読取、Transfer）。NIHO アプリのキーとは別にする。
- **監査**: 口座の登録、利用同意、権限の変更、強制失効を監査ログに残す。

## 移行

本番にはまだ Experience の公開版も、NIHO ログインで使っている実ホストも無い（旧登録はテスト・予約 0 件、ADR 0002 の 2026-11-04 追記）。そのため、データの移行ではなく、新しい認証で本番を始める。

1. 新しい認証と口座の判定を flag の裏に入れ、staging で受入する。
2. 本番は新しい認証で公開を始める。niho-app #19917・#19864 は不要になる。
3. 受入の後、NIHO の app-connect・Host v1・旧ホスト API を呼ぶコードと設定を撤去する。

操作者を記録する `*_niho_user_id` 列は、当面は名前を変えずに Experience のホスト ID（`hst_` で始まる）を入れる。NIHO の user ID と形が違うので混ざらない。列名は撤去の段階で `*_actor_id` に揃える。staging の合成データは作り直す。

push の購読は NIHO の connection ID ではなく、Experience のセッションに結び付け直す。

## 実装の順序

1. Store: ホストアカウント、ログインリンク、セッション、権限の結び付け直し（migration）
2. Web: `/host` のメールログインとセッション。権限の読込を Experience の中で完結させる
3. 公開の判定: Stripe への直接照会、Experience での口座の利用同意、Admin の口座登録
4. Admin: Google Workspace でのログインと許可リスト
5. 配備: flag の表、Secret（制限付きキー・webhook の署名鍵）、staging の受入、本番
6. 撤去: NIHO の app-connect・Host v1・旧ホスト API の呼び出しと設定
