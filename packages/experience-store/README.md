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

## Tests

`npm test` runs tests that do not require a database. When `TEST_DATABASE_URL` points to a disposable PostgreSQL database, integration tests create and drop isolated schemas. They exercise concurrent capacity enforcement and guide draft privacy, optimistic revision conflicts, atomic snapshot/link switching, immutable history, unlisted/listed reads, permission rechecks, and publication stopping.
