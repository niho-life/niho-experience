# Experience product cutover: retired

Owner decision, 2026-11-04: no hosts or guests use the old NIHO Experience product and booking flow. New products are created directly in Experience. There is no product export/import, old-hold drain, cutover record, imported legacy inventory, or legacy checkout fallback.

Migration `0046_remove_legacy_sales_cutover.sql` drops the now-unused cutover and imported-seat tables. The historical creation remains in `0041_experience_public_cutover.sql` so existing database migration history stays immutable.

Checkout admits only a currently active Experience publication whose OWNER, NIHO account, Connect readiness, consent, sale terms, and schedule remain valid. A base product row without a publication cannot be sold. Duplicate active Experience publications with the same slug are rejected. Existing OTA reservations remain in shared inventory and are not NIHO Experience product migrations.

The OWNER creates and edits products, publishes, stops, and resumes them through the host API. See [the host publication contract](experience-publication-api.md). The only external dependency is the small NIHO identity and same-seller Connect projection; if that contract is absent or stale, the host write and checkout fail closed.

The seller and payout owner are the same person or business. For the community dinner both are Panasonic; “NIHOkamakura” is only the Stripe account label. New product terms require explicit seller choices. Minimum chargeable participants and minimum attendance are configurable. Whole-group/private booking is not supported. No cancellation or minimum-attendance value is inferred from old data.
