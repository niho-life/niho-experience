import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), preview: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@niho-experience/api-client/experience-provider-operations-schema", () => ({
  isExperienceProviderOperationPathId: (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value),
}));
vi.mock("@/lib/host/provider-pages-server", () => ({ loadProviderPagesClient: mocks.load, providerPagesFailure: mocks.failure }));
vi.mock("@/lib/host/provider-operations-server", () => ({
  providerOperationsJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } }),
}));

import * as route from "./route";

const url = "https://experience.example/host/api/provider-pages/provider_1/page_1/preview";
const context = (providerId = "provider_1", pageId = "page_1") => ({ params: Promise.resolve({ providerId, pageId }) });

describe("provider page preview BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.preview.mockResolvedValue({ ok: true, data: { page: { slug: "sample" } } });
    mocks.load.mockResolvedValue({ ok: true, client: { getExperienceProviderPagePreview: mocks.preview } });
    mocks.failure.mockImplementation(() => Response.json({ error: "permission_ended" }, { status: 404 }));
  });

  it("is read only: GET is the only method", () => {
    expect(Object.keys(route).sort()).toEqual(["GET"]);
  });
  it("reads the validated ids and answers private no-store, no-index", async () => {
    const response = await route.GET(new Request(url), context());
    expect(response.status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledWith("provider_1", "page_1");
    expect(await response.json()).toEqual({ page: { slug: "sample" } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
  it("refuses a query string and odd ids before it calls NIHO", async () => {
    expect((await route.GET(new Request(`${url}?raw=1`), context())).status).toBe(404);
    expect((await route.GET(new Request(url), context("provider/../x"))).status).toBe(404);
    expect((await route.GET(new Request(url), context("provider_1", ""))).status).toBe(404);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("passes a session or feature refusal through, and maps a NIHO failure with the shared helper", async () => {
    const refused = Response.json({ error: "unauthenticated" }, { status: 401 });
    mocks.load.mockResolvedValueOnce({ ok: false, response: refused });
    expect(await route.GET(new Request(url), context())).toBe(refused);
    mocks.preview.mockResolvedValueOnce({ ok: false, kind: "http_error", status: 404, code: "NOT_FOUND", reason: "PAGE_NOT_FOUND" });
    const failed = await route.GET(new Request(url), context());
    expect(failed.status).toBe(404);
    expect(mocks.failure).toHaveBeenCalledOnce();
  });
});
