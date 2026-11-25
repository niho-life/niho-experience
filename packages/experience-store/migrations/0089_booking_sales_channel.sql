BEGIN;

-- ホストのサイトへの埋め込み PR 2 (#638): where a booking on this site was made. SITE is the
-- experience site itself; EMBED is the booking widget framed on the host's own site. Existing rows
-- become SITE with no origin. Additive only (two columns, a constraint and an index): the current
-- writer neither reads nor writes them, so this migration may run before the new revision.
--
-- embed_origin keeps only the framing site's origin (https://host[:port], lower case), never its path,
-- query or title. It is the destination of the "Back to {host}" link on the payment return page and is
-- not shown to the host. Like utm it is blanked by eraseGuestData; sales_channel is kept.
-- protect_booking_guests is unchanged: it does not cover these columns, so erasure may set
-- embed_origin to NULL.
ALTER TABLE booking_guests
  ADD COLUMN sales_channel text NOT NULL DEFAULT 'SITE' CHECK (sales_channel IN ('SITE','EMBED')),
  ADD COLUMN embed_origin text,
  ADD CONSTRAINT booking_guests_embed_origin_check CHECK (
    embed_origin IS NULL
    OR (sales_channel = 'EMBED' AND pii_erased_at IS NULL
        AND length(embed_origin) BETWEEN 9 AND 255
        AND embed_origin ~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$')
  );

-- The payment return page looks the origin up by the Stripe Checkout Session it was sent back with.
CREATE INDEX booking_guests_checkout_session_ref_idx
  ON booking_guests (checkout_session_ref) WHERE checkout_session_ref IS NOT NULL;

COMMIT;
