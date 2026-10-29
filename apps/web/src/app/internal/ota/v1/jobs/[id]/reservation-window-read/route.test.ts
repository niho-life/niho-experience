import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ begin: vi.fn(), context: vi.fn() }));
vi.mock("@/lib/experience/channel-runtime", () => ({
  boundedObject: async (request: Request) => request.json() as Promise<Record<string, unknown>>,
  channelFailure: () => Response.json({ error: "runtime_unavailable" }, { status: 503 }),
  channelJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  exactKeys: (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key)) && required.every((key) => key in value),
  internalContext: mocks.context,
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockResolvedValue({ worker: { workerId: "studio-1", credentialVersion: 1 },
    runtime: { beginReservationWindowRead: mocks.begin } });
  mocks.begin.mockResolvedValue({
    readId: "00000000-0000-4000-8000-000000000001", generation: 2, scope: "WINDOW", repeated: false,
    coverageFromUtc: "2099-01-01T00:00:00.000Z", coverageToUtc: "2099-02-26T00:00:00.000Z",
    readStartedAtUtc: "2099-01-01T00:00:00.000Z", pageNumber: 0,
    receiptId: "00000000-0000-4000-8000-000000000002", manifest: [],
  });
});

describe("POST /internal/ota/v1/jobs/:id/reservation-window-read", () => {
  it("uses authenticated worker context and returns no-store manifest", async () => {
    const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/reservation-window-read", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken: "lease" }),
    }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000003" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.begin).toHaveBeenCalledWith({ workerId: "studio-1", credentialVersion: 1 },
      "00000000-0000-4000-8000-000000000003", "lease");
  });

  it("rejects unknown fields before store access", async () => {
    const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/reservation-window-read", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken: "lease", productId: "untrusted" }),
    }), { params: Promise.resolve({ id: "job" }) });
    expect(response.status).toBe(400);
    expect(mocks.begin).not.toHaveBeenCalled();
  });
});
