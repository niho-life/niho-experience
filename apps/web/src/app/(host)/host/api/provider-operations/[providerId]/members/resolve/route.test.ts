import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ allowed: vi.fn(), load: vi.fn(), resolve: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@niho-experience/api-client/experience-provider-operations-schema", () => ({
  isExperienceProviderOperationPathId: (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value),
  decodeExperienceProviderResolveMemberInput: (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    return Object.keys(input).length === 1 && typeof input.email === "string" && /^[^@\s]+@[^@\s]+$/.test(input.email) ? { email: input.email } : null;
  },
}));
vi.mock("@/lib/host/provider-operations-server", () => ({
  providerOperationsMutationAllowed: mocks.allowed,
  loadProviderOperationsClient: mocks.load,
  readProviderOperationsJson: async (request: Request, maxBytes: number) => {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) return { ok: false };
    try { return { ok: true, value: JSON.parse(text) as unknown }; } catch { return { ok: false }; }
  },
  providerOperationsJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } }),
  providerOperationsFailure: mocks.failure,
}));

import { POST } from "./route";

const context = { params: Promise.resolve({ providerId: "provider_1" }) };
const request = (body: unknown) => new Request("https://experience.example/host/api/provider-operations/provider_1/members/resolve", {
  method: "POST", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("provider member resolution BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.allowed.mockReturnValue(true);
    mocks.resolve.mockResolvedValue({ ok: true, data: { candidate: { userId: "user_1", displayName: "合成候補" } } });
    mocks.load.mockResolvedValue({ ok: true, client: { resolveMember: mocks.resolve } });
  });

  it("accepts only an exact email body and returns only the public candidate", async () => {
    const response = await POST(request({ email: "cohost@example.test" }), context);
    expect(response.status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith("provider_1", { email: "cohost@example.test" });
    expect(await response.json()).toEqual({ candidate: { userId: "user_1", displayName: "合成候補" } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects cross-site, hidden directory fields and oversized bodies before calling upstream", async () => {
    mocks.allowed.mockReturnValue(false);
    expect((await POST(request({ email: "cohost@example.test" }), context)).status).toBe(403);
    mocks.allowed.mockReturnValue(true);
    expect((await POST(request({ email: "cohost@example.test", handle: "hidden" }), context)).status).toBe(400);
    expect((await POST(request({ email: `${"a".repeat(1100)}@example.test` }), context)).status).toBe(400);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
