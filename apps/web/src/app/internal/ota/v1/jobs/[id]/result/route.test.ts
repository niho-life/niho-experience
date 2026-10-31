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
const googleVerified = {
  ...verified,
  target: { ...target, adapter: "airbnb-google-busy", connectionMode: "GOOGLE" },
  observedManuallyBlocked: undefined,
  googleAirbnbProof: {
    deliveryId: "00000000-0000-4000-8000-000000000020", evidence: "EXACT_SLOT_V1", partySize: 1,
  },
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
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ acceptedAsCurrent: true, repeated: false });
    expect(mocks.submitResult).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.objectContaining({
      occurrenceId: verified.occurrenceId, observedBookable: true, observedManuallyBlocked: false,
    }));
  });

  it("acknowledges a recorded stale verification without labelling it current", async () => {
    mocks.submitResult.mockResolvedValue({ acceptedAsCurrent: false, repeated: true });
    const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/result", {
      method: "POST", body: JSON.stringify(verified), headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000002" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ acceptedAsCurrent: false, repeated: true });
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

  it("accepts only the exclusive terminal receipt shape for RESERVATION_VERIFIED", async () => {
    const reservation = {
      resultId: "00000000-0000-4000-8000-000000000011", leaseToken: "lease", outcome: "RESERVATION_VERIFIED",
      stopped: true, target, reservationReadId: "00000000-0000-4000-8000-000000000012",
      reservationReceiptId: "00000000-0000-4000-8000-000000000013",
    };
    const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/result", {
      method: "POST", body: JSON.stringify(reservation), headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000002" }) });
    expect(response.status).toBe(200);
    expect(mocks.submitResult).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.objectContaining({
      outcome: "RESERVATION_VERIFIED", reservationReadId: reservation.reservationReadId,
      reservationReceiptId: reservation.reservationReceiptId,
    }));

    vi.clearAllMocks();
    const mixed = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/result", {
      method: "POST", body: JSON.stringify({ ...reservation, observedState: "OPEN" }), headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000002" }) });
    expect(mixed.status).toBe(400);
    expect(mocks.submitResult).not.toHaveBeenCalled();
  });

  it("passes the exact typed Google/Airbnb proof without exposing metadata in the ACK", async () => {
    const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/result", {
      method: "POST", body: JSON.stringify(googleVerified), headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000002" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ acceptedAsCurrent: true, repeated: false });
    expect(mocks.submitResult).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.objectContaining({
      googleAirbnbProof: googleVerified.googleAirbnbProof,
    }));
  });

  it("passes the exact typed proof on a structured RETRY_WAIT mismatch", async () => {
    const mismatch = { ...googleVerified, outcome: "RETRY_WAIT", observedState: "CLOSED", observedBookable: false };
    const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/result", {
      method: "POST", body: JSON.stringify(mismatch), headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000002" }) });
    expect(response.status).toBe(200);
    expect(mocks.submitResult).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.objectContaining({
      outcome: "RETRY_WAIT", observedState: "CLOSED", observedBookable: false,
      googleAirbnbProof: googleVerified.googleAirbnbProof,
    }));
  });

  it.each([
    { deliveryId: "not-a-uuid", evidence: "EXACT_SLOT_V1", partySize: 1 },
    { evidence: "OTHER", partySize: 1 },
    { evidence: "EXACT_SLOT_V1", partySize: 2 },
    { evidence: "EXACT_SLOT_V1", partySize: 1, extra: true },
  ])("rejects malformed typed proof %# before the store", async (proof) => {
    const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/result", {
      method: "POST", body: JSON.stringify({ ...googleVerified, googleAirbnbProof: { deliveryId: googleVerified.googleAirbnbProof.deliveryId, ...proof } }),
      headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000002" }) });
    expect(response.status).toBe(400);
    expect(mocks.submitResult).not.toHaveBeenCalled();
  });

  it("passes ensureCreated with a structured VERIFIED observation", async () => {
    const ensured = { ...verified, target: { ...target, site: "GetYourGuide", adapter: "gyg-browser" }, ensureCreated: false };
    const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/result", {
      method: "POST", body: JSON.stringify(ensured), headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000002" }) });
    expect(response.status).toBe(200);
    expect(mocks.submitResult).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.objectContaining({
      outcome: "VERIFIED", ensureCreated: false, observedManuallyBlocked: false,
    }));
  });

  it.each([
    { ...verified, ensureCreated: "true" },
    { ...verified, ensureCreated: null },
    { resultId: verified.resultId, leaseToken: "lease", outcome: "UNKNOWN_AFTER_SAVE", stopped: true, target, ensureCreated: true },
    { resultId: verified.resultId, leaseToken: "lease", outcome: "NEEDS_REVIEW", stopped: true, target, ensureCreated: false },
  ])("rejects ensureCreated that is not a boolean on VERIFIED %# before the store", async (body) => {
    const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/result", {
      method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000002" }) });
    expect(response.status).toBe(400);
    expect(mocks.submitResult).not.toHaveBeenCalled();
  });

  it("rejects mixed manual-blocked and typed proof shapes", async () => {
    const response = await POST(new Request("https://example.test/internal/ota/v1/jobs/job/result", {
      method: "POST", body: JSON.stringify({ ...googleVerified, observedManuallyBlocked: false }),
      headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000002" }) });
    expect(response.status).toBe(400);
    expect(mocks.submitResult).not.toHaveBeenCalled();
  });
});
