import { describe, expect, it } from "vitest";
import { PROVIDER_REQUIRED_MESSAGE, apiErrorCode, hostApiPath, isProviderRequired, screenProviderId } from "./api-path";

describe("hostApiPath", () => {
  it("adds the host as the one place every screen does it, and leaves a call without a host alone", () => {
    expect(hostApiPath("/host/api/products", "provider-b")).toBe("/host/api/products?providerId=provider-b");
    expect(hostApiPath("/host/api/products", null)).toBe("/host/api/products");
    expect(hostApiPath("/host/api/products", undefined)).toBe("/host/api/products");
    expect(hostApiPath("/host/api/products", "")).toBe("/host/api/products");
    expect(hostApiPath("/host/api/products/p%201/media", "a b")).toBe("/host/api/products/p%201/media?providerId=a+b");
    expect(hostApiPath("/host/api/x?assetId=1", "provider-b")).toBe("/host/api/x?assetId=1&providerId=provider-b");
  });
});

describe("PROVIDER_REQUIRED", () => {
  it("is told apart from any other 409", () => {
    const body = { error: { code: "PROVIDER_REQUIRED" } };
    expect(isProviderRequired(409, body)).toBe(true);
    expect(isProviderRequired(403, body)).toBe(false);
    expect(isProviderRequired(409, { error: { code: "VERSION_CONFLICT" } })).toBe(false);
    expect(isProviderRequired(409, null)).toBe(false);
    expect(apiErrorCode({ error: { code: "X" } })).toBe("X");
    expect(PROVIDER_REQUIRED_MESSAGE).toBe("ホストを選んでください。");
  });
});

describe("screenProviderId", () => {
  it("is the host on screen, and none when the address names a host the account does not have", () => {
    expect(screenProviderId({ provider: { id: "a" }, providerNotFound: false })).toBe("a");
    expect(screenProviderId({ provider: { id: "a" }, providerNotFound: true })).toBeNull();
    expect(screenProviderId({ provider: null, providerNotFound: false })).toBeNull();
  });
});
