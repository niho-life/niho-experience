import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ beginReservationRead: vi.fn() }));
vi.mock("@/lib/experience/channel-runtime", () => ({
  boundedObject: async (request: Request) => request.json() as Promise<Record<string, unknown>>,
  channelFailure: () => Response.json({ error: "runtime_unavailable" }, { status: 503 }),
  channelJson: (body: unknown, status = 200) => Response.json(body, { status }),
  exactKeys: (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key)) && required.every((key) => key in value),
  internalContext: vi.fn().mockResolvedValue({
    worker: { workerId: "studio-1", credentialVersion: 1 }, runtime: { beginReservationRead: mocks.beginReservationRead },
  }),
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.beginReservationRead.mockResolvedValue({
    readId: "00000000-0000-4000-8000-000000000001", generation: 7, repeated: false,
    occurrenceId: "rule@2099-01-01", sourceStartAtUtc: "2099-01-01T01:00:00.000Z", sourceEndAtUtc: "2099-01-01T02:00:00.000Z",
  });
});

describe("POST /internal/ota/v1/jobs/:id/reservation-read", () => {
  it("begins a read only through the authenticated worker context", async () => {
    const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/reservation-read", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseToken: "lease" }),
    }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000002" }) });
    expect(response.status).toBe(200);
    expect(mocks.beginReservationRead).toHaveBeenCalledWith(
      { workerId: "studio-1", credentialVersion: 1 }, "00000000-0000-4000-8000-000000000002", "lease",
    );
  });

  it("rejects unknown fields before storage", async () => {
    const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/reservation-read", {
      method: "POST", body: JSON.stringify({ leaseToken: "lease", providerId: "untrusted" }), headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "job" }) });
    expect(response.status).toBe(400);
    expect(mocks.beginReservationRead).not.toHaveBeenCalled();
  });
});
