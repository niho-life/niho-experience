import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ submit: vi.fn(), context: vi.fn() }));
vi.mock("@/lib/experience/channel-runtime", () => ({
  boundedObject: async (request: Request) => request.json() as Promise<Record<string, unknown>>,
  channelFailure: () => Response.json({ error: "runtime_unavailable" }, { status: 503 }),
  channelJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  exactKeys: (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key)) && required.every((key) => key in value),
  internalContext: mocks.context,
}));

import { POST } from "./route";

const observation = {
  externalReservationId: "synthetic-reservation", externalProductId: "synthetic-product", externalOptionId: "morning",
  sourceStartAtUtc: "2099-01-01T01:00:00.000Z", sourceEndAtUtc: "2099-01-01T02:00:00.000Z",
  status: "CONFIRMED", seats: 1,
};
const valid = {
  receiptId: "00000000-0000-4000-8000-000000000001", readId: "00000000-0000-4000-8000-000000000002",
  leaseToken: "lease", pageNumber: 0, nextSourceCursor: "next-page", observations: [observation],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockResolvedValue({ worker: { workerId: "studio-1", credentialVersion: 1 },
    runtime: { submitReservationWindowPage: mocks.submit } });
  mocks.submit.mockResolvedValue({ ...valid, generation: 2, applied: 1, duplicates: 0, duplicateFacts: 0, stale: 0,
    needsReview: 0, missingActiveReservations: 0, healthUpdated: false, repeated: false,
    nextReceiptId: "00000000-0000-4000-8000-000000000003" });
});

describe("POST /internal/ota/v1/jobs/:id/reservation-window-pages", () => {
  it("accepts only the bounded page contract through worker auth", async () => {
    const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/reservation-window-pages", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(valid),
    }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000004" }) });
    expect(response.status).toBe(200);
    expect(mocks.submit).toHaveBeenCalledWith(expect.anything(), "00000000-0000-4000-8000-000000000004", valid);
  });

  it("rejects secret fields, more than 32 facts, and invalid source cursor chains", async () => {
    for (const body of [
      { ...valid, customerEmail: "nobody@example.test" },
      { ...valid, observations: Array.from({ length: 33 }, () => observation) },
      { ...valid, terminal: { status: "COMPLETE", completedAtUtc: "2099-01-01T02:00:00.000Z",
        allPagesRead: true, allStatusesIncluded: true, coverageComplete: true } },
      { ...valid, sourceCursor: "not-allowed-on-first-page" },
      { ...valid, pageNumber: 1, previousReceiptId: "00000000-0000-4000-8000-000000000003", sourceCursor: undefined },
      { ...valid, observations: [{ ...observation, cookie: "secret" }] },
    ]) {
      const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/reservation-window-pages", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: "job" }) });
      expect(response.status).toBe(400);
    }
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
