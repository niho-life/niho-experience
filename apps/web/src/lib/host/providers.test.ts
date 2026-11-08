import { describe, expect, it } from "vitest";
import { hasOwnerMembership, nihoIdOrNull, providerRoleLabel, selectProvider, toProviderChoice, usableProviders, type HostConsoleChoice, type HostProvider } from "./providers";

const provider = (fields: Partial<HostProvider> = {}): HostProvider => ({
  id: "experience-provider-1",
  legacyProviderId: "niho-legacy-provider-1",
  nihoUserId: "current-niho-user-1",
  displayName: "合成の台所",
  memberRole: "OWNER",
  ...fields,
});

describe("Experience provider choices", () => {
  it("leaves out invalid provider ids and blank names", () => {
    const kept = provider({ id: "experience-provider-3", displayName: "合成工房", memberRole: null });
    expect(usableProviders([provider({ id: "../x" }), provider({ id: "provider-2", displayName: "  " }), kept])).toEqual([kept]);
  });

  it("gives the client switcher only the Experience provider id, name and role", () => {
    expect(toProviderChoice(provider({ id: "provider-1", displayName: " 合成の台所 ", memberRole: "EDITOR" }))).toEqual({
      kind: "MEMBER", id: "provider-1", displayName: "合成の台所", memberRole: "EDITOR",
    });
  });

  it("opens the requested provider when the account has it, else the first", () => {
    const providers = [{ id: "a" }, { id: "b" }];
    expect(selectProvider(providers, "b")).toEqual({ provider: providers[1], requestedMissing: false });
    expect(selectProvider(providers, "z")).toEqual({ provider: providers[0], requestedMissing: true });
    expect(selectProvider([], null)).toEqual({ provider: null, requestedMissing: false });
  });

  it("offers the article writer only when the account has an OWNER membership", () => {
    const editor = toProviderChoice(provider({ id: "provider-editor", memberRole: "EDITOR" }));
    const cohost = toProviderChoice(provider({ id: "provider-cohost", memberRole: "COHOST" }));
    const operator: HostConsoleChoice = { kind: "OPERATOR", id: "operator-1", displayName: "Operator", memberRole: null };
    const owner = toProviderChoice(provider({ id: "provider-owner", memberRole: "OWNER" }));
    expect(hasOwnerMembership([editor, cohost, operator])).toBe(false);
    expect(hasOwnerMembership([editor, owner])).toBe(true);
  });

  it("accepts only url-safe IDs for ?providerId=", () => {
    expect(nihoIdOrNull("cm1abc_DEF-2")).toBe("cm1abc_DEF-2");
    for (const bad of ["", "a/b", "a b", "<x>", "x".repeat(129), ["a"], 1, null]) expect(nihoIdOrNull(bad)).toBeNull();
  });

  it("labels current Experience roles", () => {
    expect(providerRoleLabel("OWNER")).toBe("オーナー");
    expect(providerRoleLabel("EDITOR")).toBe("編集者");
    expect(providerRoleLabel("VIEWER")).toBe("閲覧者");
    expect(providerRoleLabel("COHOST")).toBe("サブホスト");
    expect(providerRoleLabel(null)).toBeNull();
  });
});
