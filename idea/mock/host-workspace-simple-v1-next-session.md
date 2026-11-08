# 別セッションへの指示：ホスト設定の未接続機能を完成させる

以下を次のセッションへそのまま渡してください。

---

niho-experience のホスト設定で、現在「準備中」「現在利用できません」と表示される機能を調査し、必要な実装・接続・対象テストを行って、レビュー可能な PR まで進めてください。本番への配備・flag の有効化はこの依頼には含めません。

UI の整理はオーナー承認済みで、別セッションが `paneB-4/host-workspace-simple` で実装しています。基準モックは `idea/mock/host-workspace-simple-v1.html`。このモック、`HostNav.tsx`、`HostShell.tsx`、`HostPublicationWorkspace.tsx`、設定ページの配置・表示用部品を並行して書き換えないでください。通知・チーム・販売者表示の実装側は保存処理・API・repository・専用パネルを担当し、配置に必要なpropsや部品が変わる場合は変更範囲を明示してください。共通の `HostSettingsForm.tsx` は未接続機能側が保存・販売者表示の一本化を先に担当し、UI 側はその差分確定後に表示用sectionだけを接続します。UI 側は設定一覧・設定pageの組み立て・新規表示helperを担当します。

## 作業環境と正本

- `AGENTS.md`、`docs/architecture.md`、`docs/adr/0003-experience-independence.md`、`docs/host-accounts.md`、`docs/development.md` を先に読む。
- 関連 Epic は #84。#109（通知）、#170（旧 provider operations consumer）、#379（販売者表示）を手がかりに既存 Issue/PR の状態を確認し、現状と担当範囲を宣言する。過去 Issue の本文より最新の ADR・オーナー決定を優先する。
- 空いている既存 paneB を、dirty・未マージ commit・他作業を確認したうえで使う。新規 worktree・stash・他作業の破棄は禁止。paneB-2 を空席と決めつけない。
- production 変更は `implementation-routing` に従う。調査・契約・レビュー・PR は本体が担当する。
- ホスト本人と権限は現行 Experience セッション・membership を正として扱う。移行中の NIHO API 依存を、そのまま新規開発の前提にしない。NIHO 本体の追加実装・配備を完了条件にしない。
- 実顧客・メール・住所・Stripe ID・token をログ、fixture、Issue、スクリーンショットへ出さない。

## 1. 通知設定の読取・保存を実接続する

入口:

- `apps/web/src/host/notification-settings-server.ts`
- `apps/web/src/host/notifications.ts`
- `apps/web/src/components/host/HostNotificationPanel.tsx`
- `apps/web/src/components/host/HostSettingsForm.tsx`
- `packages/experience-store/` の通知設定 repository と migration `0020`
- `HOST_NOTIFICATION_SETTINGS_ENABLED` と、その DB・セッション前提

まず「準備中」の原因を flag 未設定・DB 未接続・membership・旧 access token 前提・未実装のどれかに分ける。既存 repository を利用し、同じ通知設定を別テーブルや別 API で重複実装しない。

利用者が変えられるのは `GUEST_MESSAGE`、`DAY_BEFORE_SUMMARY`、`NEW_REVIEW` の3種類。`NEW_BOOKING`、`CANCELLATION`、`EMAIL_DELIVERY_FAILED`、`LISTING_SUSPENSION` の必須通知は常に有効にする。必須通知を止める機能を実装しない。

変更可能な3設定は、現行セッションの現在 OWNER が対象 provider の値だけを読み書きできること、再読込で保持されること、メール producer / job が対応する設定を実際に参照することを検証する。通知先メールは既存の確認フローを維持し、ログイン用メールの変更と混同しない。HTTP/DB 失敗を合成の成功に置き換えない。

UI 整理側では、変更可能な3項目をスイッチにし、必須通知4項目は「常に通知」の一覧へまとめる予定。

## 2. チーム管理を Experience の現在権限で成立させる

入口:

- `apps/web/src/components/host/HostOperatingTeamPanel.tsx`
- `apps/web/src/lib/host/provider-operations-server.ts`
- `apps/web/src/app/(host)/host/api/` の member 操作
- provider operations の現行契約と Experience の membership / host account repository

現行 consumer は旧 NIHO API や access token を前提とする部分がある。flag を有効にするだけで完成と扱わない。既存 Experience の招待・メンバー機構が使えるか調べ、追加・解除・再読込までこのリポで完結させる。

- OWNER が対象提供者のメンバーだけを一覧・追加・解除できる。
- 追加する役割とアクセス範囲を確定前に示す。最終 OWNER を失う操作や、別 provider の所属変更を許可しない。
- COHOST / EDITOR / 商品限定 OPERATOR を区別し、商品限定の人へ提供者全体の予約・売上・ゲスト情報を広げない。
- 権限を外した後は、既存セッション・開いている画面・書込 API でも権限失効が反映され、非公開情報が画面に残らない。
- 未登録の人の扱いは既存招待仕様を確認する。検索 API からアカウントの存在を無制限に列挙できる構成にしない。

## 3. 販売者表示の古い「準備中」を既存機能へ一本化する

入口:

- `docs/provider-seller-disclosure.md`（#379）
- `/host/seller` と `HostSellerDisclosureForm`
- `apps/web/src/components/host/HostSettingsForm.tsx` の販売者表示欄
- `packages/experience-store/src/provider-seller-disclosures.ts`

専用画面には既に `NATIVE` / `EXTERNAL` / `WITHDRAWN` の仕組みがある。古い設定にある「NIHO のページに表示する（準備中）」を、新機能として一から作らない。`NATIVE` は本人が明示入力した公開専用情報を体験サイトへ表示する機能であり、NIHO が販売者を代理する機能ではない。既存専用画面と同じ正本・契約へ接続し、重複入力・二重保存・意味の異なる同意を整理する。

- 法的販売者名と受取口座 mapping は運営が登録した正本を保持し、ホストから差し替えさせない。
- Stripe KYC や NIHO 本人情報から非公開住所・電話をコピーしない。
- 公開内容の本人確認、同意版、version、結果不明 command の再送、撤回後の再公開防止を維持する。
- 表示の撤回、公開商品の読取境界、既存予約 snapshot を変更しない。

## 4. 「操作できない」の理由を誤分類しない

- 必須通知、法的販売者の同一性、Stripe の口座状態、権限不足で変更できない項目は、未実装とは区別する。
- 提供者の種別や法的販売者名を単に editable にしない。変更が必要なら公開プロフィール・運営登録の販売者・受取口座のどれに属する値かを確定する。
- 一時的に使えない状態、読込失敗、設定不足を区別し、必要な理由と再試行先を残す。
- 自己公開・停止・再開の現行方針を守り、旧審査・保存時停止を復活させない。

## 完了条件

1. 各機能の「既存実装」「接続不足」「新規実装が必要」「運用上の有効化待ち」を証拠付きで整理する。
2. 対応する契約・実装・対象限定テストを揃え、設定値・権限・結果が再読込でも正しいことを確認する。
3. 自前セッション / 別 provider / OWNER 以外 / 権限失効 / 競合・結果不明 / 401・403 / DB失敗を対象に、必要なテストを実施する。
4. 未提供と権限不足を混同せず、使えない操作を成功に見せる mock fallback を入れない。
5. 本番データへ書き込まず、合成 fixture と対象テストで検証する。重い全件検証は同等の CI に任せる。
6. PR には問題・最終挙動・検証結果・残る配備条件を書く。flag の本番有効化や配備完了を、コードの merge と同一視しない。
7. UI 整理モックへの変更は行わず、後で UI 側が接続すべき部品・API・必要条件を報告する。

---

## この指示の作成時点の証跡

- 2026-11-08、本番 `/host/settings` で通知「準備中」、サブホスト管理「現在利用できません」、古い販売者表示の無効な選択肢を確認した。runtime flag・DB・権限の実状態までは未調査。
- ローカル `cb6d4368` 時点では通知 repository と server action、チーム UI と旧 API consumer、販売者専用画面が存在する。
- 改善モックは画面内の合成状態だけで動く。モックの成功表示は実装・配備・受入の証跡ではない。
