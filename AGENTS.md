# NIHO Experience 作業ルール

- オーナー向け報告、Issue、PR、仕様文書は日本語。旅行者向けUIは英語を先行する。
- まず対象Issueと `docs/architecture.md`、UI変更では `docs/design-brief.md` を読む。優先順は顧客UX、開発・運用速度、コスト。
- 担当Issue・触るファイル範囲・依存するAPI版を着手時に明示する。同じファイルの並行編集は担当を決める。対象外の差分を変更・破棄しない。
- niho-experience の実装には固定の4 worktree `~/Documents/app/NIHO/niho-experience-paneB-1`、`niho-experience-paneB-2`、`niho-experience-paneB-3`、`niho-experience-paneB-4` を使う。作業ごとに空いている seat を選び、その worktree で branch を切り替えて再利用する。1 seat に1 worktreeとし、同じ worktree を複数の作業で同時編集しない。topic や修復のために worktree を追加せず、追加が必要な場合はオーナーの明示指示を受ける。既存の他 worktree や作業差分は勝手に変更・削除しない。
- このリポの担当は公開サイト、SSR/SEO、表示用ロジック、限定された公開APIクライアント、ホスト（提供者）の画面 `/host`。認証元、DB、権限、価格・在庫の確定、決済・返金・台帳を重複実装しない。
- ホストの画面は `/host` に作る（オーナー決定 2026-10-21・#84）。ログインはNIHOの確認画面と一度きりのコードで受け取り、権限の判断と正本はNIHOのAPIに任せる。トークンはサーバーだけが持ち、ブラウザのJavaScript・storageに渡さない。NIHOの認証cookieは共有しない。旅行者はゲスト予約。
- 実データ、顧客・提供者の非公開情報、未公開原稿、内部スキーマ、秘密鍵、DB接続情報をコミットしない。fixtureは合成データに限る。素材の掲載許諾を確認する。
  - 例外（オーナー決定 2026-10-19）：オーナーが掲載許可を確認した体験は、推奨値と明記したテストサイト用のpilot fixture（`packages/api-client/src/fixtures/pilot-experiences.ts`）に入れてよい。写真は仮素材とし、レビュー・販売実績・実際の残席・連絡先は入れない。本番の表示には使わない（`docs/content/README.md`）。
- 公開PRのCI・プレビューは秘密なし、合成データ、GitHub-hosted runnerを基本にする。社内runnerや本番データへ接続しない。外部PRコードを資格情報付きで実行しない。
- 公式配備はレビュー済みの固定SHAを対象にする。ビルド工程と配備権限を分ける。アプリ入力・予約tokenをログ、計測、録画、公開cacheへ流さない。
- API型はNIHO側が正本。初期モック契約は仮契約と明記し、契約合意後に選別された配布物へ置き換える。互換変更はAPIを先に配備する。
- NIHO共通基盤の変更を要する場合は連携担当へ集約する。こちらの画面変更の都度、共通基盤側へPRを作らない。必要な安全性検証は省略しない。
- `main` へは PR だけ。必須チェック `premerge-gate` と未解決スレッドの解決は ruleset が強制する。PR を作ったら自己確認のあと `ghN pr merge <PR> --auto --squash` を設定してよい。CI のトリガーに `paths` / `paths-ignore` を足さない（`docs/development.md`「PR とマージ」）。
- GitHub操作は `ghN`。秘密・個人情報を公開Issueへ貼らない。1 Issue 1 PRを機械的な必須条件にせず、レビュー可能な単位で関連Issueをまとめられる。
- 本番コードを変更する際は利用環境の `implementation-routing` 方針を確認する。変更に応じた検証を行い、未実施項目は理由を記録する。
- 個別のサービス名、公開ドメイン、販売条件、素材の利用権を未確定のまま本番公開しない。ダミーのレビュー・販売実績・残席表示を実績として見せない。
- 公開サイトのヘッダー、余白、レイアウト、スタイルはコードを正本とする。旧 `PageDocument` / source-display は保存済みデータを残しても公開描画・SEO・カタログ取得へ接続しない。新画面をeditor schema、preview、保存版へ同期することを受入条件にしない。
