import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductOperatorAssignment } from "@niho-experience/experience-store";
import type { HostProvider } from "./providers";

const state = vi.hoisted(() => ({
  config: { hostTeamEnabled: true, hostAccountsEnabled: true, apiMode: "http" },
  session: { kind: "experience", hostAccountId: `hst_${"01".repeat(16)}` } as { kind: string; hostAccountId: string } | null,
  providers: [] as HostProvider[], assignments: [] as ProductOperatorAssignment[],
  operatorsEnabled: true, failed: false, status: "ok", calls: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config }));
vi.mock("@/lib/experience/store-server", () => ({
  productOperatorRepository: () => state.operatorsEnabled ? { listAssignments: async () => { state.calls(); if (state.failed) throw new Error("synthetic outage"); return state.assignments; } } : null,
}));
vi.mock("@/lib/host/server", () => ({
  readHostSession: async () => state.session,
  loadHostProvidersFresh: async () => ({ status: state.status, nihoUserId: state.session?.hostAccountId, providers: state.providers }),
  noStoreJson: (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "cache-control": "private, no-store" } }),
}));
import { renderedHostAccessFingerprint } from "./access-fingerprint";
import { GET } from "@/app/(host)/host/api/team/access/route";

const accountId = `hst_${"01".repeat(16)}`;
const provider = (id: string): HostProvider => ({ id, displayName: "Synthetic workspace", memberRole: "OWNER", nihoUserId: accountId, legacyProviderId: id });
const request = () => new Request("https://experience.example.test/host/api/team/access");

beforeEach(() => {
  state.session = { kind: "experience", hostAccountId: accountId };
  state.providers = [provider("provider-a")]; state.assignments = [];
  state.operatorsEnabled = true; state.failed = false; state.status = "ok"; state.calls.mockClear();
});

describe("rendered host access revalidation", () => {
  it("uses the same visible role projection and respects a disabled operator feature", async () => {
    state.operatorsEnabled = false;
    state.assignments = [{ providerId: "provider-b", productId: "product-b", productTitle: "Synthetic", sellerDisplayName: "Synthetic", assignmentLabel: "Synthetic", grantVersion: 4, grantExpiresAtUtc: "2099-01-01T00:00:00.000Z" }];
    const response = await GET(request());
    expect(await response.json()).toEqual({ contractVersion: 1, fingerprint: renderedHostAccessFingerprint(state.providers, []) });
    expect(state.calls).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("detects revocation after the render snapshot without rebinding that old snapshot", async () => {
    const rendered = renderedHostAccessFingerprint(state.providers, state.assignments);
    state.providers = [];
    const current = await (await GET(request())).json();
    expect(current.fingerprint).not.toBe(rendered);
    expect(JSON.stringify(current)).not.toContain(accountId);
  });

  it("detects expiration and version changes in the same enabled grant projection", async () => {
    const assignment: ProductOperatorAssignment = { providerId: "provider-a", productId: "product-a", productTitle: "Synthetic", sellerDisplayName: "Synthetic", assignmentLabel: "Synthetic", grantVersion: 3, grantExpiresAtUtc: "2099-01-01T00:00:00.000Z" };
    state.assignments = [assignment];
    const rendered = renderedHostAccessFingerprint(state.providers, state.assignments);
    expect((await (await GET(request())).json()).fingerprint).toBe(rendered);
    state.assignments = [{ ...assignment, grantVersion: 4 }];
    expect((await (await GET(request())).json()).fingerprint).not.toBe(rendered);
    state.assignments = [];
    expect((await (await GET(request())).json()).fingerprint).not.toBe(rendered);
  });

  it("distinguishes ended sessions from unavailable permission reads", async () => {
    state.failed = true;
    expect((await GET(request())).status).toBe(503);
    state.failed = false; state.status = "signed-out";
    expect((await GET(request())).status).toBe(401);
    state.session = null;
    expect((await GET(request())).status).toBe(401);
  });
});
