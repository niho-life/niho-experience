import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiMode: "http", runtime: null as null | { authenticateWorker: ReturnType<typeof vi.fn> } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { get apiMode() { return mocks.apiMode; } } }));
vi.mock("./store-server", () => ({ channelRuntime: () => mocks.runtime }));

import { boundedObject, channelManagerEnabled, channelWorkerEnabled, googleChannelDeliveryEnabled, googleChannelObservationEnabled, internalContext } from "./channel-runtime";

const originalManagerFlag = process.env.EXPERIENCE_CHANNEL_MANAGER_ENABLED;
const originalRuntimeFlag = process.env.EXPERIENCE_CHANNEL_RUNTIME_ENABLED;
const originalGoogleDeliveryFlag = process.env.EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED;
const originalGoogleObservationFlag = process.env.EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiMode = "http";
  mocks.runtime = { authenticateWorker: vi.fn().mockResolvedValue({ workerId: "studio-1", credentialVersion: 1 }) };
  process.env.EXPERIENCE_CHANNEL_MANAGER_ENABLED = "true";
  process.env.EXPERIENCE_CHANNEL_RUNTIME_ENABLED = "true";
  delete process.env.EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED;
  delete process.env.EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED;
});

afterEach(() => {
  if (originalManagerFlag === undefined) delete process.env.EXPERIENCE_CHANNEL_MANAGER_ENABLED;
  else process.env.EXPERIENCE_CHANNEL_MANAGER_ENABLED = originalManagerFlag;
  if (originalRuntimeFlag === undefined) delete process.env.EXPERIENCE_CHANNEL_RUNTIME_ENABLED;
  else process.env.EXPERIENCE_CHANNEL_RUNTIME_ENABLED = originalRuntimeFlag;
  if (originalGoogleDeliveryFlag === undefined) delete process.env.EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED;
  else process.env.EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED = originalGoogleDeliveryFlag;
  if (originalGoogleObservationFlag === undefined) delete process.env.EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED;
  else process.env.EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED = originalGoogleObservationFlag;
});

describe("channel HTTP boundary", () => {
  const status = async (value: ReturnType<typeof internalContext>) => {
    const result = await value;
    expect(result).toBeInstanceOf(Response);
    return (result as Response).status;
  };

  it("keeps mock and unset flags closed", () => {
    mocks.apiMode = "mock";
    expect(channelManagerEnabled()).toBe(false);
    expect(channelWorkerEnabled()).toBe(false);
    expect(googleChannelDeliveryEnabled()).toBe(false);
    expect(googleChannelObservationEnabled()).toBe(false);
    mocks.apiMode = "http";
    delete process.env.EXPERIENCE_CHANNEL_MANAGER_ENABLED;
    delete process.env.EXPERIENCE_CHANNEL_RUNTIME_ENABLED;
    expect(channelManagerEnabled()).toBe(false);
    expect(channelWorkerEnabled()).toBe(false);
    expect(googleChannelDeliveryEnabled()).toBe(false);
  });

  it("requires both the channel runtime and dedicated Google delivery flags in HTTP mode", () => {
    expect(googleChannelDeliveryEnabled()).toBe(false);
    process.env.EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED = "true";
    expect(googleChannelDeliveryEnabled()).toBe(true);
    delete process.env.EXPERIENCE_CHANNEL_RUNTIME_ENABLED;
    expect(googleChannelDeliveryEnabled()).toBe(false);
    process.env.EXPERIENCE_CHANNEL_RUNTIME_ENABLED = "true";
    mocks.apiMode = "mock";
    expect(googleChannelDeliveryEnabled()).toBe(false);
  });

  it("requires the existing delivery gate plus the observation gate for fresh GET proof", () => {
    process.env.EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED = "true";
    expect(googleChannelObservationEnabled()).toBe(false);
    process.env.EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED = "true";
    expect(googleChannelObservationEnabled()).toBe(true);
    delete process.env.EXPERIENCE_CHANNEL_RUNTIME_ENABLED;
    expect(googleChannelObservationEnabled()).toBe(false);
  });

  it("requires an explicit worker flag, database, and bearer credential", async () => {
    delete process.env.EXPERIENCE_CHANNEL_RUNTIME_ENABLED;
    expect(await status(internalContext(new Request("https://example.test/internal/ota/v1/claim")))).toBe(404);
    process.env.EXPERIENCE_CHANNEL_RUNTIME_ENABLED = "true";
    mocks.runtime = null;
    expect(await status(internalContext(new Request("https://example.test/internal/ota/v1/claim")))).toBe(503);
    mocks.runtime = { authenticateWorker: vi.fn().mockRejectedValue(new Error("wrong")) };
    expect(await status(internalContext(new Request("https://example.test/internal/ota/v1/claim", { headers: { authorization: "Bearer wrong" } })))).toBe(401);
    expect(await status(internalContext(new Request("https://example.test/internal/ota/v1/claim")))).toBe(401);
  });

  it("accepts only bounded exact JSON transport", async () => {
    const tooLarge = await boundedObject(new Request("https://example.test/internal/ota/v1/claim", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "x".repeat(17 * 1024) }),
    }));
    expect(tooLarge).toBeInstanceOf(Response);
    expect((tooLarge as Response).status).toBe(413);
    const query = await boundedObject(new Request("https://example.test/internal/ota/v1/claim?token=bad", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }));
    expect((query as Response).status).toBe(400);
  });
});
