import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ submitResult: vi.fn() }));

vi.mock("@/lib/experience/channel-runtime", () => ({
  boundedObject: async (request: Request) => request.json() as Promise<Record<string, unknown>>,
  channelEmpty: (status = 204) => new Response(null, { status }),
  channelFailure: () => Response.json({ error: "runtime_unavailable" }, { status: 503 }),
  channelJson: (body: unknown, status = 200) => Response.json(body, { status }),
  exactKeys: (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key)) && required.every((key) => key in value),
  internalContext: vi.fn().mockResolvedValue({
    worker: { workerId: "studio-1", credentialVersion: 1 }, runtime: { submitResult: mocks.submitResult },
  }),
}));

import { POST } from "./route";

const target = {
  site: "Airbnb", externalAccountId: "account", externalProductId: "product", externalOptionId: "morning",
  timeZone: "Asia/Tokyo", adapter: "browser-v1", adapterVersion: "1", connectionMode: "BROWSER",
};
const verified = {
  resultId: "00000000-0000-4000-8000-000000000001", leaseToken: "lease", outcome: "VERIFIED", stopped: true, target,
  occurrenceId: "rule@2099-01-01", sourceStartAtUtc: "2099-01-01T01:00:00.000Z", sourceEndAtUtc: "2099-01-01T02:00:00.000Z",
  observedState: "OPEN", observedBookable: true, observedManuallyBlocked: false, observedAtUtc: "2099-01-01T01:00:30.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.submitResult.mockResolvedValue({ acceptedAsCurrent: true, repeated: false });
});

describe("POST /internal/ota/v1/jobs/:id/result", () => {
  it("passes only the complete structured VERIFIED observation", async () => {
    const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/result", {
      method: "POST", body: JSON.stringify(verified), headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000002" }) });
    expect(response.status).toBe(204);
    expect(mocks.submitResult).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.objectContaining({
      occurrenceId: verified.occurrenceId, observedBookable: true, observedManuallyBlocked: false,
    }));
  });

  it("rejects an incomplete VERIFIED observation before the store", async () => {
    const incomplete: Partial<typeof verified> = { ...verified };
    delete incomplete.observedBookable;
    const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/result", {
      method: "POST", body: JSON.stringify(incomplete), headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000002" }) });
    expect(response.status).toBe(400);
    expect(mocks.submitResult).not.toHaveBeenCalled();
  });
});
