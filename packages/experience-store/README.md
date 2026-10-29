# `@niho-experience/experience-store`

PostgreSQL is the source of truth for provider-scoped experience products, recurring schedules, Google busy windows, booking holds, confirmed bookings, the payment ledger foundation, and guide drafts/publication snapshots.

## Trust boundary

- Host methods take `HostActor` and verify an active `provider_memberships` row. The caller must first authenticate the NIHO user; this package owns the experience-side membership check.
- Guest booking and worker methods take `ProviderScope`. The server route or worker must establish that provider scope before calling the store. Every SQL statement also filters by `provider_id`.
- Calendar storage accepts only an opaque calendar ID and interval boundaries. Event titles, descriptions, attendees, and OAuth credentials have no columns or API fields here.
- Stripe signatures and API calls stay outside this package. `confirmBookingPayment` accepts only a previously verified event and provides event deduplication, an append-only ledger entry, and an outbox message in the same transaction.
- Guide methods take a NIHO stable user ID after authentication. `guide_writer_grants` contains only accepted writer IDs. NIHO remains the source of truth for accounts, verified email, invitation delivery/state, and acceptance; none of those invitation fields are stored here.
- Provider `OWNER`/`EDITOR` authority and `guide_product_link_memberships` are separate. The latter permits only creation of an article/product relation and never grants product editing, booking, guest, or payout access. A guide remains creator-private even when its publication subject is a provider.
- A provider-subject guide can link only that provider's published products. A writer-subject guide can link products from any provider for which the link actor has current authority.
- `getArticle` is the authenticated creator-only draft/preview read. Public reads select only a sealed `current_publication_id`; they never select draft columns. `UNLISTED` is still public to anyone who knows its slug and must be emitted as `noindex` by the later SSR layer. It is excluded from `listPublicArticles`. Stopping publication clears only the current pointer and preserves prior immutable snapshots.
- Guide `content` is a selected JSON object containing Markdown and public author metadata, never rendered HTML. This package does not render it. The editor/API must run the full Markdown, fact, image-rights, and related-record inspection before calling `commitPublication`; that server inspection and all HTTP exposure are intentionally outside this migration.

## Migrations

Apply `migrations/*.sql` in lexical order with the deployment migration identity. `0001_experience_store.sql` is transactional and does not require a PostgreSQL extension. Provider and first OWNER membership provisioning is intentionally outside the host repository API; onboarding must insert those rows from a separately authorized server workflow.

`0005_guide_cms.sql` additively creates guide categories, accepted writer/link grants, creator-private article drafts, sealed publication snapshots, and publication-scoped product links. Category and article slugs are stable identities; an article slug becomes immutable after its first publication. Category labels and order are copied into every publication so later category edits or deactivation do not rewrite history. `GuideRepository.commitPublication` locks the draft, verifies its revision/current authority/category/products, inserts the snapshot and authorized links, seals it, and switches `current_publication_id` in one transaction. Public link reads also require the product to remain `PUBLISHED` and the recorded link creator's permission basis to remain active.

The code-backed `kamakura-after-4-pm` slug is reserved at the database boundary until #189 imports that article. The import must delete its reservation and create the matching database article in one transaction before switching public readers.

The migration does not change the current code-backed `/guides` pages. Editor authentication, invite/acceptance APIs, category admin APIs, upload storage, complete pre-publication inspection, HTTP contracts, SSR/SEO/sitemap reads, cache invalidation, and migration of existing code-backed guides remain follow-up work.

Schedule rules use optimistic versions. Booking hold creation derives the requested occurrence with `@niho-experience/experience-domain`, materializes it, and locks both its schedule rule and occurrence row. All hold creators therefore serialize on one occurrence before counting active holds and confirmed seats.

`0006_calendar_commands_and_sales_state.sql` は旧 `CLOSE` 行をversion付き販売状態へ移し、日時変更を別に保持する。カレンダー保存・UUID command・専用 `calendar_outbox_events` を同じtransactionで記録する。同じcommandの再送は保存済みの結果を返し、異なる入力への使い回しは拒否する。通知outboxの処理位置とは独立している。

### 0006の配備順序

`0006` は停止を伴う移行とする。旧アプリは `schedule_occurrence_overrides` へ `CLOSE` を書くため、移行後に旧writerを使えない。また、旧readerは「日時を移動したうえで休止」を表現できない。

1. カレンダー・予約の更新受付を停止し、旧revisionとworkerの処理終了を待つ。対象表を使用中のtransactionがないことを確認する。
2. 復元確認済みのsnapshotまたはPITR復元点を確保する。顧客データをログへ出さず、旧 `CLOSE` と `RESCHEDULE` の件数を記録する。
3. migration専用権限で `0006` を適用する。旧 `CLOSE` のoccurrence ID・version・作成更新時刻が販売状態表へ引き継がれ、日時表には `RESCHEDULE` だけが残ることを確認する。
4. runtime roleへ新規3表の必要最小権限を付与する。販売状態表はSELECT/INSERT/UPDATE、command表はSELECT/INSERT、outbox表はINSERTとidentity sequenceの利用。将来のconsumerの読取・更新権限は別に設定する。
5. 対応する新revisionだけを配備し、読取・追加・日時変更・休止・再開を確認してから受付を戻す。旧新writerを同時稼働させない。

受付再開前の切戻しは、新revisionを停止し、移行前snapshotを復元して旧revisionへ戻す。新しいカレンダー更新・予約が発生した後は、アプリだけを戻してはいけない。受付を止め、新revisionで修正するか、command・outbox・日時・販売状態を照合する復旧計画を作る。後から入った予約を失うsnapshot上書きは行わない。

## Tests

`npm test` runs tests that do not require a database. When `TEST_DATABASE_URL` points to a disposable PostgreSQL database, integration tests create and drop isolated schemas. They exercise concurrent capacity enforcement and guide draft privacy, optimistic revision conflicts, atomic snapshot/link switching, immutable history, unlisted/listed reads, permission rechecks, and publication stopping.
