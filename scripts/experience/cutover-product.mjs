#!/usr/bin/env node
// Stepwise, Experience-side sales cutover. Stop the old NIHO sale and reconcile
// its holds before recording those facts here. This tool never contacts NIHO.
// Usage:
//   node scripts/experience/cutover-product.mjs status <providerId> <productId>
//   node scripts/experience/cutover-product.mjs import-product <manifest.json> --legacy-sale-stopped --yes
//   node scripts/experience/cutover-product.mjs register-media <manifest.json> --yes
//   node scripts/experience/cutover-product.mjs record-legacy-stopped <providerId> <productId> --yes
//   node scripts/experience/cutover-product.mjs record-holds-drained <providerId> <productId> <version> --yes
//   node scripts/experience/cutover-product.mjs import-confirmed <manifest.json> <version> --yes
//   node scripts/experience/cutover-product.mjs enable <providerId> <productId> <version> --yes
//   node scripts/experience/cutover-product.mjs stop-experience <providerId> <productId> <version> --yes
// Inventory manifests contain only keyed sourceRefHash, sourceRevision, occurrenceId and seats.
// Never include legacy booking IDs, guest data, or raw source account IDs.
import { readFile } from "node:fs/promises";
import pg from "pg";
import { ExperienceProductMigrationImport } from "@niho-experience/experience-store/product-migration";
import { ExperienceProductMediaImport } from "@niho-experience/experience-store/publication-media-import";
import { ExperienceSalesCutover } from "@niho-experience/experience-store/sales-cutover";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const integer = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

function usage() {
  console.error("Invalid command or arguments. See the usage at the top of scripts/experience/cutover-product.mjs.");
  return 1;
}

function printState(state) {
  console.log(JSON.stringify({
    phase: state.phase,
    version: state.version,
    legacySalesStopped: Boolean(state.legacySalesStoppedAtUtc),
    legacyHoldsDrained: Boolean(state.legacyHoldsDrainedAtUtc),
    importedReservationCount: state.importedReservationCount,
    importedSeatCount: state.importedSeatCount,
    inventoryManifestSha256: state.inventoryImportManifestSha256,
    experienceSalesActive: state.phase === "EXPERIENCE_ACTIVE",
  }));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const mutating = command !== "status";
  if (mutating && args.at(-1) !== "--yes") return usage();
  if (mutating) args.pop();
  const legacySaleStoppedConfirmed = command === "import-product" && args.at(-1) === "--legacy-sale-stopped";
  if (legacySaleStoppedConfirmed) args.pop();
  if (command === "import-product" && !legacySaleStoppedConfirmed) return usage();
  const databaseUrl = process.env.EXPERIENCE_DATABASE_URL;
  if (!databaseUrl) return usage();
  const role = process.env.EXPERIENCE_DATABASE_ROLE;
  if (role && !ROLE.test(role)) return usage();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, ...(role ? { options: `-c role=${role}` } : {}) });
  pool.on("error", () => {});
  try {
    if (role) {
      const current = await pool.query("SELECT current_user AS name");
      if (current.rows[0]?.name !== role) return usage();
    }
    const cutover = new ExperienceSalesCutover(pool);
    let state;
    if (command === "import-product" && args.length === 1) {
      let manifest;
      try { manifest = JSON.parse(await readFile(args[0], "utf8")); } catch { return usage(); }
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
        || Object.keys(manifest).some((key) => !["providerId", "product", "saleTerms", "scheduleRules"].includes(key))
        || typeof manifest.providerId !== "string" || !ID.test(manifest.providerId)
        || !manifest.product || typeof manifest.product !== "object" || Array.isArray(manifest.product)
        || Object.keys(manifest.product).some((key) => !["id", "slug", "status", "publicTitle", "content", "currency", "unitAmount", "cancellationTermsRef", "sellerNihoAccountRef", "stripeConnectAccountRef", "sellerDisplayName"].includes(key))
        || !manifest.saleTerms || typeof manifest.saleTerms !== "object" || Array.isArray(manifest.saleTerms)
        || Object.keys(manifest.saleTerms).some((key) => ![
          "childPricing", "minimumParticipants", "minimumChargeableParticipants", "privateBooking", "maxPartySize",
          "cancellationPolicy", "cancellationWindowMinutesBeforeStart", "cancellationRefundBasisPoints", "minimumAttendance",
          "bookingQuestions", "conditionsVersion",
        ].includes(key))
        || !Array.isArray(manifest.scheduleRules) || manifest.scheduleRules.some((rule) =>
          !rule || typeof rule !== "object" || Array.isArray(rule)
          || Object.keys(rule).some((key) => !["id", "timeZone", "startsOn", "endsOn", "localStartTime", "durationMinutes", "capacity", "bookingCutoffMinutes", "busyBufferBeforeMinutes", "busyBufferAfterMinutes", "recurrence"].includes(key)))) return usage();
      const imported = await new ExperienceProductMigrationImport(pool).importBundle({
        providerId: manifest.providerId,
        legacySaleStoppedConfirmed: true,
        product: manifest.product,
        saleTerms: manifest.saleTerms,
        scheduleRules: manifest.scheduleRules,
      });
      console.log(JSON.stringify({ phase: "LEGACY_STOPPED", productVersion: imported.productVersion, scheduleCount: imported.scheduleCount }));
      return 0;
    } else if (command === "register-media" && args.length === 1) {
      let manifest;
      try { manifest = JSON.parse(await readFile(args[0], "utf8")); } catch { return usage(); }
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
        || Object.keys(manifest).some((key) => !["providerId", "productId", "expectedProductVersion", "media"].includes(key))
        || !Array.isArray(manifest.media) || manifest.media.some((asset) =>
          !asset || typeof asset !== "object" || Array.isArray(asset)
          || Object.keys(asset).some((key) => !["assetId", "sourcePosition", "objectKey", "sourceRefHash", "width", "height", "byteSize", "altText", "publicCredit", "rightsConfirmed"].includes(key)))) return usage();
      const ids = await new ExperienceProductMediaImport(pool).register({
        providerId: manifest.providerId,
        productId: manifest.productId,
        expectedProductVersion: manifest.expectedProductVersion,
        media: manifest.media,
      });
      console.log(JSON.stringify({ importedMediaCount: ids.length, rightsConfirmed: true }));
      return 0;
    } else if (command === "status" && args.length === 2 && args.every((value) => ID.test(value))) {
      state = await cutover.getState(args[0], args[1]);
      if (!state) {
        console.log('{"phase":"NOT_STARTED"}');
        return 0;
      }
    } else if (command === "record-legacy-stopped" && args.length === 2 && args.every((value) => ID.test(value))) {
      state = await cutover.recordLegacySalesStopped(args[0], args[1]);
    } else if (command === "record-holds-drained" && args.length === 3 && ID.test(args[0]) && ID.test(args[1]) && integer(args[2])) {
      state = await cutover.recordLegacyHoldsDrained(args[0], args[1], integer(args[2]));
    } else if ((command === "enable" || command === "stop-experience") && args.length === 3 && ID.test(args[0]) && ID.test(args[1]) && integer(args[2])) {
      state = command === "enable"
        ? await cutover.enableExperienceSales(args[0], args[1], integer(args[2]))
        : await cutover.stopExperienceSales(args[0], args[1], integer(args[2]));
    } else if (command === "import-confirmed" && args.length === 2 && integer(args[1])) {
      let manifest;
      try { manifest = JSON.parse(await readFile(args[0], "utf8")); } catch { return usage(); }
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return usage();
      if (Object.keys(manifest).some((key) => !["providerId", "productId", "reservations"].includes(key))) return usage();
      if (!Array.isArray(manifest.reservations) || manifest.reservations.some((row) =>
        !row || typeof row !== "object" || Array.isArray(row)
        || Object.keys(row).some((key) => !["sourceRefHash", "sourceRevision", "occurrenceId", "seats"].includes(key)))) return usage();
      state = await cutover.importConfirmedInventory({
        providerId: manifest.providerId,
        productId: manifest.productId,
        expectedVersion: integer(args[1]),
        reservations: manifest.reservations,
      });
    } else {
      return usage();
    }
    printState(state);
    return 0;
  } finally {
    await pool.end().catch(() => {});
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  // Driver messages and migration inputs may contain private references; never print them.
  const label = error instanceof Error ? error.name : typeof error;
  console.error(`Cutover refused or unavailable (${label}). Re-read status and version before retrying.`);
  process.exitCode = 1;
}
