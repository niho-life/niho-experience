import { describe, expect, it, vi } from "vitest";
import { HOST_REFRESH_LOCK, hostFetch, hostSignedOutPath, refreshHostSession, type HostClientDeps } from "./client-session";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A Web Locks stand-in that runs callbacks one at a time, like the browser does across tabs. */
function fakeLocks() {
  const names: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const request = ((name: string, callback: () => Promise<unknown>) => {
    names.push(name);
    const run = queue.then(callback);
    queue = run.catch(() => undefined);
    return run;
  }) as unknown as LockManager["request"];
  return { locks: { request }, names };
}

function setup(responses: Record<string, Array<() => Response>>) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const next = responses[url]?.shift();
    if (!next) throw new Error(`unexpected ${url}`);
    return next();
  });
  const { locks, names } = fakeLocks();
  const onSignedOut = vi.fn();
  const deps: HostClientDeps = { fetch: fetchMock as unknown as typeof fetch, locks, onSignedOut };
  return { deps, calls, names, onSignedOut };
}

describe("refreshHostSession", () => {
  it("runs under the shared lock and sends one request for concurrent callers in a tab", async () => {
    const { deps, calls, names } = setup({ "/host/auth/refresh": [() => json(200, { refreshed: true, idTokenExpiresAt: 123 })] });
    const [a, b] = await Promise.all([refreshHostSession(deps), refreshHostSession(deps)]);
    expect(a).toEqual({ status: "ok", idTokenExpiresAt: 123 });
    expect(b).toBe(a);
    expect(calls).toEqual(["/host/auth/refresh"]);
    expect(names).toEqual([HOST_REFRESH_LOCK]);
  });

  it("reports a signed-out session and outages", async () => {
    const { deps } = setup({ "/host/auth/refresh": [() => json(401, { error: "session_expired" }), () => json(503, { error: "niho_unavailable" })] });
    expect(await refreshHostSession(deps)).toEqual({ status: "signed-out" });
    expect(await refreshHostSession(deps)).toEqual({ status: "failed" });
  });

  it("says when it runs inside the installed app, and only then (#177)", async () => {
    const sent: Headers[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      sent.push(new Headers(init.headers));
      return json(200, { refreshed: false, idTokenExpiresAt: 5 });
    });
    const deps: HostClientDeps = { fetch: fetchMock as unknown as typeof fetch, locks: undefined, onSignedOut: vi.fn() };
    await refreshHostSession({ ...deps, standalone: true });
    await refreshHostSession(deps);
    expect(sent.map((headers) => headers.get("x-niho-host-display"))).toEqual(["standalone", null]);
  });

  it("tells a copied browser session in the app apart from an ended one", async () => {
    const { deps } = setup({ "/host/auth/refresh": [() => json(401, { error: "app_sign_in_required" })] });
    expect(await refreshHostSession({ ...deps, standalone: true })).toEqual({ status: "app-sign-in" });
  });

  it("still serialises in browsers without Web Locks", async () => {
    const { deps, calls } = setup({ "/host/auth/refresh": [() => json(200, { refreshed: false, idTokenExpiresAt: 9 })] });
    const result = await Promise.all([refreshHostSession({ ...deps, locks: undefined }), refreshHostSession({ ...deps, locks: undefined })]);
    expect(result[0]).toEqual({ status: "ok", idTokenExpiresAt: 9 });
    expect(calls).toHaveLength(1);
  });
});

describe("hostFetch", () => {
  it("refreshes through the lock and retries once when the relay asks", async () => {
    const { deps, calls } = setup({
      "/host/api/experience-providers": [() => json(401, { error: "session_refresh_required" }), () => json(200, { providers: [] })],
      "/host/auth/refresh": [() => json(200, { refreshed: true, idTokenExpiresAt: 1 })],
    });
    const response = await hostFetch("experience-providers", {}, deps);
    expect(response.status).toBe(200);
    expect(calls).toEqual(["/host/api/experience-providers", "/host/auth/refresh", "/host/api/experience-providers"]);
  });

  it("does not retry other errors", async () => {
    const { deps, calls } = setup({ "/host/api/experience-providers/p1": [() => json(401, { error: "unauthenticated" })] });
    expect((await hostFetch("/experience-providers/p1", {}, deps)).status).toBe(401);
    expect(calls).toEqual(["/host/api/experience-providers/p1"]);
  });

  it("sends the host back to /host when the connection has ended", async () => {
    const { deps, calls, onSignedOut } = setup({
      "/host/api/auth/me": [() => json(401, { error: "session_refresh_required" })],
      "/host/auth/refresh": [() => json(401, { error: "session_expired" })],
    });
    expect((await hostFetch("auth/me", {}, deps)).status).toBe(401);
    expect(onSignedOut).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(2);
  });

  it("leaves the console when the app has to sign in on its own", async () => {
    const { deps, onSignedOut } = setup({
      "/host/api/auth/me": [() => json(401, { error: "session_refresh_required" })],
      "/host/auth/refresh": [() => json(401, { error: "app_sign_in_required" })],
    });
    expect((await hostFetch("auth/me", {}, { ...deps, standalone: true })).status).toBe(401);
    expect(onSignedOut).toHaveBeenCalledOnce();
  });

  it("returns the first answer when the refresh fails", async () => {
    const { deps, calls } = setup({
      "/host/api/auth/me": [() => json(401, { error: "session_refresh_required" })],
      "/host/auth/refresh": [() => json(503, { error: "niho_unavailable" })],
    });
    expect((await hostFetch("auth/me", {}, deps)).status).toBe(401);
    expect(calls).toHaveLength(2);
  });
});

describe("hostSignedOutPath", () => {
  it("keeps the installed app inside its own pages and browsers on the introduction", () => {
    expect(hostSignedOutPath(true)).toBe("/host/launch");
    expect(hostSignedOutPath(false)).toBe("/host");
  });
});
