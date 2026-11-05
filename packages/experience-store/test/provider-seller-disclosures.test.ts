import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { StoreValidationError } from "../src/errors.ts";
import { validateSellerDisclosureInput } from "../src/provider-seller-disclosures.ts";

describe("provider seller disclosure validation", () => {
  it("keeps idempotency receipts free of disclosure result snapshots", async () => {
    const migration = await readFile(new URL("../migrations/0059_provider_seller_disclosures.sql", import.meta.url), "utf8");
    const receiptTable = migration.slice(migration.indexOf("CREATE TABLE provider_seller_disclosure_commands"), migration.indexOf("CREATE FUNCTION reject_provider_seller_disclosure_command_mutation"));
    assert.match(receiptTable, /request_fingerprint text NOT NULL/);
    assert.match(receiptTable, /actor_niho_user_id text NOT NULL/);
    assert.match(receiptTable, /applied_version bigint NOT NULL/);
    assert.doesNotMatch(receiptTable, /result_json|public_address|public_phone|public_email|external_url/);
  });

  it("accepts explicit native person/business fields and canonical https external pages", () => {
    assert.deepEqual(validateSellerDisclosureInput({
      method: "NATIVE", sellerKind: "PERSON", sellerDisplayName: "Synthetic Seller", representativeName: null,
      publicAddress: "1-2 Synthetic, Kamakura", publicPhone: "+81 46 000 0000", publicEmail: "public@example.test",
      consentVersion: "seller-public-disclosure-v1", accepted: true,
    }), {
      method: "NATIVE", sellerKind: "PERSON", sellerDisplayName: "Synthetic Seller", representativeName: null,
      publicAddress: "1-2 Synthetic, Kamakura", publicPhone: "+81 46 000 0000", publicEmail: "public@example.test",
      consentVersion: "seller-public-disclosure-v1", accepted: true,
    });
    assert.equal(validateSellerDisclosureInput({
      method: "NATIVE", sellerKind: "BUSINESS", sellerDisplayName: "Synthetic Seller", representativeName: "Synthetic Responsible Person",
      publicAddress: "1-2 Synthetic, Kamakura", publicPhone: "046-000-0000", publicEmail: "public@example.test",
      consentVersion: "seller-public-disclosure-v1", accepted: true,
    }).sellerKind, "BUSINESS");
    assert.equal(validateSellerDisclosureInput({
      method: "EXTERNAL", sellerKind: "PERSON", sellerDisplayName: "Synthetic Seller",
      externalUrl: "https://seller.example.test/legal", consentVersion: "seller-public-disclosure-v1", accepted: true,
    }).method, "EXTERNAL");
    assert.equal((validateSellerDisclosureInput({
      method: "EXTERNAL", sellerKind: "PERSON", sellerDisplayName: "Synthetic Seller",
      externalUrl: "https://seller.example.test", consentVersion: "seller-public-disclosure-v1", accepted: true,
    }) as { externalUrl: string }).externalUrl, "https://seller.example.test/");
  });

  it("preserves address lines while normalizing CRLF and rejects other control characters", () => {
    const native = {
      method: "NATIVE" as const, sellerKind: "PERSON" as const, sellerDisplayName: "Synthetic Seller", representativeName: null,
      publicAddress: "1-2 Synthetic\r\nBuilding 3", publicPhone: "046-000-0000", publicEmail: "public@example.test",
      consentVersion: "seller-public-disclosure-v1", accepted: true as const,
    };
    const result = validateSellerDisclosureInput(native);
    assert.equal(result.method === "NATIVE" ? result.publicAddress : null, "1-2 Synthetic\nBuilding 3");
    assert.throws(() => validateSellerDisclosureInput({ ...native, publicAddress: "Synthetic\tBuilding" }), StoreValidationError);
    assert.throws(() => validateSellerDisclosureInput({ ...native, publicPhone: "046\n0000000" }), StoreValidationError);
  });

  it("does not complete missing public facts or accept non-https pages", () => {
    assert.throws(() => validateSellerDisclosureInput({
      method: "NATIVE", sellerKind: "BUSINESS", sellerDisplayName: "Synthetic Seller", representativeName: null,
      publicAddress: "Synthetic address", publicPhone: "046-000-0000", publicEmail: "public@example.test",
      consentVersion: "seller-public-disclosure-v1", accepted: true,
    }), StoreValidationError);
    assert.throws(() => validateSellerDisclosureInput({
      method: "EXTERNAL", sellerKind: "PERSON", sellerDisplayName: "Synthetic Seller",
      externalUrl: "http://seller.example.test/legal", consentVersion: "seller-public-disclosure-v1", accepted: true,
    }), StoreValidationError);
  });
});
