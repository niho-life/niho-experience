import { describe, expect, it } from "vitest";
import { nihoIdOrNull, providerRoleLabel, selectProvider, toProviderChoice, usableProviders, type HostProvider } from "./providers";

const provider = (fields: Partial<HostProvider>): HostProvider => ({
  id: "p_1",
  ownerUserId: "u_1",
  vesselSpotId: "s_1",
  kind: "INDIVIDUAL",
  displayName: "合成の台所",
  bio: "",
  sellerDisclosureUrl: null,
  reviewStatus: "DRAFT",
  consentVersion: "v1",
  consentedAt: "2026-10-01T00:00:00.000Z",
  submittedAt: null,
  approvedAt: null,
  paymentReuseConsentVersion: null,
  paymentReuseConsentedAt: null,
  paymentReuseSourceSpotId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  memberRole: "OWNER",
  ...fields,
});

describe("provider list", () => {
  it("leaves out providers whose id cannot travel in ?providerId= or whose name is blank", () => {
    const kept = provider({ id: "p_3", displayName: "合成工房", memberRole: null });
    expect(usableProviders([provider({ id: "../x" }), provider({ id: "p_2", displayName: "  " }), kept])).toEqual([kept]);
  });

  it("gives the client switcher only the id, the name and the role", () => {
    expect(toProviderChoice(provider({ id: "p_1", displayName: " 合成の台所 ", memberRole: "EDITOR" }))).toEqual({ id: "p_1", displayName: "合成の台所", memberRole: "EDITOR" });
  });

  it("opens the requested provider when the account has it, else the first", () => {
    const providers = [{ id: "a" }, { id: "b" }];
    expect(selectProvider(providers, "b")).toEqual({ provider: providers[1], requestedMissing: false });
    expect(selectProvider(providers, "z")).toEqual({ provider: providers[0], requestedMissing: true });
    expect(selectProvider(providers, null)).toEqual({ provider: providers[0], requestedMissing: false });
    expect(selectProvider([], null)).toEqual({ provider: null, requestedMissing: false });
  });

  it("accepts only url-safe ids for ?providerId=", () => {
    expect(nihoIdOrNull("cm1abc_DEF-2")).toBe("cm1abc_DEF-2");
    for (const bad of ["", "a/b", "a b", "<x>", "x".repeat(65), ["a"], 1, null]) expect(nihoIdOrNull(bad)).toBeNull();
  });

  it("labels roles in Japanese", () => {
    expect(providerRoleLabel("OWNER")).toBe("オーナー");
    expect(providerRoleLabel("EDITOR")).toBe("編集者");
    expect(providerRoleLabel("COHOST")).toBe("サブホスト");
    expect(providerRoleLabel(null)).toBeNull();
  });
});
