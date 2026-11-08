import { describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/public/guides/app-cards", () => {
  it("keeps the empty NIHO response shape for legacy cursors without network access", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      for (const query of ["", "?cursor=old-editor-cursor"]) {
        const response = GET(new Request(`https://experience.example.invalid/api/public/guides/app-cards${query}`));
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("x-robots-tag")).toBe("noindex");
        expect(await response.json()).toEqual({ version: 1, items: [], nextCursor: null });
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
