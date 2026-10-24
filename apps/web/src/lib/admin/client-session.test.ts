import { describe, expect, it, vi } from "vitest";
import { ADMIN_REFRESH_LOCK, refreshAdminSession, type AdminClientDeps } from "./client-session";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function deps(responses: Array<Response | Error>) {
  const calls: string[] = [];
  const locks: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const response = responses.shift()!;
    if (response instanceof Error) throw response;
    return response;
  });
  const request = (async (name: string, callback: () => Promise<unknown>) => {
    locks.push(name);
    return callback();
  }) as unknown as LockManager["request"];
  const onSignedOut = vi.fn();
  return { value: { fetch: fetchMock as unknown as typeof fetch, locks: { request }, onSignedOut } satisfies AdminClientDeps, calls, locks };
}

describe("Admin browser refresh", () => {
  it("serializes concurrent refreshes without exposing tokens", async () => {
    const setup = deps([json(200, { refreshed: true, idTokenExpiresAt: 123 })]);
    const [first, second] = await Promise.all([refreshAdminSession(setup.value), refreshAdminSession(setup.value)]);
    expect(first).toEqual({ status: "ok", idTokenExpiresAt: 123 });
    expect(second).toBe(first);
    expect(setup.calls).toEqual(["/admin/auth/refresh"]);
    expect(setup.locks).toEqual([ADMIN_REFRESH_LOCK]);
    expect(Object.keys(first)).toEqual(["status", "idTokenExpiresAt"]);
  });

  it("separates an ended session from HTTP and network failures", async () => {
    const setup = deps([json(401, { error: "session_expired" }), json(503, { error: "niho_unavailable" }), new Error("offline")]);
    expect(await refreshAdminSession(setup.value)).toEqual({ status: "signed-out" });
    expect(await refreshAdminSession(setup.value)).toEqual({ status: "failed" });
    expect(await refreshAdminSession(setup.value)).toEqual({ status: "failed" });
  });
});
