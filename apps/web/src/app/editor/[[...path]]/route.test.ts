import { describe, expect, it } from "vitest";
import { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } from "./route";

const SITE = "https://experience.example.invalid";
const call = (handler: typeof GET, method: string, path: readonly string[], init: RequestInit = {}) =>
  handler(new Request(`${SITE}/editor/${path.join("/")}`, { method, ...init }), { params: Promise.resolve({ path }) });

describe("the retired /editor", () => {
  it("answers 410 for every method of the old API and OAuth endpoints, without reading a body", async () => {
    const paths = [["api", "guides"], ["api", "guides", "00000000-0000-4000-8000-000000000042", "publication"], ["api", "guide-link-invitations"], ["auth", "login"], ["auth", "callback"], ["auth", "logout"], ["auth", "refresh"], ["auth", "error"]];
    const handlers: [string, typeof GET][] = [["GET", GET], ["HEAD", HEAD], ["POST", POST], ["PUT", PUT], ["PATCH", PATCH], ["DELETE", DELETE], ["OPTIONS", OPTIONS]];
    for (const path of paths) {
      for (const [method, handler] of handlers) {
        const body = method === "GET" || method === "HEAD" || method === "OPTIONS" ? undefined : JSON.stringify({ title: "private body" });
        const response = await call(handler, method, path, body === undefined ? {} : { body, headers: { "content-type": "application/json" } });
        expect(response.status, `${method} ${path.join("/")}`).toBe(410);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.json()).toEqual({ error: "gone" });
      }
    }
  });

  it("does not consume the request body of an old write", async () => {
    const request = new Request(`${SITE}/editor/api/guides`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "private body" }) });
    await POST(request, { params: Promise.resolve({ path: ["api", "guides"] }) });
    expect(request.bodyUsed).toBe(false);
  });

  it("sends every old page to /write, with noindex", async () => {
    for (const path of [[], ["guides"], ["guides", "new"], ["guides", "00000000-0000-4000-8000-000000000042"], ["guides", "00000000-0000-4000-8000-000000000042", "preview"]]) {
      for (const [method, handler] of [["GET", GET], ["HEAD", HEAD]] as const) {
        const response = await call(handler, method, path);
        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe("/write");
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      }
    }
  });

  it("answers 410, not a redirect, to a write on an old page path", async () => {
    const response = await call(POST, "POST", ["guides"], { body: "x" });
    expect(response.status).toBe(410);
  });
});
