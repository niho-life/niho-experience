ALTER TABLE provider_google_calendars
  ADD COLUMN coverage_start timestamptz,
  ADD COLUMN coverage_end timestamptz,
  ADD CONSTRAINT google_busy_coverage_pair CHECK ((coverage_start IS NULL) = (coverage_end IS NULL)),
  ADD CONSTRAINT google_busy_coverage_order CHECK (coverage_end IS NULL OR coverage_end > coverage_start);

-- Existing caches cannot prove the interval they covered; force a new sync.
UPDATE provider_google_calendars
   SET sync_status='STALE', fresh_until=NULL;
