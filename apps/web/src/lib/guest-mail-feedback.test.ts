import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { guestMailFeedbackResponse } from "./guest-mail-feedback";

const URL = "https://experience.example/internal/experience-mail-feedback/v1/events";
const settings = { enabled: true, audience: URL, serviceAccountEmail: "niho-api@example.iam.gserviceaccount.com" };
const verifier = { verify: vi.fn(async () => ({ ok: true as const, claims: { iss: "https://accounts.google.com", aud: URL, email: settings.serviceAccountEmail, emailVerified: true, exp: Math.floor(Date.now() / 1000) + 60 } })) };
const pool = {} as never;
const record = vi.fn(async (): Promise<"RECORDED" | "DUPLICATE" | "UNMATCHED"> => "RECORDED");
const payload = {
  eventId: "niho_feedback_001", deliveryRef: `ex1_${"a".repeat(32)}`, reportType: "BOUNCE", verification: "CORRELATED_DSN",
  classification: "NO_SUCH_ADDRESS", reportedAt: "2026-11-04T03:00:00.000Z",
};
function request(body: unknown = payload, headers: Record<string, string> = { "content-type": "application/json", authorization: "Bearer synthetic.jwt.token" }) {
  return new Request(URL, { method: "POST", headers, body: JSON.stringify(body) });
}

beforeEach(() => { vi.clearAllMocks(); });

describe("guestMailFeedbackResponse", () => {
  it("requires a configured, exact Google service identity before reading the payload", async () => {
    expect((await guestMailFeedbackResponse(request(), { settings: { ...settings, enabled: false }, verifier, pool: () => pool, record })).status).toBe(404);
    expect(verifier.verify).not.toHaveBeenCalled();
    const unauthorized = await guestMailFeedbackResponse(request(payload, { "content-type": "application/json", cookie: "session=x" }), { settings, verifier, pool: () => pool, record });
    expect(unauthorized.status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it("records only the strict PII-free event and acknowledges duplicates or unmatched refs safely", async () => {
    const response = await guestMailFeedbackResponse(request(), { settings, verifier, pool: () => pool, record });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, result: "RECORDED" });
    expect(record).toHaveBeenCalledWith(pool, expect.objectContaining({ eventId: payload.eventId, deliveryRef: payload.deliveryRef, reportedAt: new Date(payload.reportedAt) }));
    for (const invalid of [
      { ...payload, guestEmail: "guest@example.test" },
      { ...payload, deliveryRef: "db-row-1" },
      { ...payload, reportType: "COMPLAINT", verification: "CORRELATED_DSN", classification: "SPAM_COMPLAINT" },
    ]) expect((await guestMailFeedbackResponse(request(invalid), { settings, verifier, pool: () => pool, record })).status).toBe(400);
    record.mockResolvedValueOnce("DUPLICATE");
    expect((await guestMailFeedbackResponse(request(), { settings, verifier, pool: () => pool, record })).status).toBe(200);
    record.mockResolvedValueOnce("UNMATCHED");
    const unmatched = await guestMailFeedbackResponse(request(), { settings, verifier, pool: () => pool, record });
    expect(unmatched.status).toBe(202);
    expect(await unmatched.json()).toEqual({ accepted: false, result: "UNMATCHED" });
  });

  it("accepts an unverified ARF only as a complaint candidate", async () => {
    const complaint = { ...payload, reportType: "COMPLAINT", verification: "UNVERIFIED_ARF", classification: "SPAM_COMPLAINT" };
    expect((await guestMailFeedbackResponse(request(complaint), { settings, verifier, pool: () => pool, record })).status).toBe(200);
  });
});
