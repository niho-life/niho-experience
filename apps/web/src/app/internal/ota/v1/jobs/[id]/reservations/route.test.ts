import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ submitReservationRead: vi.fn() }));
vi.mock("@/lib/experience/channel-runtime", () => ({
  boundedObject: async (request: Request) => request.json() as Promise<Record<string, unknown>>,
  channelFailure: () => Response.json({ error: "runtime_unavailable" }, { status: 503 }),
  channelJson: (body: unknown, status = 200) => Response.json(body, { status }),
  exactKeys: (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key)) && required.every((key) => key in value),
  internalContext: vi.fn().mockResolvedValue({
    worker: { workerId: "studio-1", credentialVersion: 1 }, runtime: { submitReservationRead: mocks.submitReservationRead },
  }),
}));

import { POST } from "./route";

const valid = {
  receiptId: "00000000-0000-4000-8000-000000000001", readId: "00000000-0000-4000-8000-000000000002",
  leaseToken: "lease", batchStatus: "COMPLETE",
  observations: [{
    externalReservationId: "synthetic-reservation", externalProductId: "external-product", externalOptionId: "morning",
    sourceStartAtUtc: "2099-01-01T01:00:00.000Z", sourceEndAtUtc: "2099-01-01T02:00:00.000Z",
    status: "CONFIRMED", seats: 2, sourceRevision: "opaque-a",
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.submitReservationRead.mockResolvedValue({
    receiptId: valid.receiptId, readId: valid.readId, batchStatus: "COMPLETE", generation: 9,
    applied: 1, duplicates: 0, stale: 0, needsReview: 0, repeated: false,
  });
});

describe("POST /internal/ota/v1/jobs/:id/reservations", () => {
  it("forwards only bounded reservation facts and returns a non-sensitive receipt", async () => {
    const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/reservations", {
      method: "POST", body: JSON.stringify(valid), headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000003" }) });
    expect(response.status).toBe(200);
    expect(mocks.submitReservationRead).toHaveBeenCalledWith(expect.anything(), expect.any(String), valid);
    expect(JSON.stringify(await response.json())).not.toMatch(/guest|email|price/i);
  });

  it("rejects duplicate-shaped secret fields and FAILED batches with facts", async () => {
    for (const body of [
      { ...valid, observations: [{ ...valid.observations[0], customerEmail: "nobody@example.test" }] },
      { ...valid, batchStatus: "FAILED" },
    ]) {
      const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/reservations", {
        method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
      }), { params: Promise.resolve({ id: "job" }) });
      expect(response.status).toBe(400);
    }
    expect(mocks.submitReservationRead).not.toHaveBeenCalled();
  });

  it("rejects more than 32 observations", async () => {
    const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/reservations", {
      method: "POST", body: JSON.stringify({ ...valid, observations: Array.from({ length: 33 }, () => valid.observations[0]) }),
      headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "job" }) });
    expect(response.status).toBe(400);
    expect(mocks.submitReservationRead).not.toHaveBeenCalled();
  });
});
