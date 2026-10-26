import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createExperienceProviderOperationsClient } from "../src/experience-provider-operations/client.ts";
import type { FetchLike } from "../src/client.ts";

const ORIGIN = "https://niho.example";
const TOKEN = "header.payload.signature";
const memberList = { members: [{ userId: "user_1", displayName: "合成 サブホスト", role: "COHOST" }] };

function respond(status: number, body: unknown): ReturnType<typeof vi.fn<FetchLike>> {
  return vi.fn<FetchLike>(async () => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("experience provider operations transport", () => {
  it("uses fixed bearer paths and does not forward cookies, redirects or referrers", async () => {
    const fetcher = respond(200, memberList);
    const api = createExperienceProviderOperationsClient({ nihoWebOrigin: ORIGIN, idToken: TOKEN, fetch: fetcher });
    expect(await api.listMembers("provider_1")).toEqual({ ok: true, data: memberList });
    expect(fetcher).toHaveBeenCalledWith("https://niho.example/api/experience-providers/provider_1/members", expect.objectContaining({
      method: "GET", credentials: "omit", redirect: "manual", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { accept: "application/json", authorization: `Bearer ${TOKEN}` },
    }));
  });

  it("sends exact-email lookup and COHOST-only membership bodies", async () => {
    const fetcher = respond(200, { candidate: { userId: "user_2", displayName: "合成 二人目" } });
    const api = createExperienceProviderOperationsClient({ nihoWebOrigin: ORIGIN, idToken: TOKEN, fetch: fetcher });
    expect(await api.resolveMember("provider_1", { email: "cohost@example.test" })).toMatchObject({ ok: true });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ email: "cohost@example.test" });

    expect(await api.putCohost("provider_1", "user_2", { role: "EDITOR" } as never)).toEqual({ ok: false, kind: "invalid_request" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid ids, cursors, queries and unknown request fields before fetch", async () => {
    const fetcher = respond(200, memberList);
    const api = createExperienceProviderOperationsClient({ nihoWebOrigin: ORIGIN, idToken: TOKEN, fetch: fetcher });
    expect(await api.listMembers("../private")).toEqual({ ok: false, kind: "invalid_request" });
    expect(await api.getBooking("provider_1", "a/b")).toEqual({ ok: false, kind: "invalid_request" });
    expect(await api.listBookings("provider_1", { cursor: "x\nprivate" })).toEqual({ ok: false, kind: "invalid_request" });
    expect(await api.listBookings("provider_1", { fromDate: "tomorrow" })).toEqual({ ok: false, kind: "invalid_request" });
    expect(await api.messageGuest("provider_1", "page_1", "booking_1", { subject: "確認", body: "本文", private: true } as never)).toEqual({ ok: false, kind: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed and foreign success responses instead of accepting partial data", async () => {
    for (const body of [{ members: [{ userId: "u", displayName: "x", role: "ADMIN" }] }, { ...memberList, stripeAccountId: "acct_hidden" }, { members: [] }, "not-json"]) {
      const fetcher = body === "not-json" ? vi.fn<FetchLike>(async () => new Response("not-json", { status: 200 })) : respond(200, body);
      const result = await createExperienceProviderOperationsClient({ nihoWebOrigin: ORIGIN, idToken: TOKEN, fetch: fetcher }).listMembers("provider_1");
      if (body === "not-json" || body !== "not-json" && (body as { members?: unknown[] }).members?.length) {
        expect(result).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
      } else {
        expect(result).toEqual({ ok: true, data: { members: [] } });
      }
    }
  });

  it.each([
    [401, { ok: false, kind: "rejected", status: 401 }],
    [404, { ok: false, kind: "not_found" }],
    [409, { ok: false, kind: "conflict" }],
  ] as const)("maps %i without exposing upstream error bodies", async (status, expected) => {
    const api = createExperienceProviderOperationsClient({ nihoWebOrigin: ORIGIN, idToken: TOKEN, fetch: respond(status, { stripeRefundId: "hidden", message: "private" }) });
    expect(await api.listMembers("provider_1")).toEqual(expected);
  });

  it("treats timeouts and uncertain sends as network errors and never retries", async () => {
    const fetcher = vi.fn<FetchLike>(async () => { throw new DOMException("timed out", "TimeoutError"); });
    const api = createExperienceProviderOperationsClient({ nihoWebOrigin: ORIGIN, idToken: TOKEN, fetch: fetcher, timeoutMs: 1 });
    expect(await api.approveBooking("provider_1", "page_1", "booking_1")).toEqual({ ok: false, kind: "network_error" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
