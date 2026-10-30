import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(), context: vi.fn(), execute: vi.fn(), pool: { synthetic: true },
  worker: { workerId: "studio-1", credentialVersion: 3 }, runtime: { synthetic: true },
}));
vi.mock("@/lib/experience/channel-runtime", () => ({
  googleChannelDeliveryEnabled: mocks.enabled,
  internalContext: mocks.context,
  boundedObject: async (request: Request) => {
    if (new URL(request.url).search) return Response.json({ error: "invalid_input" }, { status: 400 });
    return request.json() as Promise<Record<string, unknown>>;
  },
  exactKeys: (value: Record<string, unknown>, required: readonly string[]) =>
    Object.keys(value).every((key) => required.includes(key)) && required.every((key) => key in value),
  channelJson: (body: unknown, status = 200) => Response.json(body, { status }),
  channelFailure: () => Response.json({ error: "runtime_unavailable" }, { status: 503 }),
}));
vi.mock("@/lib/experience/google-channel-delivery", () => ({ executeGoogleChannelDelivery: mocks.execute }));
vi.mock("@/lib/experience/store-server", () => ({ experiencePool: () => mocks.pool }));

import { POST } from "./route";

const request = (body: unknown, query = "") => new Request(`https://example.test/internal/ota/v1/jobs/job/google-delivery${query}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const params = { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }) };

describe("POST /internal/ota/v1/jobs/:id/google-delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled.mockReturnValue(true);
    mocks.context.mockResolvedValue({ worker: mocks.worker, runtime: mocks.runtime });
    mocks.execute.mockResolvedValue({
      deliveryId: "00000000-0000-4000-8000-000000000002", phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED",
      calendarId: "must-not-leak", eventId: "must-not-leak", token: "must-not-leak",
    });
  });

  it("is default-off and stops before authentication", async () => {
    mocks.enabled.mockReturnValue(false);
    const response = await POST(request({ leaseToken: "lease", operation: "dispatch" }), params);
    expect(response.status).toBe(404);
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it("stops before body parsing and execution when unauthenticated", async () => {
    mocks.context.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await POST(request({ leaseToken: "lease", operation: "dispatch" }), params)).status).toBe(401);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects query strings, extra target input, and invalid operations", async () => {
    for (const [body, query] of [
      [{ leaseToken: "lease", operation: "dispatch" }, "?calendarId=untrusted"],
      [{ leaseToken: "lease", operation: "dispatch", providerId: "untrusted" }, ""],
      [{ leaseToken: "lease", operation: "write" }, ""],
    ] as const) {
      expect((await POST(request(body, query), params)).status).toBe(400);
    }
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("calls the server executor from authenticated context and returns only static opaque state", async () => {
    const response = await POST(request({ leaseToken: "lease", operation: "dispatch" }), params);
    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith(
      mocks.pool, mocks.runtime, mocks.worker, "00000000-0000-4000-8000-000000000001", "lease", "dispatch",
    );
    expect(await response.json()).toEqual({
      deliveryId: "00000000-0000-4000-8000-000000000002", phase: "GOOGLE_VERIFIED", airbnb: "UNVERIFIED",
    });
  });
});
