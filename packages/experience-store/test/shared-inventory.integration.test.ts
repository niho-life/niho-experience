import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { occurrenceIdFor, type ScheduleRule } from "@niho-experience/experience-domain";
import { ChannelRuntime } from "../src/channels.ts";
import { BookingUnavailableError, StoreConflictError } from "../src/errors.ts";
import { ExperienceStore } from "../src/repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const command = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

describe("PostgreSQL shared inventory", { skip: databaseUrl === undefined }, () => {
  it("serializes private groups and shared resources while keeping legacy seats and durable reconciliation", async () => {
    const { Pool } = await import("pg");
    const schema = `shared_inventory_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
    const actor = { providerId: "provider-a", nihoUserId: "owner-a" } as const;
    const otherActor = { providerId: "provider-b", nihoUserId: "owner-b" } as const;
    let sequence = 1;
    const nextCommand = () => command(sequence++);
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const migrations = (await readdir(new URL("../migrations/", import.meta.url)))
        .filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
      for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
      await pool.query(
        `INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES
          ('provider-a','owner-a','OWNER'),('provider-a','editor-a','EDITOR'),('provider-b','owner-b','OWNER')`,
      );
      const store = new ExperienceStore(pool);
      const createProduct = async (id: string, provider: { readonly providerId: string; readonly nihoUserId: string } = actor) => store.createProduct(provider, {
        id, slug: id, status: "PUBLISHED", publicTitle: `Synthetic ${id}`, content: {}, currency: "JPY", unitAmount: 1000,
        cancellationTermsRef: "synthetic-terms", sellerNihoAccountRef: "synthetic-seller",
        stripeConnectAccountRef: `acct_${provider.providerId}`, sellerDisplayName: "Synthetic Seller",
      });
      for (const id of ["private", "shared-overlap", "shared-adjacent", "separate", "seats", "rollback", "channel-private", "channel-blocker"]) {
        await createProduct(id);
      }
      await createProduct("foreign", otherActor);

      const saveRule = async (productId: string, localStartTime: string, durationMinutes = 60, capacity = 8) => {
        const rule: ScheduleRule = {
          id: `${productId}-rule`, timeZone: "Asia/Tokyo", startsOn: "2099-01-01", localStartTime, durationMinutes,
          capacity, bookingCutoffMinutes: 0, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
        };
        await store.saveScheduleRule(actor, productId, rule, null, nextCommand());
        return { rule, occurrenceId: occurrenceIdFor(rule.id, "2099-01-01") };
      };
      const schedules = {
        private: await saveRule("private", "10:00"),
        overlap: await saveRule("shared-overlap", "10:30", 30),
        adjacent: await saveRule("shared-adjacent", "11:45", 60),
        separate: await saveRule("separate", "10:30", 30),
        seats: await saveRule("seats", "14:00", 60, 8),
        rollback: await saveRule("rollback", "16:00"),
        channel: await saveRule("channel-private", "18:00"),
        channelBlocker: await saveRule("channel-blocker", "18:00"),
      };

      const roomCommand = nextCommand();
      const room = await store.saveInventoryResource(actor, {
        id: "room-a", kind: "VENUE", displayName: "Synthetic room A", active: true,
      }, null, roomCommand);
      assert.equal((await store.saveInventoryResource(actor, {
        id: "room-a", kind: "VENUE", displayName: "Synthetic room A", active: true,
      }, null, roomCommand)).repeated, true);
      await assert.rejects(() => store.saveInventoryResource(actor, {
        id: "room-a", kind: "VENUE", displayName: "Changed input", active: true,
      }, room.version, roomCommand), StoreConflictError);
      await store.saveInventoryResource(actor, { id: "teacher-a", kind: "INSTRUCTOR", displayName: "Synthetic instructor", active: true }, null, nextCommand());
      await store.saveInventoryResource(actor, { id: "room-b", kind: "VENUE", displayName: "Synthetic room B", active: true }, null, nextCommand());
      await store.saveInventoryResource(actor, { id: "channel-room", kind: "VENUE", displayName: "Synthetic channel room", active: true }, null, nextCommand());

      const assign = async (productId: string, resources: readonly { resourceId: string; prepareMinutes: number; cleanupMinutes: number }[]) =>
        store.saveProductInventorySetting(actor, productId, { bookingMode: "PRIVATE_GROUP", resources }, null, nextCommand());
      const sharedAssignments = [
        { resourceId: "room-a", prepareMinutes: 30, cleanupMinutes: 15 },
        { resourceId: "teacher-a", prepareMinutes: 30, cleanupMinutes: 15 },
      ] as const;
      await assign("private", sharedAssignments);
      await assign("shared-overlap", sharedAssignments);
      await assign("shared-adjacent", sharedAssignments);
      await assign("separate", [{ resourceId: "room-b", prepareMinutes: 30, cleanupMinutes: 15 }]);
      await assign("rollback", []);
      await assign("channel-private", [{ resourceId: "channel-room", prepareMinutes: 0, cleanupMinutes: 0 }]);
      await assign("channel-blocker", [{ resourceId: "channel-room", prepareMinutes: 0, cleanupMinutes: 0 }]);
      await assert.rejects(
        () => store.saveProductInventorySetting(otherActor, "foreign", { bookingMode: "PRIVATE_GROUP", resources: [
          { resourceId: "room-a", prepareMinutes: 0, cleanupMinutes: 0 },
        ] }, null, nextCommand()),
        StoreConflictError,
      );

      const privateRace = await Promise.allSettled([
        store.createBookingHold({ providerId: actor.providerId }, {
          productId: "private", occurrenceId: schedules.private.occurrenceId, seats: 2, idempotencyKey: "private-two", holdSeconds: 3600,
        }),
        store.createBookingHold({ providerId: actor.providerId }, {
          productId: "private", occurrenceId: schedules.private.occurrenceId, seats: 6, idempotencyKey: "private-six", holdSeconds: 3600,
        }),
      ]);
      assert.equal(privateRace.filter((item) => item.status === "fulfilled").length, 1);
      assert.equal(privateRace.filter((item) => item.status === "rejected").length, 1);
      const privateWinner = privateRace.find((item) => item.status === "fulfilled");
      assert.ok(privateWinner?.status === "fulfilled");
      assert.equal(Number((await pool.query("SELECT count(*) FROM booking_inventory_snapshots")).rows[0]?.count), 1);
      assert.equal(Number((await pool.query("SELECT count(*) FROM booking_resource_occupancies")).rows[0]?.count), 2);
      const expiryDelivery = await pool.query<{ available_at: Date; hold_expires_at: Date }>(
        `SELECT e.available_at,b.hold_expires_at FROM calendar_outbox_events e
          JOIN bookings b ON b.provider_id=e.provider_id AND b.occurrence_id=e.aggregate_id
         WHERE e.payload->>'cause'='booking_hold_expired' AND b.product_id='private'`,
      );
      assert.equal(expiryDelivery.rowCount, 1);
      assert.equal(expiryDelivery.rows[0]?.available_at.toISOString(), expiryDelivery.rows[0]?.hold_expires_at.toISOString());

      const seatRace = await Promise.allSettled([
        store.createBookingHold({ providerId: actor.providerId }, {
          productId: "seats", occurrenceId: schedules.seats.occurrenceId, seats: 2, idempotencyKey: "seat-two", holdSeconds: 3600,
        }),
        store.createBookingHold({ providerId: actor.providerId }, {
          productId: "seats", occurrenceId: schedules.seats.occurrenceId, seats: 6, idempotencyKey: "seat-six", holdSeconds: 3600,
        }),
      ]);
      assert.equal(seatRace.filter((item) => item.status === "fulfilled").length, 2);

      await assert.rejects(
        () => store.createBookingHold({ providerId: actor.providerId }, {
          productId: "shared-overlap", occurrenceId: schedules.overlap.occurrenceId, seats: 3, idempotencyKey: "overlap", holdSeconds: 3600,
        }),
        (error: unknown) => error instanceof BookingUnavailableError && error.reason === "RESOURCE_BUSY",
      );
      assert.equal((await store.createBookingHold({ providerId: actor.providerId }, {
        productId: "shared-adjacent", occurrenceId: schedules.adjacent.occurrenceId, seats: 3, idempotencyKey: "adjacent", holdSeconds: 3600,
      })).status, "HOLD");
      assert.equal((await store.createBookingHold({ providerId: actor.providerId }, {
        productId: "separate", occurrenceId: schedules.separate.occurrenceId, seats: 3, idempotencyKey: "separate", holdSeconds: 3600,
      })).status, "HOLD");

      const privateSetting = await store.getProductInventorySetting(actor, "private");
      await assert.rejects(() => store.saveProductInventorySetting(actor, "private", {
        bookingMode: "SEAT", resources: [],
      }, privateSetting.version, nextCommand()), StoreConflictError);
      await pool.query("ALTER TABLE bookings DISABLE TRIGGER bookings_protect_snapshots");
      await pool.query(
        `UPDATE bookings SET created_at=clock_timestamp()-interval '2 minutes',hold_expires_at=clock_timestamp()-interval '1 minute'
          WHERE provider_id=$1 AND product_id='private' AND status='HOLD'`, [actor.providerId],
      );
      await pool.query("ALTER TABLE bookings ENABLE TRIGGER bookings_protect_snapshots");
      assert.equal(await store.releaseExpiredHolds({ providerId: actor.providerId }), 1);
      const latePayment = await store.confirmBookingPayment({ providerId: actor.providerId }, {
        publicBookingId: privateWinner.value.publicBookingId,
        connectedAccountId: privateWinner.value.sellerSnapshot.stripeConnectAccountRef,
        stripePaymentRef: "pi_synthetic_late_group", stripeEventId: "evt_synthetic_late_group",
        stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(),
        amount: privateWinner.value.pricingSnapshot.totalAmount, currency: "JPY",
      });
      assert.equal(latePayment.booking.status, "PAYMENT_REVIEW");
      // The old group and its room/instructor snapshots must remain non-consuming.
      assert.equal((await store.createBookingHold({ providerId: actor.providerId }, {
        productId: "private", occurrenceId: schedules.private.occurrenceId, seats: 2,
        idempotencyKey: "private-after-late-payment", holdSeconds: 3600,
      })).status, "HOLD");
      await pool.query("ALTER TABLE bookings DISABLE TRIGGER bookings_protect_snapshots");
      await pool.query("UPDATE bookings SET hold_expires_at=clock_timestamp()-interval '1 minute',created_at=clock_timestamp()-interval '2 minutes' WHERE idempotency_key='private-after-late-payment'");
      await pool.query("ALTER TABLE bookings ENABLE TRIGGER bookings_protect_snapshots");
      await store.releaseExpiredHolds({ providerId: actor.providerId });
      assert.equal((await store.createBookingHold({ providerId: actor.providerId }, {
        productId: "shared-overlap", occurrenceId: schedules.overlap.occurrenceId, seats: 3,
        idempotencyKey: "overlap-after-expiry", holdSeconds: 3600,
      })).status, "HOLD");
      const manuallyClosedId = occurrenceIdFor(schedules.private.rule.id, "2099-01-02");
      await store.setOccurrenceSalesState(actor, "private", schedules.private.rule.id, {
        occurrenceId: manuallyClosedId, desiredState: "CLOSED",
      }, null, nextCommand());
      await assert.rejects(
        () => store.createBookingHold({ providerId: actor.providerId }, {
          productId: "private", occurrenceId: manuallyClosedId, seats: 2, idempotencyKey: "closed-after-expiry", holdSeconds: 3600,
        }),
        (error: unknown) => error instanceof BookingUnavailableError && error.reason === "MANUALLY_CLOSED",
      );
      await store.saveInventoryResource(actor, {
        id: "room-b", kind: "VENUE", displayName: "Synthetic room B", active: false,
      }, 1, nextCommand());
      await assert.rejects(
        () => store.createBookingHold({ providerId: actor.providerId }, {
          productId: "separate", occurrenceId: occurrenceIdFor(schedules.separate.rule.id, "2099-01-02"),
          seats: 1, idempotencyKey: "inactive-room", holdSeconds: 3600,
        }),
        (error: unknown) => error instanceof BookingUnavailableError && error.reason === "RESOURCE_INACTIVE",
      );

      await pool.query(`CREATE FUNCTION fail_inventory_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.payload->>'cause'='booking_hold_created' AND NEW.aggregate_id='rollback-rule@2099-01-01' THEN
          RAISE EXCEPTION 'synthetic outbox failure'; END IF; RETURN NEW; END $$`);
      await pool.query("CREATE TRIGGER synthetic_inventory_outbox_failure BEFORE INSERT ON calendar_outbox_events FOR EACH ROW EXECUTE FUNCTION fail_inventory_outbox()");
      await assert.rejects(() => store.createBookingHold({ providerId: actor.providerId }, {
        productId: "rollback", occurrenceId: schedules.rollback.occurrenceId, seats: 1, idempotencyKey: "rollback-hold", holdSeconds: 3600,
      }));
      await pool.query("DROP TRIGGER synthetic_inventory_outbox_failure ON calendar_outbox_events");
      assert.equal((await pool.query("SELECT 1 FROM bookings WHERE idempotency_key='rollback-hold'")).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM booking_inventory_snapshots s JOIN bookings b ON b.provider_id=s.provider_id AND b.id=s.booking_id WHERE b.idempotency_key='rollback-hold'")).rowCount, 0);

      const runtimeNow = new Date("2098-12-31T00:00:00.000Z");
      const runtime = new ChannelRuntime(pool, {
        now: () => runtimeNow,
        supportedAdapters: { "Synthetic/browser-v1@1": { canObserve: true, canClose: true, canOpen: true } },
      });
      const admin = { nihoUserId: "synthetic-admin" };
      const account = await runtime.createExternalAccount(admin, {
        id: "account-a", providerId: actor.providerId, site: "Synthetic", externalAccountId: "synthetic-account",
        displayName: "Synthetic account", operatingModel: 2, active: true, delegatedUntilUtc: "2099-02-01T00:00:00.000Z",
      }, nextCommand());
      const listing = await runtime.createListing(admin, {
        id: "channel-listing", providerId: actor.providerId, accountId: account.id, productId: "channel-private",
        externalProductId: "synthetic-product", adapter: "browser-v1", adapterVersion: "1", connectionMode: "BROWSER",
        capabilities: { canObserve: true, canClose: true, canOpen: true }, active: true,
      }, nextCommand());
      await runtime.reconcileListing(admin, listing.id, nextCommand());
      const credential = await runtime.mintWorkerCredential(admin, "worker-a", "Synthetic worker", "2099-02-01T00:00:00.000Z", null, nextCommand());
      await runtime.assignWorkerAccount(admin, credential.workerId, account.id, null, nextCommand());
      const worker = await runtime.authenticateWorker(credential.bearerToken);
      const oldOpen = await runtime.claim(worker);
      assert.ok(oldOpen && oldOpen.action === "SET_OPEN");
      const channelHold = await store.createBookingHold({ providerId: actor.providerId }, {
        productId: "channel-blocker", occurrenceId: schedules.channelBlocker.occurrenceId, seats: 2,
        idempotencyKey: "channel-resource-hold", holdSeconds: 3600,
      });
      assert.equal((await store.confirmBookingPayment({ providerId: actor.providerId }, {
        publicBookingId: channelHold.publicBookingId,
        connectedAccountId: channelHold.sellerSnapshot.stripeConnectAccountRef,
        stripePaymentRef: "pi_synthetic_channel_group", stripeEventId: "evt_synthetic_channel_group",
        stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(),
        amount: channelHold.pricingSnapshot.totalAmount, currency: "JPY",
      })).booking.status, "CONFIRMED");
      await assert.rejects(() => runtime.preflight(worker, oldOpen.id, oldOpen.leaseToken), StoreConflictError);
      const staleResult = await runtime.submitResult(worker, oldOpen.id, {
        resultId: nextCommand(), leaseToken: oldOpen.leaseToken, outcome: "VERIFIED", stopped: true, target: oldOpen.target,
        occurrenceId: oldOpen.occurrenceId, sourceStartAtUtc: oldOpen.sourceStartAtUtc, sourceEndAtUtc: oldOpen.sourceEndAtUtc,
        observedState: "OPEN", observedBookable: true, observedManuallyBlocked: false, observedAtUtc: runtimeNow.toISOString(),
      });
      assert.equal(staleResult.acceptedAsCurrent, false);
      assert.equal((await pool.query(
        "SELECT observed_state FROM channel_desired_states WHERE listing_id=$1 AND occurrence_id=$2",
        [listing.id, oldOpen.occurrenceId],
      )).rows[0]?.observed_state, null);

      const firstTick = await runtime.enqueueDueReconciliationTicks(worker, 10);
      const duplicateTick = await runtime.enqueueDueReconciliationTicks(worker, 10);
      assert.equal(firstTick.enqueued, 1);
      assert.equal(duplicateTick.enqueued, 0);
      await runtime.consumeCalendarOutbox(200, worker);
      const pendingAfterFirstPage = await pool.query<{ pending: boolean }>(
        "SELECT pending_command_id IS NOT NULL AS pending FROM calendar_reconciliation_ticks WHERE provider_id=$1", [actor.providerId],
      );
      assert.equal(pendingAfterFirstPage.rows[0]?.pending, true);
      await runtime.consumeCalendarOutbox(200, worker);
      assert.equal((await runtime.enqueueDueReconciliationTicks(worker, 10)).enqueued, 0);
      const tick = await pool.query<{ pending_command_id: string | null; next_due_at: Date }>(
        "SELECT pending_command_id,next_due_at FROM calendar_reconciliation_ticks WHERE provider_id=$1", [actor.providerId],
      );
      assert.equal(tick.rows[0]?.pending_command_id, null);
      assert.ok((tick.rows[0]?.next_due_at.getTime() ?? 0) > runtimeNow.getTime());

      await pool.query(
        `INSERT INTO outbox_messages (provider_id,aggregate_type,aggregate_id,topic,deduplication_key,payload)
         VALUES ($1,'booking','synthetic','booking.synthetic','notification-only','{}')`, [actor.providerId],
      );
      await runtime.consumeCalendarOutbox(200, worker);
      assert.equal((await pool.query("SELECT processed_at FROM outbox_messages WHERE deduplication_key='notification-only'")).rows[0]?.processed_at, null);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
