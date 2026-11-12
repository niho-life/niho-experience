# 開催回の担当（#535 v0）

NIHO販売（完全代行・承認後決済 #515）の開催回に、社内の担当を1人置く。2026-11-13のオーナー決定：担当できる人にまとめて知らせ、行ける人が「対応する」を押すだけで担当になる。NIHOによる指名・承認を担当確定の条件にしない。LINEなどで声をかけ、事務局が代わりに記録しても回る。

`EXPERIENCE_OCCURRENCE_ASSIGNMENT_ENABLED`（既定 `false`。要 `HOST_CONSOLE_ENABLED`・`EXPERIENCE_MANAGED_SALES_ENABLED`・DB）。migration `0073_occurrence_assignments.sql` を新しいコードより先に適用する。

## 決めたこと

- **担当は開催回に1人**（予約ごとではない）。同じ回に後から入った予約は、決まっている担当がそのまま受ける。受付の担当と当日の担当は分けない。
- **対象の回**：NIHO販売の承認後決済（`salesPlan=MANAGED_20`・`acceptanceMode=APPROVAL`・`chargeMode=PLATFORM`）で、まだ生きている申込（承認待ち・承認済みで在庫を押さえている）か確定した予約があり、開始がこれから。期限切れ・辞退・取消・即時決済の予約だけの回は対象外（引受を拒否する）。
- **担当できる人**：新しいチームのモデルは作らない。`provider_memberships` の現役の OWNER・COHOST（NIHOの役割の上限を超えない）と、`product_operator_grants` の有効・期限内の商品限定運営者（#196）。EDITOR・VIEWER・解除済み・他の提供者・他商品は拒否する。権限表・招待は #528。
- **対応する**：先に有効に受理した1人だけが担当になる（`occurrence_assignments` の「開いた期間は回ごとに1行」の部分一意索引が最後の砦）。後から押した人には「担当済み（`TAKEN`）」を返し、既存の担当を奪わない。同じ人の二重クリック・再送は `ALREADY_YOURS` で何も足さない。操作ごとの `commandId`（UUID）は最初の結果を返し、別の内容での再利用は 409。
- **行けません**：任意の入力。押さなくても進む。1人の「行けません」で申込み全体は取り消さず、予約の状態も変えない。担当本人は「行けません」ではなく「担当を外れる」を使う。
- **担当を外れる**：担当本人（または事務局）が外すと募集中に戻る。予約者の予約・承認・支払いの状態は変えない。
- **履歴は追記だけ**（`occurrence_assignment_events`。更新・削除・TRUNCATEをDBのtriggerで拒否）：いつ／だれが／何をした（対応する・行けません・担当を外れた・合意した額の記録）／理由（任意）。事務局が代わりに記録したものは `recorded_by=ADMIN`。担当の期間（`occurrence_assignments`）も削除せず、外れた期間は読み取り専用になる。
- **報酬**：開催回の担当期間ごとに「合意した額（円）」を事務局が手で入れる欄を1つ（空＝未設定）。計算・分配・送金・支払済みの管理はしない。提供者への精算（#509）の数字・予約時のsnapshotは変えない。担当が代わると次の人の期間は未設定から始まり、前の期間の額は履歴に残る。担当本人には本人の額だけを見せ、他の人の額・履歴上の額は見せない。
- **予約者には出さない**：予約者向けの画面・メール・通知は、内部の担当や割当を一切読まない。担当の確定は、承認・支払い・予約の確定・報酬の確定のどれでもない（`bookings`・`booking_guests.approval_status`・精算を書かない）。

## 画面

- **担当できる人**（`/host/bookings`）：上に「担当」。募集中の回の一覧と「対応する」「行けません（理由は任意・事務局だけが見る）」、「あなたが担当」の回の「担当を外れる」・本人の合意した額・履歴。予約の詳細にも「担当」（あなた／別のメンバー／募集中）と履歴を出す。他のメンバーの名前は見せない（「別のメンバー」）。商品限定運営者のホスト画面はv0では対象外で、事務局が代わりに記録する。
- **事務局**（Admin ›「サイト予約の取消・返金」の「開催回の担当」）：担当が決まっていない回を先頭に、だれが「行けません」と答えたか、担当の記録（対応する／行けません／外れた を代わりに記録）、合意した額、履歴（名前・理由・額つき）。担当候補は担当できる人のうち、その回で記録できる人だけ。

## 実装の置き場所

| 何 | どこ |
| --- | --- |
| 担当・履歴のDB | `packages/experience-store/migrations/0073_occurrence_assignments.sql` |
| 状態を変える・読む | `packages/experience-store/src/occurrence-assignments.ts`（`OccurrenceAssignmentRepository`） |
| ホストの画面・Server Action | `apps/web/src/host/assignments-server.ts`・`apps/web/src/host/actions.ts`・`apps/web/src/components/host/HostAssignments.tsx` |
| 事務局のAPI・画面 | `apps/web/src/app/(admin)/admin/api/occurrence-assignments/route.ts`・`apps/web/src/components/admin/AdminOccurrenceAssignments.tsx` |
| runtime roleの権限 | `scripts/gcp/experience-db-grants.mjs`（events は INSERT のみ、assignments は INSERT と released_at・agreed_fee_yen・agreed_fee_set_at の UPDATE のみ） |

## まだ無いもの（後続）

- **申込み時点の通知**（担当できる人への push・メール）。いまのホスト向け通知は予約の確定時に出る。v0の①では、事務局が申込みの新着メール（既存）を見てLINEなどで声をかけ、返事を代わりに記録する。②で既存のホスト向けpush・メールの仕組み（`host.notify.*`・`host.mail.*`）に載せる。
- 募集のまま開催が近づいた回の事務局への強調、締切の個別設定、複数人の編成、自動の割当、別日・別条件の提案、報酬の計算、商品限定運営者の画面、権限表（#528）。

## 検証

`packages/experience-store/test/occurrence-assignments.integration.test.ts`（同時の「対応する」で1人だけ確定、再送・二重クリックの冪等、権限の無い人の拒否、追記だけの履歴、予約を変えないこと）、`apps/web/src/host/assignments-server.test.ts`、`apps/web/src/app/(admin)/admin/api/occurrence-assignments/route.test.ts`。いずれも合成データ。本番・stgの有効化と実データでの受入は別。
