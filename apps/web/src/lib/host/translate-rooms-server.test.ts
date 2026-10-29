import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { hostConsoleEnabled: true, apiMode: "http" as "http" | "mock", experienceTranslateApiEnabled: false, nihoWebOrigin: "https://niho.example" },
  readHost: vi.fn(),
  usable: vi.fn(),
  create: vi.fn(),
  clear: vi.fn(),
  upstreamFetch: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("./session", () => ({ idTokenUsable: mocks.usable }));
vi.mock("./server", () => ({
  readHostSession: mocks.readHost,
  nihoApiFetch: () => mocks.upstreamFetch,
  siteOrigin: () => "https://experience.example",
  clearSessionCookie: mocks.clear,
}));
vi.mock("@niho-experience/api-client/experience-translate-rooms", () => ({ createExperienceTranslateRoomsClient: mocks.create }));

import { loadTranslateRoomsClient, readEmptyTranslateBody, translateRoomsEnabled, translateRoomsEntry, translateRoomsFailure, translateRoomsMutationAllowed } from "./translate-rooms-server";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request("https://experience.example/host/api/translate/x", { method: "POST", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", ...headers }, body });

describe("translate rooms server boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.config, { hostConsoleEnabled: true, apiMode: "http", experienceTranslateApiEnabled: false });
    mocks.usable.mockReturnValue(true);
    mocks.create.mockReturnValue({ marker: "translate-client" });
  });

  it("is open in mock mode, and in http only behind its own flag with the host console", () => {
    expect(translateRoomsEnabled()).toBe(false);
    mocks.config.experienceTranslateApiEnabled = true;
    expect(translateRoomsEnabled()).toBe(true);
    mocks.config.hostConsoleEnabled = false;
    expect(translateRoomsEnabled()).toBe(false);
    Object.assign(mocks.config, { hostConsoleEnabled: true, apiMode: "mock", experienceTranslateApiEnabled: false });
    expect(translateRoomsEnabled()).toBe(true);
    expect(translateRoomsEntry()).toEqual({ today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    mocks.config.hostConsoleEnabled = false;
    expect(translateRoomsEntry()).toBeNull();
  });

  it("uses only the sealed current host session and NIHO's fetch for that session", async () => {
    mocks.config.experienceTranslateApiEnabled = true;
    mocks.readHost.mockResolvedValue({ idToken: "sealed-host-token" });
    const loaded = await loadTranslateRoomsClient();
    expect(loaded).toEqual({ ok: true, client: { marker: "translate-client" } });
    expect(mocks.create).toHaveBeenCalledWith({ nihoWebOrigin: "https://niho.example", idToken: "sealed-host-token", fetch: mocks.upstreamFetch });
  });

  it("answers 404 while closed, 401 without a session and 401 refresh when the token is nearly out", async () => {
    expect((await loadTranslateRoomsClient()).ok).toBe(false);
    expect((await loadTranslateRoomsClient() as { response: Response }).response.status).toBe(404);
    mocks.config.experienceTranslateApiEnabled = true;
    mocks.readHost.mockResolvedValue(null);
    expect((await loadTranslateRoomsClient() as { response: Response }).response.status).toBe(401);
    mocks.readHost.mockResolvedValue({ idToken: "sealed-host-token" });
    mocks.usable.mockReturnValue(false);
    const refresh = (await loadTranslateRoomsClient() as { response: Response }).response;
    expect(refresh.status).toBe(401);
    expect(await refresh.json()).toEqual({ error: "session_refresh_required" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("maps NIHO's refusals without their bodies, clears the cookie on 401 and keeps 404 as not_found", async () => {
    const ended = translateRoomsFailure({ ok: false, kind: "rejected", status: 401 });
    expect(ended.status).toBe(401);
    expect(await ended.json()).toEqual({ error: "session_ended" });
    expect(mocks.clear).toHaveBeenCalledWith(ended);
    expect(await translateRoomsFailure({ ok: false, kind: "rejected", status: 403 }).json()).toEqual({ error: "permission_ended" });
    const missing = translateRoomsFailure({ ok: false, kind: "not_found" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect(translateRoomsFailure({ ok: false, kind: "conflict" }).status).toBe(409);
    expect(translateRoomsFailure({ ok: false, kind: "invalid_request" }).status).toBe(400);
    expect(translateRoomsFailure({ ok: false, kind: "network_error" }).status).toBe(502);
    expect(translateRoomsFailure({ ok: false, kind: "unexpected_response", status: 500 }).status).toBe(502);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
    expect(missing.headers.get("referrer-policy")).toBe("no-referrer");
    expect(missing.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("requires a same-origin mutation and an empty body", async () => {
    expect(translateRoomsMutationAllowed(post(null))).toBe(true);
    expect(translateRoomsMutationAllowed(post(null, { origin: "https://evil.example" }))).toBe(false);
    expect(translateRoomsMutationAllowed(new Request("https://experience.example/host/api/translate/x"))).toBe(true);
    expect(await readEmptyTranslateBody(post(null))).toBe(true);
    expect(await readEmptyTranslateBody(post("{}", { "content-type": "application/json" }))).toBe(true);
    expect(await readEmptyTranslateBody(post(JSON.stringify({ language: "fr" }), { "content-type": "application/json" }))).toBe(false);
    expect(await readEmptyTranslateBody(post("[]", { "content-type": "application/json" }))).toBe(false);
    expect(await readEmptyTranslateBody(post("not json", { "content-type": "application/json" }))).toBe(false);
    expect(await readEmptyTranslateBody(post("x".repeat(2048), { "content-type": "application/json" }))).toBe(false);
  });
});
