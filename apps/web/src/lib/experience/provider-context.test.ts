import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/host/server", () => ({
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status }),
}));
vi.mock("./store-server", () => ({ experiencePublicationRepository: () => null }));

import { requestedProviderId, resolveProviderContext } from "./provider-context";

const session = { hostAccountId: `hst_${"a".repeat(32)}` };
const reader = (rows: Array<{ providerId: string; role: "OWNER" | "COHOST" | "EDITOR" | "VIEWER" }>) => ({
  listHostAccountMemberships: vi.fn(async (_account: string, only?: string) => rows
    .filter((row) => only === undefined || row.providerId === only)
    .map((row) => ({ ...row, accountActive: true }))),
});
const url = (query: string) => new Request(`https://experience.example.test/host/api/products${query}`);
const NOT_FOUND = { code: "NOT_FOUND", status: 404 };

describe("resolveProviderContext", () => {
  it("answers PROVIDER_REQUIRED for two OWNER providers and the one provider otherwise", async () => {
    const two = await resolveProviderContext(session, null, ["OWNER"], reader([{ providerId: "a", role: "OWNER" }, { providerId: "b", role: "OWNER" }]));
    expect(!two.ok && two.response.status).toBe(409);
    const one = await resolveProviderContext(session, null, ["OWNER"], reader([{ providerId: "a", role: "OWNER" }, { providerId: "b", role: "VIEWER" }]));
    expect(one.ok && one.value).toEqual({ actor: { providerId: "a", nihoUserId: session.hostAccountId }, role: "OWNER", accountActive: true });
  });

  it("widens by role only when the caller names the roles", async () => {
    const rows = [{ providerId: "a", role: "COHOST" as const }];
    expect((await resolveProviderContext(session, "a", ["OWNER"], reader(rows))).ok).toBe(false);
    expect((await resolveProviderContext(session, "a", ["OWNER", "COHOST"], reader(rows))).ok).toBe(true);
  });

  it("refuses an account that is not active, even as the OWNER", async () => {
    const suspended = { listHostAccountMemberships: vi.fn(async () => [{ providerId: "a", role: "OWNER" as const, accountActive: false }]) };
    const result = await resolveProviderContext(session, "a", ["OWNER"], suspended);
    expect(!result.ok && result.response.status).toBe(403);
  });

  it("refuses without a store", async () => {
    const result = await resolveProviderContext(session, null);
    expect(!result.ok && result.response.status).toBe(502);
  });
});

describe("requestedProviderId", () => {
  it("reads one valid providerId, nothing, or refuses", async () => {
    expect(requestedProviderId(url(""), NOT_FOUND)).toEqual({ ok: true, providerId: null });
    expect(requestedProviderId(url("?providerId=provider-1"), NOT_FOUND)).toEqual({ ok: true, providerId: "provider-1" });
    for (const [query, status] of [["?other=1", 404], ["?providerId=a&other=1", 404], ["?providerId=a&providerId=b", 404], ["?providerId=", 422], ["?providerId=a%20b", 422], ["?providerId=-x", 422]] as const) {
      const result = requestedProviderId(url(query), NOT_FOUND);
      expect(result.ok, query).toBe(false);
      if (!result.ok) expect(result.response.status, query).toBe(status);
    }
  });
});
