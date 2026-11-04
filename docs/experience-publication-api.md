# Experience owner-seller API contract

Status: implementation contract for #330 / #369 / #377. The host UI consumes these operations. The product owner is the seller; product requests never select a seller, provider, or payment account. The existing calendar API has its own selected-provider context and validates the logged-in NIHO membership before writing.

## Identity and seller boundary

- The host uses the existing NIHO app-connect session cookie. NIHO access/refresh tokens stay server-side.
- Each request obtains the currently authenticated NIHO user ID and current OWNER authority from the NIHO common account contract. Experience must not trust a user ID or role supplied by the browser.
- Experience resolves or creates the seller's Experience workspace from that verified identity. A stale local membership alone never grants access.
- The same seller owns the configured Stripe Connect destination. The NIHO contract returns the connected account reference and current readiness for that seller; the Experience browser DTO never includes the reference.
- `sellerDisplayName` is the seller's public legal/trade display. It is not copied from Stripe's account label. For the first community dinner, Panasonic is both seller and payout owner; “NIHOkamakura” is only the Stripe account label.
- The host checks current identity and Connect readiness when it reads or changes a product. The public catalog is the durable publication snapshot and does not expire when this short-lived check expires. A different seller and recipient are not modeled for this flow.

## Host operations

All host responses use `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex, nofollow`. Mutations require same-origin requests. The server derives the seller from the session; no route accepts a `providerId` or seller ID from the browser.

### List and create products

`GET /host/api/products` returns the current seller's products with one `version` per product and its publication state.

`POST /host/api/products` creates a new `DRAFT` product for the authenticated seller. The server generates the product ID and connects it to the seller's current Connect account. The request includes only editable product data; it cannot set OWNER identity, readiness, Stripe references, publication state, or booking snapshots. Repeating a slug already used by the same seller returns `409 VERSION_CONFLICT`.

Example request:

```json
{
  "slug": "kamakura-community-dinner",
  "publicTitle": "Kamakura community dinner",
  "content": {},
  "currency": "JPY",
  "unitAmount": 30000
}
```

The seller display name and Stripe destination come from the authenticated seller projection, not this request.

New products are created in Experience. There is no NIHO product import or old-sale cutover step.

### Read and save a product

`GET /host/api/products/{productId}` returns an allowlisted host DTO with `version`, editable draft, sale terms, public media previews, status, and seller display name. It does not return internal seller/provider IDs, Stripe references, meeting access details, or database fields. Schedule rules are managed through the existing host calendar API and remain attached to this product ID.

The existing calendar read is `GET /host/calendar/data?providerId=…&fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD`; it returns product IDs, schedule rules, and their occurrences. A new rule is created with `POST /host/calendar/data` using `{ "providerId": "…", "action": "createRule", "experienceId": "{productId}", "rule": { ... }, "commandId": "{uuid}" }`. The server verifies the current NIHO membership before writing, uses `commandId` as the new rule ID, and returns its numeric `version`. Per-occurrence pause/resume and reschedule writes also use `commandId` plus that occurrence's `expectedVersion`. Existing schedules are not copied from NIHO.

`PATCH /host/api/products/{productId}` replaces editable draft fields and sends `{ "version": "…", "draft": { ... } }`. The opaque `version` returned by the latest read covers the draft, sale terms, and publication state. A valid save while published updates the immutable public version and keeps the product published. Incomplete edits remain in the draft and leave the previous public version intact. Existing bookings do not change.

### Save sale terms

`PUT /host/api/products/{productId}/sale-terms` sends `{ "version": "…", "saleTerms": { ... } }` to replace the complete sale-terms object. The response includes the next version and blocker codes. Saving terms never publishes, stops, or resumes a product by itself. If the product is already published and the new terms are valid, the public version is advanced atomically.

The editable terms include:

```json
{
  "offerPrices": [{ "offerId": "dinner-evening", "adultPriceYen": 30000 }],
  "childPricing": { "priceYen": 12000, "minAge": 0, "maxAge": 12, "adultRequired": false },
  "minimumParticipants": 1,
  "minimumChargeableParticipants": 1,
  "maxPartySize": 8,
  "cancellationPolicy": "CUSTOM",
  "cancellationWindowMinutesBeforeStart": 1440,
  "cancellationRefundBasisPoints": 10000,
  "minimumAttendance": null,
  "bookingQuestions": [],
  "conditionsVersion": null
}
```

This example only documents field shape; its values are not approved product terms. The host must provide explicit cancellation window/refund values. `minimumChargeableParticipants` controls the adult-price floor and is separate from `minimumParticipants`, which controls whether a party may book. `minimumAttendance` is optional operations data and never appears in guest DTOs. It does not automatically cancel or refund a booking. There is no private-group/whole-booking field. `minimumChargeYen` remains Stripe's payment minimum and is not a seller's minimum price.

The public API returns the accepted minimum charge and cancellation rule for guests. The host reservation/session API returns the accepted minimum charge, minimum attendance, and cancellation rule from the booking snapshot. No reader reconstructs them from current product settings.

### Publish, stop, and resume

`POST /host/api/products/{productId}/publish` (also resumes a seller-stopped product) sends `{ "version": "…", "consentVersion": "…", "accepted": true }`. The server checks current OWNER authority, seller/Connect readiness, seller display, consent, product content and photo rights, prices, explicit cancellation terms, NIHO's provider fee configuration, and at least one saleable schedule. A missing provider fee configuration returns `FEE_SETTINGS_REQUIRED`; the seller cannot choose or override it. It never publishes unsaved input.

`POST /host/api/products/{productId}/stop` sends `{ "version": "…" }`. It removes the product from catalog, details, metadata, sitemap, and new checkout admission. Existing bookings and their immutable snapshots remain available.

`POST /host/api/products/{productId}/media` uploads JPEG or PNG bytes. It requires `x-experience-photo-rights-confirmed: true`; `x-experience-photo-alt-text` and optional `x-experience-photo-credit` set public metadata. Adding media advances the draft revision; the response returns the uploaded asset and the updated product DTO (including its next opaque `version`) so the host can publish that exact revision. Until publish succeeds, the active public copy remains unchanged. Object paths and storage details are never sent by the browser.

An operations suspension uses a separate Admin session. Clearing it does not publish; the OWNER must explicitly publish again.

## Public reads and checkout

- `GET /api/public/experiences` returns the current active publications.
- `GET /api/public/experiences/{slug}` returns the same explicit public projection or a non-disclosing 404.
- Public DTOs contain seller display, sale terms needed before booking, and same-origin photo URLs. They omit user/provider IDs, Connect/NIHO references, unpublished drafts, private meeting access details, internal readiness, and minimum attendance.
- Catalog, detail, and availability use the active Experience publication snapshot; they do not expire with the host's short-lived readiness check. Checkout uses only that publication snapshot, calculates selected schedule price and booking conditions in the booking transaction, and saves seller, price, cancellation, minimum-charge, and minimum-attendance snapshots.
- Before returning a new Checkout URL, the server rechecks the exact account in the booking snapshot with Stripe and requires current charge and payout readiness. Stripe then creates Checkout on that same Connect account. If readiness changed, no payment URL is returned; the short booking hold expires under the normal hold policy.
- The Experience checkout has no legacy NIHO fallback or cutover prerequisite. A stopped, suspended, or unpublished product cannot start a new checkout.

## Version and error contract

The host keeps one opaque `version` per product and sends it as `version` on mutations. The server expands it into draft, terms, and publication-state CAS values. A conflict returns `409 VERSION_CONFLICT`; after an unknown timeout, the client rereads before retrying.

| HTTP | `error.code` | Meaning |
| --- | --- | --- |
| 400 | `INVALID_INPUT` | Malformed or unsupported fields |
| 401 | `SESSION_ENDED` / `SESSION_REFRESH_REQUIRED` | NIHO host session is absent, revoked, or needs refresh |
| 403 | `FORBIDDEN` | The current user is not the active OWNER |
| 404 | `NOT_FOUND` | Product is absent or not visible to this seller |
| 409 | `SELLER_PROFILE_AMBIGUOUS` / `SELLER_SETUP_REQUIRED` | NIHO has multiple OWNER seller profiles or the seller lacks a Connect destination |
| 409 | `VERSION_CONFLICT` | The product changed; reread before retry |
| 422 | `INVALID_INPUT` | Structurally valid JSON contains unsupported product values |
| 422 | `PUBLICATION_BLOCKED` | Stable blocker-code array; nothing is partially published |
| 422 | `PHOTO_RIGHTS_CONFIRMATION_REQUIRED` | The seller has not confirmed rights to the uploaded photo |
| 415 | `UNSUPPORTED_FORMAT` | Public host media accepts JPEG and PNG input |
| 502 | `READINESS_UNAVAILABLE` | NIHO identity/Connect state could not be verified |
| 503 | `UNAVAILABLE` | Experience database or required media service is unavailable |
| 413 | `INVALID_INPUT` | Request body exceeds the BFF limit |

Responses never include exception text, credentials, private IDs, or personal data. The UI does not ask the host to repair internal IDs, versions, or NIHO-controlled fee settings; it presents the blocker and the next required action.

## Stable publication blockers

`ACCOUNT_NOT_USABLE`, `CANCELLATION_TERMS_REQUIRED`, `CONNECT_NOT_READY`, `CONSENT_OUTDATED`, `FEE_SETTINGS_REQUIRED`, `MANUSCRIPT_REQUIRED`, `OPERATIONS_SUSPENDED`, `OWNER_NOT_CURRENT`, `PHOTOS_REQUIRED`, `PRICE_REQUIRED`, `PUBLIC_CONTENT_INVALID`, `READINESS_EXPIRED`, `READINESS_MISSING`, `SCHEDULE_REQUIRED`, `SELLER_MISMATCH`, `SLUG_IN_USE`.
