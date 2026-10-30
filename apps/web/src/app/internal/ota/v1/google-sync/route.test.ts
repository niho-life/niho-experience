import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  worker: { workerId: "studio-1", credentialVersion: 3 },
  sync: vi.fn(),
  context: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/experience/channel-runtime", () => ({
  boundedObject: vi.fn().mockResolvedValue({}), exactKeys: () => true,
  channelFailure: () => Response.json({ error: "runtime_unavailable" }, { status: 503 }),
  channelJson: (body: unknown, status = 200) => Response.json(body, { status }), internalContext: mocks.context,
}));
vi.mock("@/lib/experience/resource-google", () => ({ syncOneDueResourceGoogle: mocks.sync }));
vi.mock("@/lib/experience/store-server", () => ({ experiencePool: () => ({ synthetic: true }) }));

import { POST } from "./route";

describe("POST /internal/ota/v1/google-sync", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.context.mockResolvedValue({ runtime: {}, worker: mocks.worker });
    mocks.sync.mockResolvedValue({ processed: true, applied: true });
  });

  it("passes the authenticated worker identity and returns no calendar target", async () => {
    const response = await POST(new Request("https://example.test/internal/ota/v1/google-sync", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ processed: true, applied: true });
    expect(mocks.sync).toHaveBeenCalledWith(expect.anything(), mocks.worker);
  });

  it("stops before sync when worker authentication fails", async () => {
    mocks.context.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await POST(new Request("https://example.test/internal/ota/v1/google-sync", { method: "POST" }))).status).toBe(401);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
