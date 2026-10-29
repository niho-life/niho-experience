import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  createExperienceEditorAuthClient,
  experienceEditorConnectUrl,
  EXPERIENCE_EDITOR_CLIENT_ID,
} from "../src/editor-auth/index.ts";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Experience editor auth client", () => {
  it("uses the dedicated confirmation path and client ID", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(200, {
      customToken: "custom-token",
      refreshToken: "refresh-token",
      connectionId: "connection-1",
      connectionExpiresAt: "2026-10-30T08:00:00.000Z",
    }));
    const url = new URL(experienceEditorConnectUrl("https://niho.example", {
      challenge: "c".repeat(43),
      state: "s".repeat(43),
    }));
    expect(url.origin + url.pathname).toBe("https://niho.example/connect/niho-experience-editor");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      v: "1",
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
      state: "s".repeat(43),
    });

    const client = createExperienceEditorAuthClient({ nihoWebOrigin: "https://niho.example", fetch: fetchMock as typeof fetch });
    await expect(client.exchangeCode({ code: "x".repeat(43), codeVerifier: "v".repeat(43) })).resolves.toMatchObject({ ok: true });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe("/api/auth/experience-editor-connect/exchange");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      clientId: EXPERIENCE_EDITOR_CLIENT_ID,
      code: "x".repeat(43),
      codeVerifier: "v".repeat(43),
    });
  });

  it("selects only actor, connection and current account activity", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(200, {
      actor: { id: "actor-1", email: "must-not-leak@example.test" },
      connection: { id: "connection-1", expiresAt: "2026-10-30T08:00:00.000Z", refreshToken: "must-not-leak" },
      account: { active: true, internalState: "must-not-leak" },
    }));
    const client = createExperienceEditorAuthClient({ nihoWebOrigin: "https://niho.example", fetch: fetchMock as typeof fetch });
    await expect(client.verifySession("id-token")).resolves.toEqual({
      ok: true,
      data: {
        actor: { id: "actor-1" },
        connection: { id: "connection-1", expiresAt: Date.parse("2026-10-30T08:00:00.000Z") },
        account: { active: true },
      },
    });
    expect(new Headers(fetchMock.mock.calls[0]![1]!.headers).get("authorization")).toBe("Bearer id-token");
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe("/api/auth/experience-editor-connect/session");
  });

  it("revokes with the editor refresh token, even when the ID token has expired", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    const client = createExperienceEditorAuthClient({ nihoWebOrigin: "https://niho.example", fetch: fetchMock as typeof fetch });
    await expect(client.revokeConnection("refresh-token")).resolves.toBe(true);
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe("/api/auth/experience-editor-connect/revoke");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ clientId: EXPERIENCE_EDITOR_CLIENT_ID, refreshToken: "refresh-token" });
  });

  it("classifies rejected, unavailable and malformed responses without exposing bodies", async () => {
    const responses = [json(403, {}), json(503, {}), json(200, { actor: {}, connection: {}, account: {} })];
    const client = createExperienceEditorAuthClient({
      nihoWebOrigin: "https://niho.example",
      fetch: vi.fn(async () => responses.shift()!) as unknown as typeof fetch,
    });
    await expect(client.verifySession("token")).resolves.toEqual({ ok: false, kind: "rejected" });
    await expect(client.verifySession("token")).resolves.toEqual({ ok: false, kind: "unavailable" });
    await expect(client.verifySession("token")).resolves.toEqual({ ok: false, kind: "unavailable" });
  });
});
