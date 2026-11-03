# Experience publication API contract

Status: implementation contract for #330 / #369. The host UI consumes these routes; UI components are out of scope here.

The sale-terms contract also covers the Experience-side requirements tracked by [niho-coliving/niho-app#19138](https://github.com/niho-coliving/niho-app/issues/19138): cancellation window/refund rate, private booking, minimum chargeable participants, and operations-only minimum attendance. UI components remain D's scope.

Rollout remains closed until A extends its host identity/Connect response with a stable current user ID and the seller-account mapping for the same provider. The present `GET /api/auth/me` omits the ID, and `ownerUserId` is registration metadata rather than an authentication claim. Experience must not substitute that field. Current payment readiness returns only `ready`/`reason`, so a product's local account reference cannot be proven to match it. Missing either datum returns `AUTH_CONTRACT_UNAVAILABLE` and cannot mutate publication state.

## Identity and authorization boundary

- Host requests use the existing NIHO host app-connect session cookie. Browser code never receives NIHO access or refresh tokens.
- Every host request revalidates the NIHO session and provider membership through the exported Experience host contract. The route uses the returned `providerId` and current `memberRole`; it does not accept an actor ID from the request or use `ownerUserId` as the signed-in identity.
- The Experience store checks the matching local provider membership again. OWNER mutations are enabled only after A supplies the authenticated user's stable ID and a verifiable seller-to-Connect mapping. An EDITOR is never represented as the OWNER in storage/audit. Until that contract is available, editor reads and all OWNER publication operations return `503 AUTH_CONTRACT_UNAVAILABLE` without reading or mutating Experience publication state.
- Recommended A contract: include stable `user.id` in `GET /api/auth/me`, and expose a server-only provider publication-readiness response bound to that same OWNER with `sellerNihoAccountRef`, `stripeConnectAccountRef`, `sellerDisplayName`, readiness, a monotonic version, and an observation/expiry time. The existing browser-facing provider DTO remains allowlisted and does not receive account references. The Experience host API client must validate these fields before the BFF may construct a store actor or update readiness.
- The current `getExperienceProviderPaymentReadiness` only returns `ready`, `reason`, and reuse consent; only `ready=true` and `reason=READY` count as Connect-ready, but that alone cannot prove the product's stored account mapping. An unavailable or malformed response fails closed. The browser cannot write readiness flags, account references, seller identity, or consent state.
- The deployment's current listing-consent version is server configuration. A host must echo that version and send `accepted: true` for each initial publication or restart; an older version is a blocker.

## Host operations

All routes below are same-origin BFF endpoints, return `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex, nofollow`, and reject cross-origin mutations.

### Read editor state

`GET /host/api/publication/providers/{providerId}/products/{productId}`

Returns an allowlisted DTO:

```json
{
  "draft": {
    "slug": "synthetic-experience",
    "publicTitle": "Synthetic experience",
    "content": {},
    "currency": "JPY",
    "unitAmount": 8000,
    "cancellationTermsRef": "terms-v1",
    "version": 4
  },
  "publication": {
    "state": "PUBLISHED",
    "stateVersion": 7,
    "publishedDraftVersion": 4,
    "firstPublishedAtUtc": "2026-11-03T00:00:00.000Z",
    "selfStoppedAtUtc": null,
    "operationsSuspended": false,
    "ownerResumeRequired": false
  },
  "readiness": {
    "accountUsable": true,
    "connectReady": true,
    "sellerDisplayReady": true,
    "consentVersion": "listing-v1",
    "validUntilUtc": "2026-11-03T00:05:00.000Z"
  },
  "blockers": []
}
```

The DTO never includes provider/user IDs, publication row IDs, Stripe/NIHO account references, suspension actor IDs, meeting address/access instructions, or database fields not listed above. `state` is one of `DRAFT`, `PUBLISHED`, `SELF_STOPPED`, `OPERATIONS_SUSPENDED`, or `RESUME_REQUIRED`.

### Save draft

`PATCH /host/api/publication/providers/{providerId}/products/{productId}`

```json
{
  "expectedDraftVersion": 4,
  "expectedStateVersion": 7,
  "draft": {
    "slug": "synthetic-experience",
    "publicTitle": "Updated synthetic experience",
    "content": {},
    "currency": "JPY",
    "unitAmount": 9000,
    "cancellationTermsRef": "terms-v1"
  }
}
```

Both versions are required. The server validates the complete draft and photo rights; browser-supplied `manuscriptReady` / `photosReady` booleans are rejected. Saving a valid draft while published atomically advances the immutable public snapshot and keeps the listing active. An incomplete draft can be kept without replacing the prior public snapshot; the response returns blocker codes. Existing booking snapshots do not change.

### Read and save sale terms

`GET /host/api/publication/providers/{providerId}/products/{productId}/sale-terms` returns the editable terms and the versions required by the next write:

```json
{
  "draftVersion": 5,
  "stateVersion": 8,
  "saleTerms": {
    "childPricing": null,
    "minimumParticipants": 2,
    "minimumChargeableParticipants": 3,
    "privateBooking": false,
    "maxPartySize": 6,
    "cancellationPolicy": "CUSTOM",
    "cancellationWindowMinutesBeforeStart": 1440,
    "cancellationRefundBasisPoints": 5000,
    "minimumAttendance": 4,
    "bookingQuestions": [],
    "conditionsVersion": null,
    "version": 2,
    "updatedAtUtc": "2026-11-03T00:00:00.000Z"
  }
}
```

`saleTerms` is `null` before the first terms row; `stateVersion` is `null` before any publication state exists. The DTO omits provider/product IDs and the internal booking-question fingerprint. The public site cannot yet display participation-condition text, so this API accepts only `conditionsVersion: null`.

`PATCH /host/api/publication/providers/{providerId}/products/{productId}/sale-terms` replaces the complete terms object. The request uses three independent compare-and-swap versions:

```json
{
  "expectedDraftVersion": 5,
  "expectedStateVersion": 8,
  "expectedSaleTermsVersion": 2,
  "saleTerms": {
    "childPricing": null,
    "minimumParticipants": 2,
    "minimumChargeableParticipants": 3,
    "privateBooking": false,
    "maxPartySize": 6,
    "cancellationPolicy": "CUSTOM",
    "cancellationWindowMinutesBeforeStart": 1440,
    "cancellationRefundBasisPoints": 5000,
    "minimumAttendance": 4,
    "bookingQuestions": [],
    "conditionsVersion": null
  }
}
```

All three versions are required. A `null` `expectedSaleTermsVersion` means create only; a positive version means update only. A `null` `expectedStateVersion` means no publication state exists. The server validates the complete terms object, server-derived manuscript/photo checks, current draft and publication state, and the current sale-terms row in one transaction. It never accepts readiness or publication checks from the browser. If the product is actively published and every publication blocker is clear, it creates a new immutable publication snapshot for the new sale-terms version and advances `stateVersion` atomically. If a blocker remains, the editable terms are saved and the previous public snapshot stays active; the response sets `publicationUpdated: false` and returns the blocker array. Existing booking snapshots remain unchanged in either case. If the product is stopped, suspended, or not yet published, saving terms never publishes or resumes it.

The successful response is `{ "draftVersion": 5, "stateVersion": 9, "saleTerms": { "…": "…", "version": 3, "updatedAtUtc": "…" }, "publicationUpdated": true, "blockers": [] }`. D should retain the returned versions and reread after an unknown timeout rather than replaying stale versions.

The BFF currently returns `503 AUTH_CONTRACT_UNAVAILABLE` for both reads and writes because A does not yet return the authenticated user's stable ID and the matching seller/Connect mapping. Payload validation and the store/CAS contract are established, but no actor or store call is constructed until A supplies that contract.

### Publish or restart

`POST /host/api/publication/providers/{providerId}/products/{productId}/publish`

```json
{
  "expectedDraftVersion": 5,
  "expectedStateVersion": 7,
  "consentVersion": "listing-v1",
  "accepted": true
}
```

OWNER only. The server rechecks current NIHO account/provider state, Connect readiness, seller display/account mapping, current consent, manuscript/media validation, price/terms, and schedule. It does not publish unsaved input. Successful restart preserves `firstPublishedAtUtc`; an operations suspension must first be cleared by operations, after which an OWNER must explicitly publish again.

### Stop by owner

`POST /host/api/publication/providers/{providerId}/products/{productId}/stop`

```json
{ "expectedStateVersion": 8 }
```

OWNER only. It removes the publication from catalog, detail, metadata, sitemap, and new checkout admission. Existing bookings and their immutable condition snapshots remain available to the host.

## Operations suspension

Platform Admin routes are separate from host routes and accept only the existing NIHO Experience Admin session. Host session roles cannot invoke them. The Experience BFF routes are `POST /admin/api/experience-publications/providers/{providerId}/products/{productId}/suspend` and `/clear-suspension`; they use the currently verified Admin actor ID and require same-origin requests.

- `POST /admin/api/experience-publications/providers/{providerId}/products/{productId}/suspend` with `{ "expectedStateVersion": 9, "reasonCode": "POLICY_REVIEW" }`.
- `POST /admin/api/experience-publications/providers/{providerId}/products/{productId}/clear-suspension` with `{ "expectedStateVersion": 10 }`.

Clearing suspension does not publish. It leaves `ownerResumeRequired=true`; only a fresh OWNER publish/restart can make the item visible again.

## Public reads and checkout

- `GET /api/public/experiences` returns `{ "experiences": PublicExperiencePublication[] }` for the current unique, active publications only.
- `GET /api/public/experiences/{slug}` returns `{ "experience": PublicExperiencePublication }` or the same `404` for unknown, stopped, suspended, stale-readiness, invalid, or duplicate slugs.
- Both use the explicit public projection. It contains no provider/product/user ID, Connect or NIHO reference, draft, private meeting details, or internal status. Photos contain only same-origin `src`, alt text, and optional public credit. `src` uses an opaque media ID at `/api/public/experience-media/{assetId}`; object keys are never returned. Media must be copied to the Experience media bucket, normalized to JPEG, and have confirmed public rights before publication.
- Availability and checkout must recheck the same active publication, latest valid readiness projection, sale terms, and completed product cutover inside the booking transaction. The booking snapshot takes price, seller, cancellation terms, and other accepted conditions from the publication in that transaction, never from mutable draft fields.
- A migrated product is not sellable until the old NIHO sale is stopped, outstanding holds are drained, confirmed future seats are imported into shared inventory, and the versioned cutover is enabled. Rollback closes Experience sale first; old NIHO sale may reopen only after the new channel is closed and its in-flight holds are reconciled.

## Version and error contract

| HTTP | `error.code` | Meaning |
| --- | --- | --- |
| 400 | `INVALID_INPUT` | Malformed/unknown field, invalid version, invalid content |
| 401 | `SESSION_ENDED` / `SESSION_REFRESH_REQUIRED` | NIHO host session absent, revoked, or needs refresh |
| 403 | `FORBIDDEN` | Current NIHO role or Experience membership does not allow the operation |
| 404 | `NOT_FOUND` | Provider/product/publication is absent or not visible to this caller |
| 409 | `VERSION_CONFLICT` | Draft/state/readiness version no longer matches; reread before retry |
| 409 | `CUTOVER_INCOMPLETE` | Legacy sales/holds/seats have not reached the required cutover stage |
| 422 | `PUBLICATION_BLOCKED` | Body includes the stable blocker-code array; no partial publication is written |
| 502 | `READINESS_UNAVAILABLE` | NIHO auth/Connect contract could not be verified; state remains fail-closed |
| 503 | `AUTH_CONTRACT_UNAVAILABLE` | The authenticated user's stable ID or matching seller-account mapping is absent from A's current contract; state remains fail-closed |
| 503 | `STORE_UNAVAILABLE` | Experience DB or required media service is unavailable |
| 413 | `INVALID_INPUT` | Request body exceeded the BFF size limit |

Responses do not include exception text, credentials, private identifiers, or personal data. A timeout is an unknown result: clients reread the DTO and compare versions; they do not assume the mutation succeeded or retry with the old version.

## Initial stable blocker codes

`ACCOUNT_NOT_USABLE`, `CANCELLATION_TERMS_REQUIRED`, `CONNECT_NOT_READY`, `CONSENT_OUTDATED`, `MANUSCRIPT_REQUIRED`, `OPERATIONS_SUSPENDED`, `OWNER_NOT_CURRENT`, `PHOTOS_REQUIRED`, `PRICE_REQUIRED`, `PUBLIC_CONTENT_INVALID`, `READINESS_EXPIRED`, `READINESS_MISSING`, `SCHEDULE_REQUIRED`, `SELLER_MISMATCH`, `SLUG_IN_USE`.

## Sale-condition DTO for D

`GET /api/public/experiences/{slug}` includes these offer fields (and the catalog uses the same projection):

```json
{
  "minimumParticipants": 2,
  "minimumChargeableParticipants": 3,
  "privateBooking": false,
  "cancellationPolicy": { "code": "CUSTOM", "freeCancellationHoursBefore": null },
  "cancellationTerms": {
    "cancellationWindowMinutesBeforeStart": 1440,
    "refundBasisPoints": 5000
  }
}
```

`minimumChargeableParticipants` is a floor on the adult-price portion: checkout charges `max(adult price × adult count + child price × child count, adult price × minimumChargeableParticipants)`. It defaults to the neutral value `1`; it is separate from `minimumParticipants`, which controls whether a party may book. `privateBooking=true` makes one group reserve the occurrence and rejects a second active group in shared inventory.

The cancellation window and refund rate are configured as a pair. For a custom rule, D sends `cancellationPolicy: "CUSTOM"` and both explicit values; omitting either is invalid. `refundBasisPoints` is 0–10000; the automatic refund amount is `floor(paid amount × basis points / 10000)` and prior successful/pending refunds are deducted before a new refund is created. A 10000-basis-point window retains the legacy free-cancellation wording. The host read DTO and public offer derive `CUSTOM` or an exact legacy code from the stored pair. Internally, custom rows keep the legacy-compatible `NONE` marker plus the explicit pair. Legacy 24-hour, 48-hour, and no-refund values migrate exactly to 1440/2880/null minutes and 10000/10000/0 basis points. No other window or rate is inferred.

`minimumAttendance` is stored and snapshotted at checkout but never appears in guest DTOs. The host session DTO adds `confirmedParticipants` and `minimumAttendance: { required, confirmed, remaining } | null`; pending payment reviews do not count toward the run minimum. This is a report only: it does not cancel a session or change bookings automatically.

The host booking DTO `HostGuestBooking.saleConditions` returns the accepted snapshot: `minimumChargeableParticipants`, `privateBooking`, `minimumAttendance`, `cancellationWindowMinutesBeforeStart`, and `cancellationRefundBasisPoints`. Missing minimum charge/private fields in older booking snapshots are `null`; cancellation window/rate are resolved from the historical 24-hour, 48-hour, or no-refund policy where possible. D can use these fields for the host booking/session UI without reading current mutable terms.

The guest booking DTO returns `cancellationRefundBasisPoints` and `freeCancellationUntilUtc` from the same immutable snapshot. The legacy `freeCancellationOpen` boolean means the cancellation window is open; the displayed refund amount must use `cancellationRefundBasisPoints`. `POST /api/public/bookings/cancel` accepts `POLICY_CANCEL` during the configured window; it applies the snapshotted rate, including a 0% cancellation without a refund. `FULL_REFUND` is accepted only when the rate is 10000. The caller must send the displayed `shownDeadlineUtc`; if it changed before the write, the HTTP result is 200 `{ "outcome": "CHANGED" }` and no booking or refund changes. After the window, `REQUEST` opens the existing support request and leaves the booking confirmed.

The interval, refund percentage, minimum chargeable party size, private-group semantics, and minimum-run threshold can be configured without selecting product defaults. The UI must not invent values. `minimumChargeYen` remains the existing payment minimum and is not a seller's minimum price.
