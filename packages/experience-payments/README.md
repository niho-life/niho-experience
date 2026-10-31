# `@niho-experience/experience-payments`

Server-only Stripe boundary for NIHO Experience Checkout. It creates Stripe-hosted Checkout Sessions as **Direct charges** on the connected account snapshotted onto a booking, and validates the narrow webhook events that may confirm payment. It does not write to the database and does not process refunds.

## Trust boundary

- Call `createDirectCheckout` only with the immutable `BookingRecord` returned by Experience Store. Amount, currency, connected account and the displayed occurrence title are derived from its pricing, seller and occurrence snapshots. Never accept replacements for these fields from a browser.
- The application fee is a charge-defining field too. A guest booking (#285) carries NIHO's fee in `pricingSnapshot.platformFee` (taken from the provider's sale settings when the booking was made), and Checkout charges exactly that: leave `applicationFeeAmount` out, or pass the same amount; another amount, or a guest booking without the snapshot, is refused. Only a booking without a fee snapshot takes a server-calculated `applicationFeeAmount`. Either way the fee must be positive and smaller than the booking total.
- Supply `returnOrigin`, `returnPath` and the optional `cancelPath` (Stripe's `cancel_url`) from trusted server configuration or a strict allowlist. HTTPS is required except for localhost development, and cross-origin paths and fragments are rejected for both paths. The return URLs carry no booking or Checkout identifier; payment confirmation comes only from the webhook.
- The optional `customerEmail` only prefills Stripe's own email field (`customer_email`). Pass it from the booking's guest record, omit it once the guest data is erased, and never copy it into metadata. A refused address is not repeated in the error message.
- Supply either a server-side platform Stripe API key or an injected Stripe client. Prefer a restricted key with only the Checkout Session permissions this service needs, store it and the webhook secret in Secret Manager, and use separate keys per environment. Keys, endpoint secrets, raw bodies and Checkout response objects must not be logged. This package itself does not log.
- Only the source marker and opaque `booking_id` are stored in Stripe metadata. Guest name, email, phone, address and other PII must never be added to Stripe metadata.

Checkout is initially restricted to `card` with Stripe Node 22.6.0's typed Checkout `payment_method_types` parameter. This is an intentional exception to dynamic payment methods: the current short booking hold cannot safely reserve inventory until a delayed payment settles. The validator still requires `payment_status=paid`; `checkout.session.async_payment_succeeded` is accepted defensively, but only when paid. Adding delayed or dynamic payment methods requires a separate fulfillment, inventory and hold-expiry design.

Stripe requires a custom Checkout expiry to be 30 minutes through 24 hours after creation. This package makes expiry earlier than `holdExpiresAtUtc` by a positive safety margin (60 seconds by default) and refuses holds too short to satisfy Stripe's 30-minute minimum with `ExperiencePaymentsHoldTooShortError` (a subclass of `ExperiencePaymentsValidationError`), which a caller can treat as an expired hold. The booking API must therefore create a hold longer than 31 minutes before calling this package; guest holds last 35 minutes.

The Stripe idempotency key is `experience-checkout:{bookingId}`, and every parameter derives from the booking, so a repeated call for the same booking returns the same Session while Stripe keeps the key (24 hours, far beyond any hold).

## Webhook integration requirements

Pass the exact raw request bytes, the `Stripe-Signature` header and the Connect webhook endpoint secret to `verifyDirectCheckoutWebhook`. The function uses Stripe's official `constructEvent` verification and accepts only:

- `checkout.session.completed` with `payment_status=paid`
- `checkout.session.async_payment_succeeded` with `payment_status=paid`
- `checkout.session.expired` and `checkout.session.async_payment_failed` (#285 slice 4) with any `payment_status` but `paid`, returning the Checkout Session ID instead of payment fields. The caller passes them to `GuestBookingRepository.releaseGuestHold`, which gives the hold back only when the booking is still held, the Session is the one recorded for it and the account is its seller's.

Every accepted type passes the same envelope checks: event ID, connected account, event time, a payment-mode Session, and metadata with exactly the source marker and a UUID v4 `booking_id`.

Before creating Checkout, the caller must use NIHO's trusted server-to-server account contract to verify that the snapshotted connected account still belongs to the seller and its v2 merchant `card_payments` capability is active. For experiences sold on this site the owner decided on 2026-10-31 (#330) to check the account directly with Stripe instead: `retrieveConnectedAccount({ accountId, platformStripeKey | stripe })` reads it with the experience platform key and answers `ready` when it has charges and payouts enabled, its details submitted, `JP` as its country and `jpy` as its default currency, `not_ready` with the failing items otherwise, or `unreachable` when Stripe will not show it to the platform (not connected, or a key without read access to connected accounts); any other failure throws. The answer carries the last 4 characters of the ID and the checked facts only. The operator's registration script (`scripts/experience/register-site-sale.mjs`, docs/guest-booking.md) calls it before it registers a product and again before it opens the sale.

Before calling `ExperienceStore.confirmBookingPayment`, the route must load the booking in its trusted provider scope and atomically check all of the following against the returned values:

1. `publicBookingId` identifies the held booking.
2. `connectedAccountId` exactly equals `booking.sellerSnapshot.stripeConnectAccountRef`. This prevents a valid event from a different shared NIHO connected account confirming the booking.
3. `amountTotal` and `currency` exactly equal `booking.pricingSnapshot.totalAmount` and `booking.pricingSnapshot.currency`.
4. The event ID is processed through Experience Store's idempotent payment ledger. Never confirm from the success redirect.

The endpoint must be configured as a Stripe Connect webhook so the signed Event contains `account`. Events without `source=niho-experience` are acknowledged and ignored, so NIHO app payments on the shared platform stay separate. Missing connected account IDs, unpaid experience events, malformed experience metadata, invalid amounts and invalid payment references are rejected. The package intentionally does not retrieve objects, mutate booking state, issue refunds or decide provider scope.

## Public API

- `createDirectCheckout(input)` returns only `checkoutSessionId` and the Stripe-hosted `checkoutUrl`. The public checkout route (`apps/web`, docs/guest-booking.md) records the Session on the booking with `GuestBookingRepository.attachCheckoutSession`.
- `verifyDirectCheckoutWebhook(input)` returns, for a paid Session (`VerifiedDirectCheckoutPaidEvent`), the validated event ID/type/time, connected account ID, booking ID, PaymentIntent reference, amount and uppercase currency; for a Session that ended unpaid (`VerifiedDirectCheckoutEndedEvent`), the event ID/type/time, connected account ID, booking ID and Checkout Session ID; or `null` for an unrelated event. `isEndedCheckoutEvent(event)` tells the two apart.

Use Stripe Node SDK `22.6.0` on Node 24. All repository tests use synthetic identifiers and secrets.
