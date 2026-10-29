import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  worker: { workerId: "studio-1", credentialVersion: 1 },
  runtime: { consumeCalendarOutbox: vi.fn(), claim: vi.fn() },
}));

vi.mock("@/lib/experience/channel-runtime", () => ({
  boundedObject: vi.fn().mockResolvedValue({}),
  channelEmpty: (status = 204) => new Response(null, { status }),
  channelFailure: () => Response.json({ error: "runtime_unavailable" }, { status: 503 }),
  channelJson: (body: unknown, status = 200) => Response.json(body, { status }),
  exactKeys: () => true,
  internalContext: vi.fn().mockResolvedValue({ runtime: mocks.runtime, worker: mocks.worker }),
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtime.consumeCalendarOutbox.mockResolvedValue({ events: 0, occurrences: 0, jobs: 0 });
  mocks.runtime.claim.mockResolvedValue(null);
});

describe("POST /internal/ota/v1/claim", () => {
  it("dispatches the authenticated worker scope before claiming and waits for it", async () => {
    const order: string[] = [];
    mocks.runtime.consumeCalendarOutbox.mockImplementation(async () => { order.push("dispatch"); });
    mocks.runtime.claim.mockImplementation(async () => { order.push("claim"); return null; });
    const response = await POST(new Request("https://example.test/internal/ota/v1/claim", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }));
    expect(response.status).toBe(204);
    expect(order).toEqual(["dispatch", "claim"]);
    expect(mocks.runtime.consumeCalendarOutbox).toHaveBeenCalledWith(50, mocks.worker);
  });

  it("does not claim after dispatch failure", async () => {
    mocks.runtime.consumeCalendarOutbox.mockRejectedValue(new Error("dispatch failed"));
    const response = await POST(new Request("https://example.test/internal/ota/v1/claim", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }));
    expect(response.status).toBe(503);
    expect(mocks.runtime.claim).not.toHaveBeenCalled();
  });
});
