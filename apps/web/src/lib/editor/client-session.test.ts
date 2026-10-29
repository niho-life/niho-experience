import { describe, expect, it, vi } from "vitest";
import { EDITOR_REFRESH_LOCK, refreshEditorSession } from "./client-session";

describe("editor client refresh serialization", () => {
  it("does not spend a rotating token when Web Locks are unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(refreshEditorSession({ fetch: fetchMock, locks: undefined })).resolves.toEqual({ status: "reconnect" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the editor Web Lock and coalesces same-tab calls", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/editor/auth/refresh");
      expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
      await wait;
      return new Response(JSON.stringify({ idTokenExpiresAt: 12345 }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const locks = { request: vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback()) } as unknown as Pick<LockManager, "request">;

    const first = refreshEditorSession({ fetch: fetchMock as typeof fetch, locks });
    const second = refreshEditorSession({ fetch: fetchMock as typeof fetch, locks });
    expect(first).toBe(second);
    release();
    await expect(first).resolves.toEqual({ status: "ok", idTokenExpiresAt: 12345 });
    expect(locks.request).toHaveBeenCalledWith(EDITOR_REFRESH_LOCK, expect.any(Function));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/editor/auth/refresh");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
  });
});
