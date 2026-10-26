# `@niho-experience/experience-store`

PostgreSQL is the source of truth for provider-scoped experience products, recurring schedules, Google busy windows, booking holds, confirmed bookings, and the payment ledger foundation.

## Trust boundary

- Host methods take `HostActor` and verify an active `provider_memberships` row. The caller must first authenticate the NIHO user; this package owns the experience-side membership check.
- Guest booking and worker methods take `ProviderScope`. The server route or worker must establish that provider scope before calling the store. Every SQL statement also filters by `provider_id`.
- Calendar storage accepts only an opaque calendar ID and interval boundaries. Event titles, descriptions, attendees, and OAuth credentials have no columns or API fields here.
- Stripe signatures and API calls stay outside this package. `confirmBookingPayment` accepts only a previously verified event and provides event deduplication, an append-only ledger entry, and an outbox message in the same transaction.

## Migrations

Apply `migrations/*.sql` in lexical order with the deployment migration identity. `0001_experience_store.sql` is transactional and does not require a PostgreSQL extension. Provider and first OWNER membership provisioning is intentionally outside the host repository API; onboarding must insert those rows from a separately authorized server workflow.

Schedule rules use optimistic versions. Booking hold creation derives the requested occurrence with `@niho-experience/experience-domain`, materializes it, and locks both its schedule rule and occurrence row. All hold creators therefore serialize on one occurrence before counting active holds and confirmed seats.

## Tests

`npm test` runs tests that do not require a database. When `TEST_DATABASE_URL` points to a disposable PostgreSQL database, the integration test creates and drops an isolated schema and also exercises concurrent capacity enforcement.
