import { describe, expect, it, vi } from "vitest";
import { editorApiRequest, EditorApiError } from "./guide-editor-api";

describe("editorApiRequest", () => {
  it("refreshes once for refresh_required and retries", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "refresh_required" }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ guides: [] }), { status: 200 }));
    const refresh = vi.fn().mockResolvedValue({ status: "ok", idTokenExpiresAt: Date.now() + 60_000 });
    await expect(editorApiRequest("/editor/api/guides", {}, { fetch: fetchMock, refresh })).resolves.toEqual({ guides: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not retry a revision conflict", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "conflict" }), { status: 409 }));
    await expect(editorApiRequest("/editor/api/guides/a", {}, {
      fetch: fetchMock,
      refresh: vi.fn(),
    })).rejects.toMatchObject({ kind: "conflict", status: 409 } satisfies Partial<EditorApiError>);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps network failures without losing caller state", async () => {
    await expect(editorApiRequest("/editor/api/guides", {}, {
      fetch: vi.fn().mockRejectedValue(new Error("offline")),
      refresh: vi.fn(),
    })).rejects.toMatchObject({ kind: "unavailable" } satisfies Partial<EditorApiError>);
  });
});
