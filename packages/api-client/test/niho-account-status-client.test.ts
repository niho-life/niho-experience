import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createNihoAccountStatusClient, NIHO_ACCOUNT_STATUS_PATH } from "../src/niho-account-status/client.ts";
import type { FetchLike } from "../src/client.ts";

const ORIGIN = "https://niho.example";
const SERVICE_TOKEN = "header.payload.signature";
const NIHO_A = "niho-user-synthetic-a";
const NIHO_B = "niho-user-synthetic-b";
const respond = (status: number, body: unknown): FetchLike => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("NIHO account status client", () => {
  it("uses only the Experience service identity and strictly matches one response per requested ID", async () => {
    const fetcher = respond(200, { statuses: [
      { nihoUserId: NIHO_A, status: "active" },
      { nihoUserId: NIHO_B, status: "merged", currentUserId: "niho-user-synthetic-current" },
    ] });
    const client = createNihoAccountStatusClient({ nihoWebOrigin: ORIGIN, serviceIdToken: SERVICE_TOKEN, fetch: fetcher });
    expect(await client.getStatuses([NIHO_A, NIHO_B])).toEqual({ ok: true, statuses: [
      { nihoUserId: NIHO_A, status: "active" },
      { nihoUserId: NIHO_B, status: "merged", currentUserId: "niho-user-synthetic-current" },
    ] });
    expect(fetcher).toHaveBeenCalledWith(`${ORIGIN}${NIHO_ACCOUNT_STATUS_PATH}`, expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "x-niho-experience-service-id-token": SERVICE_TOKEN }),
      body: JSON.stringify({ nihoUserIds: [NIHO_A, NIHO_B] }),
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }));
    expect((fetcher as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).not.toHaveProperty("authorization");
  });

  it("treats transport and contract failures as unavailable and never returns a partial batch", async () => {
    const client = (body: unknown, status = 200) => createNihoAccountStatusClient({
      nihoWebOrigin: ORIGIN, serviceIdToken: SERVICE_TOKEN, fetch: respond(status, body),
    });
    expect(await client({ statuses: [{ nihoUserId: NIHO_A, status: "active" }] }).getStatuses([NIHO_A, NIHO_B]))
      .toEqual({ ok: false, kind: "unexpected_response", status: 200 });
    expect(await client({ statuses: [{ nihoUserId: NIHO_A, status: "suspended" }] }).getStatuses([NIHO_A]))
      .toEqual({ ok: false, kind: "unexpected_response", status: 200 });
    expect(await client({ statuses: [{ nihoUserId: NIHO_A, status: "merged", currentUserId: `trv_${"a".repeat(32)}` }] }).getStatuses([NIHO_A]))
      .toEqual({ ok: false, kind: "unexpected_response", status: 200 });
    expect(await client({}, 503).getStatuses([NIHO_A])).toEqual({ ok: false, kind: "unavailable", status: 503 });
    expect(await createNihoAccountStatusClient({ nihoWebOrigin: ORIGIN, serviceIdToken: SERVICE_TOKEN, fetch: vi.fn(async () => { throw new Error("offline"); }) }).getStatuses([NIHO_A]))
      .toEqual({ ok: false, kind: "unavailable" });
  });

  it("rejects malformed requests before calling NIHO", async () => {
    const fetcher = respond(200, { statuses: [] });
    const client = createNihoAccountStatusClient({ nihoWebOrigin: ORIGIN, serviceIdToken: SERVICE_TOKEN, fetch: fetcher });
    expect(await client.getStatuses([])).toEqual({ ok: false, kind: "invalid_request" });
    expect(await client.getStatuses(["hst_" + "0".repeat(32)])).toEqual({ ok: false, kind: "invalid_request" });
    expect(await client.getStatuses([NIHO_A, NIHO_A])).toEqual({ ok: false, kind: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
