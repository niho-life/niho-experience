import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

const mocks = vi.hoisted(() => ({ authenticateWorker: vi.fn(), submitResult: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { apiMode: "http" } }));
vi.mock("./store-server", () => ({ channelRuntime: () => mocks }));

import { POST } from "@/app/internal/ota/v1/jobs/[id]/result/route";

type Receipt = { acceptedAsCurrent: boolean; repeated: boolean };
type CloudModule = { createCloudClient(options: { origin: string; token: string; fetchImpl: typeof fetch }): {
  result(jobId: string, payload: object): Promise<Receipt>;
} };
const { createCloudClient } = await vi.importActual<CloudModule>(fileURLToPath(
  new URL("../../../../../packages/ota-worker/src/cloud-client.mjs", import.meta.url),
));
const bearer = "synthetic-worker-credential-not-a-real-secret";
const jobId = "00000000-0000-4000-8000-000000000002";
const payload = {
  resultId: "00000000-0000-4000-8000-000000000001", leaseToken: "synthetic-lease", outcome: "VERIFIED", stopped: true,
  target: { site: "GetYourGuide", externalAccountId: "10001", externalProductId: "20002", externalOptionId: "30003",
    timeZone: "Asia/Tokyo", adapter: "gyg-browser", adapterVersion: "1", connectionMode: "BROWSER" },
  occurrenceId: "synthetic@2099-01-01", sourceStartAtUtc: "2099-01-01T04:00:00.000Z", sourceEndAtUtc: "2099-01-01T05:00:00.000Z",
  observedState: "CLOSED", observedBookable: false, observedManuallyBlocked: true, observedAtUtc: "2099-01-01T03:00:00.000Z",
};
const fetchRoute: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== "https://synthetic.example" || url.pathname !== `/internal/ota/v1/jobs/${jobId}/result`) throw new Error("Unexpected synthetic route");
  return POST(new Request(url, init), { params: Promise.resolve({ id: jobId }) });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EXPERIENCE_CHANNEL_RUNTIME_ENABLED", "true");
  mocks.authenticateWorker.mockImplementation(async (token: string) => {
    if (token !== bearer) throw new Error("Synthetic denied credential");
    return { workerId: "synthetic-studio", credentialVersion: 1 };
  });
  mocks.submitResult.mockResolvedValue({ acceptedAsCurrent: true, repeated: false });
});
afterEach(() => vi.unstubAllEnvs());

it("the actual worker client accepts the actual route's durable current receipt", async () => {
  const client = createCloudClient({ origin: "https://synthetic.example", token: bearer, fetchImpl: fetchRoute });
  expect(await client.result(jobId, payload)).toEqual({ acceptedAsCurrent: true, repeated: false });
  expect(mocks.submitResult).toHaveBeenCalledTimes(1);
});

it("a recorded stale receipt crosses the real producer/consumer boundary without a false green", async () => {
  mocks.submitResult.mockResolvedValue({ acceptedAsCurrent: false, repeated: true });
  const client = createCloudClient({ origin: "https://synthetic.example", token: bearer, fetchImpl: fetchRoute });
  expect(await client.result(jobId, payload)).toEqual({ acceptedAsCurrent: false, repeated: true });
});

it("a foreign bearer is rejected before a worker result reaches storage", async () => {
  const client = createCloudClient({ origin: "https://synthetic.example", token: "synthetic-foreign", fetchImpl: fetchRoute });
  await expect(client.result(jobId, payload)).rejects.toMatchObject({ code: "AUTH", status: 401 });
  expect(mocks.submitResult).not.toHaveBeenCalled();
});
