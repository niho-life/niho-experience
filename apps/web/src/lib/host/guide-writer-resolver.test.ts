import { describe, expect, it, vi } from "vitest";
import type { HostSession } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { nihoWebOrigin: "https://niho.example.test" } }));
vi.mock("./server", () => ({ nihoApiFetch: () => fetch }));

import { resolveGuideWriter } from "./guide-writer-resolver";

const session = { idToken: "secret-token" } as HostSession;
const json = (body: unknown, status = 200, headers?: HeadersInit) => Response.json(body, { status, headers });

describe("NIHO guide writer resolver", () => {
  it("uses the server-held bearer and validates the exact response shape", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://niho.example.test/api/experience-guide-writers/resolve");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ authorization: "Bearer secret-token" });
      expect(init?.headers).toMatchObject({ "x-niho-experience-service-id-token": "service-token" });
      expect(init?.body).toBe(JSON.stringify({ email: "writer@example.test" }));
      expect(init?.cache).toBe("no-store");
      return json({ writerNihoUserId: "writer-1" });
    });
    expect(await resolveGuideWriter(session, { email: "writer@example.test" }, fetchImpl as typeof fetch, async () => "service-token")).toEqual({ status: "ok", writerNihoUserId: "writer-1" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(await resolveGuideWriter(session, { nihoUserId: "writer-1" }, vi.fn(async () => json({ writerNihoUserId: "writer-1", email: "private@example.test" })) as typeof fetch, async () => "service-token")).toEqual({ status: "unavailable" });
  });

  it("maps confirmed account absence, authentication, throttling and dependency failure", async () => {
    expect(await resolveGuideWriter(session, { nihoUserId: "writer-1" }, vi.fn(async () => json({}, 404, { "x-niho-guide-writer-resolver": "v1" })) as typeof fetch, async () => "service-token")).toEqual({ status: "not_found" });
    expect(await resolveGuideWriter(session, { nihoUserId: "writer-1" }, vi.fn(async () => json({}, 404)) as typeof fetch, async () => "service-token")).toEqual({ status: "unavailable" });
    expect(await resolveGuideWriter(session, { nihoUserId: "writer-1" }, vi.fn(async () => json({}, 401)) as typeof fetch, async () => "service-token")).toEqual({ status: "unavailable" });
    expect(await resolveGuideWriter(session, { nihoUserId: "writer-1" }, vi.fn(async () => json({}, 429, { "retry-after": "60" })) as typeof fetch, async () => "service-token")).toEqual({ status: "rate_limited", retryAfterSeconds: 60 });
    expect(await resolveGuideWriter(session, { nihoUserId: "writer-1" }, vi.fn(async () => { throw new Error("offline"); }) as typeof fetch, async () => "service-token")).toEqual({ status: "unavailable" });
    expect(await resolveGuideWriter(session, { nihoUserId: "writer-1" }, vi.fn(async () => new Response("not json", { status: 200 })) as typeof fetch, async () => "service-token")).toEqual({ status: "unavailable" });
    const fetchImpl = vi.fn();
    expect(await resolveGuideWriter(session, { nihoUserId: "writer-1" }, fetchImpl as typeof fetch, async () => { throw new Error("no service identity"); })).toEqual({ status: "unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
