import { describe, expect, it, vi } from "vitest";
import { createExperienceAdminAuthClient, experienceAdminConnectUrl, EXPERIENCE_ADMIN_CLIENT_ID } from "../src/admin-auth/index.ts";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Experience Admin auth client", () => {
  it("builds the dedicated confirmation URL and exchanges only with the Admin client id", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      json(200, {
        customToken: "custom-token",
        refreshToken: "refresh-token",
        connectionId: "connection-1",
        connectionExpiresAt: "2026-10-23T08:00:00.000Z",
        user: { id: "ignored", displayName: "ignored", handle: null, iconImage: null },
      }),
    );
    const url = new URL(experienceAdminConnectUrl("https://niho.example/", {
      challenge: "c".repeat(43),
      state: "s".repeat(43),
      redirectOrigin: "https://experience.example",
    }));
    expect(url.origin + url.pathname).toBe("https://niho.example/connect/niho-experience-admin");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      v: "1",
      challenge: "c".repeat(43),
      state: "s".repeat(43),
      origin: "https://experience.example",
    });

    const client = createExperienceAdminAuthClient({ nihoWebOrigin: "https://niho.example", fetch: fetchMock as typeof fetch });
    const result = await client.exchangeCode({ code: "x".repeat(43), codeVerifier: "v".repeat(43) });
    expect(result).toEqual({
      ok: true,
      data: {
        customToken: "custom-token",
        refreshToken: "refresh-token",
        connectionId: "connection-1",
        connectionExpiresAt: Date.parse("2026-10-23T08:00:00.000Z"),
      },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      clientId: EXPERIENCE_ADMIN_CLIENT_ID,
      code: "x".repeat(43),
      codeVerifier: "v".repeat(43),
    });
  });

  it("returns only the minimal verified actor and connection DTO", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(200, {
      actor: { id: "admin-1", displayName: "  Admin   One  ", internalRole: "ADMIN" },
      connection: { id: "connection-1", expiresAt: "2026-10-23T08:00:00.000Z", refreshToken: "must-not-leak" },
      token: "must-not-leak",
    }));
    const client = createExperienceAdminAuthClient({ nihoWebOrigin: "https://niho.example", fetch: fetchMock as typeof fetch });
    expect(await client.verifySession("id-token")).toEqual({
      ok: true,
      data: {
        actor: { id: "admin-1", displayName: "Admin One" },
        connection: { id: "connection-1", expiresAt: Date.parse("2026-10-23T08:00:00.000Z") },
      },
    });
    const sent = new Headers(fetchMock.mock.calls[0]![1]!.headers);
    expect(sent.get("authorization")).toBe("Bearer id-token");
  });

  it("classifies 401/403 as rejected and outages or malformed success as unavailable", async () => {
    const responses = [json(401, {}), json(403, {}), json(503, {}), json(200, { actor: {}, connection: {} })];
    const client = createExperienceAdminAuthClient({
      nihoWebOrigin: "https://niho.example",
      fetch: vi.fn(async () => responses.shift()!) as unknown as typeof fetch,
    });
    expect(await client.verifySession("token")).toEqual({ ok: false, kind: "rejected" });
    expect(await client.verifySession("token")).toEqual({ ok: false, kind: "rejected" });
    expect(await client.verifySession("token")).toEqual({ ok: false, kind: "unavailable" });
    expect(await client.verifySession("token")).toEqual({ ok: false, kind: "unavailable" });
  });

  it("accepts HTTPS or loopback HTTP origins only", () => {
    expect(() => experienceAdminConnectUrl("http://niho.example", { challenge: "c".repeat(43), state: "s".repeat(43), redirectOrigin: "https://experience.example" })).toThrow(/HTTPS/);
    expect(() => experienceAdminConnectUrl("https://niho.example", { challenge: "c".repeat(43), state: "s".repeat(43), redirectOrigin: "http://experience.example" })).toThrow(/HTTPS/);
    expect(experienceAdminConnectUrl("http://localhost:3001", { challenge: "c".repeat(43), state: "s".repeat(43), redirectOrigin: "http://127.0.0.1:3000" })).toContain("origin=http%3A%2F%2F127.0.0.1%3A3000");
  });

  it("confirms revocation only for 2xx or an already-missing connection", async () => {
    const responses = [new Response(null, { status: 204 }), new Response(null, { status: 404 }), new Response(null, { status: 401 }), new Response(null, { status: 503 })];
    const client = createExperienceAdminAuthClient({
      nihoWebOrigin: "https://niho.example",
      fetch: vi.fn(async () => responses.shift()!) as unknown as typeof fetch,
    });
    await expect(client.deleteConnection("connection-1", "id-token")).resolves.toBe(true);
    await expect(client.deleteConnection("connection-1", "id-token")).resolves.toBe(true);
    await expect(client.deleteConnection("connection-1", "id-token")).resolves.toBe(false);
    await expect(client.deleteConnection("connection-1", "id-token")).resolves.toBe(false);
  });
});
