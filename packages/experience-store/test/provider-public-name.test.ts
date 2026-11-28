import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StoreValidationError } from "../src/errors.ts";
import { ProviderPublicNameError, assertSelfRegistrationPublicName, isReservedProviderPublicName } from "../src/provider-public-name.ts";

describe("self-registration public names (#707)", () => {
  it("rejects names that pose as NIHO or its staff", () => {
    for (const name of ["NIHO 公式", "niho-travel", "ＮＩＨＯ", "○○事務局", "Official NIHO", "NIHO公式", "ニホ事務局 Tours"]) {
      assert.equal(isReservedProviderPublicName(name), true, name);
      assert.throws(() => assertSelfRegistrationPublicName(name, "publicDisplayName"), (error) =>
        error instanceof ProviderPublicNameError && error instanceof StoreValidationError && error.code === "PUBLIC_NAME_RESERVED" && error.field === "publicDisplayName");
    }
  });

  it("lets names through that only contain the letters", () => {
    for (const name of ["Nihonbashi Tours", "ニホン茶房", "Kamakura Tea House", "鎌倉の茶室", "Anihon"]) {
      assert.equal(assertSelfRegistrationPublicName(name, "publicDisplayName"), name);
    }
  });

  it("keeps Admin's shape: 1-300 characters, no space at either end, no control character", () => {
    for (const name of ["", " Tea", "Tea ", "Te\na", "a".repeat(301), 5, null]) {
      assert.throws(() => assertSelfRegistrationPublicName(name, "publicDisplayNameEn"), (error) => error instanceof ProviderPublicNameError && error.code === "PUBLIC_NAME_INVALID");
    }
    assert.equal(assertSelfRegistrationPublicName("a".repeat(300), "publicDisplayName").length, 300);
  });
});
