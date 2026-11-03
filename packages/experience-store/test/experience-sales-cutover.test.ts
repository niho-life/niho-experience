import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StoreValidationError } from "../src/errors.ts";
import { ExperienceSalesCutover, legacyInventoryManifestSha256 } from "../src/experience-sales-cutover.ts";

describe("Experience sales cutover manifest", () => {
  const reservations = [
    { sourceRefHash: "b".repeat(64), sourceRevision: 2, occurrenceId: "daily@2099-01-02", seats: 2 },
    { sourceRefHash: "a".repeat(64), sourceRevision: 1, occurrenceId: "daily@2099-01-01", seats: 1 },
  ] as const;

  it("hashes the normalized reservation facts without guest or raw source identifiers", () => {
    assert.equal(legacyInventoryManifestSha256(reservations), legacyInventoryManifestSha256([...reservations].reverse()));
    assert.notEqual(legacyInventoryManifestSha256(reservations), legacyInventoryManifestSha256([
      ...reservations.slice(0, 1), { ...reservations[1]!, seats: 3 },
    ]));
  });

  it("rejects duplicate source identities and unkeyed/raw source IDs before PostgreSQL", async () => {
    const cutover = new ExperienceSalesCutover({ query: () => { throw new Error("validation must happen before database access"); } } as never);
    assert.throws(() => legacyInventoryManifestSha256([
      reservations[0]!, { ...reservations[0]!, occurrenceId: "daily@2099-01-03" },
    ]), StoreValidationError);
    await assert.rejects(cutover.importConfirmedInventory({
      providerId: "provider-synthetic", productId: "product-synthetic", expectedVersion: 1,
      reservations: [{ ...reservations[0]!, sourceRefHash: "legacy-booking-123" }],
    }), StoreValidationError);
  });
});
