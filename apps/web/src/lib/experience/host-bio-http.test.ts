import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreConflictError, StoreValidationError } from "@niho-experience/experience-store";

const mocks = vi.hoisted(() => ({
  boundary: vi.fn(),
  mutationAllowed: vi.fn(),
  repository: { getForOwner: vi.fn(), save: vi.fn(), withdraw: vi.fn() },
  translator: vi.fn() as ReturnType<typeof vi.fn> | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/host/server", () => ({
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } }),
}));
vi.mock("./publication-host-boundary", () => ({
  publicationHostBoundary: mocks.boundary,
  publicationHostMutationAllowed: mocks.mutationAllowed,
}));
vi.mock("./store-server", () => ({ providerHostBioRepository: () => mocks.repository }));
vi.mock("@/lib/translation/anthropic", () => ({ anthropicTranslator: () => mocks.translator }));

import { deleteHostBio, getHostBio, putHostBio, translateHostBio } from "./host-bio-http";

const actor = { providerId: "provider-private", nihoUserId: "user-private" };
const CONSENT = "host-bio-consent-v1";
const state = { version: 1, bioJa: "鎌倉で茶道を教えています。", bioEn: null, englishConfirmed: false, consentVersion: CONSENT, updatedAtUtc: "2026-11-06T00:00:00.000Z" };
const empty = { version: 0, bioJa: null, bioEn: null, englishConfirmed: false, consentVersion: null, updatedAtUtc: null };

function request(method: string, body?: unknown, path = "/host/api/host-bio", raw?: string) {
  return new Request(`https://experience.example.test${path}`, {
    method,
    headers: body === undefined && raw === undefined ? undefined : { "content-type": "application/json", origin: "https://experience.example.test", "sec-fetch-site": "same-origin" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}
const put = (body: unknown) => putHostBio(request("PUT", body));
const validPut = { bioJa: "鎌倉で茶道を教えています。", bioEn: null, expectedVersion: null, consentVersion: CONSENT };

describe("host bio HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.boundary.mockResolvedValue({ ok: true, value: { actor } });
    mocks.mutationAllowed.mockReturnValue(true);
    mocks.repository.getForOwner.mockResolvedValue(empty);
    mocks.repository.save.mockResolvedValue(state);
    mocks.repository.withdraw.mockResolvedValue(empty);
    mocks.translator = vi.fn();
  });

  it("returns the owner state with private no-store headers and no internal identifiers", async () => {
    const response = await getHostBio(request("GET"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toEqual({ hostBio: empty, consentVersion: CONSENT });
    expect(JSON.stringify(body)).not.toMatch(/provider-private|user-private/);
    expect(mocks.repository.getForOwner).toHaveBeenCalledWith(actor);
    expect((await getHostBio(request("GET", undefined, "/host/api/host-bio?bio=x"))).status).toBe(400);
  });

  it("passes the boundary's 401/403 through without touching the Store", async () => {
    for (const status of [401, 403]) {
      mocks.boundary.mockResolvedValueOnce({ ok: false, response: Response.json({ error: { code: "X" } }, { status }) });
      expect((await getHostBio(request("GET"))).status).toBe(status);
      mocks.boundary.mockResolvedValueOnce({ ok: false, response: Response.json({ error: { code: "X" } }, { status }) });
      expect((await put(validPut)).status).toBe(status);
    }
    expect(mocks.repository.getForOwner).not.toHaveBeenCalled();
    expect(mocks.repository.save).not.toHaveBeenCalled();
  });

  it("saves one exact command and never accepts a client fingerprint or extra keys", async () => {
    const response = await put({ ...validPut, bioEn: "I teach tea ceremony.", expectedVersion: 3 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hostBio: state });
    expect(mocks.repository.save).toHaveBeenCalledWith(actor, { bioJa: validPut.bioJa, bioEn: "I teach tea ceremony.", expectedVersion: 3, consentVersion: CONSENT });

    for (const body of [
      { ...validPut, englishSourceFingerprint: "0".repeat(64) },
      { ...validPut, providerId: "provider-private" },
      { bioJa: validPut.bioJa, bioEn: null, consentVersion: CONSENT },
      { ...validPut, bioJa: 1 },
      { ...validPut, bioEn: 1 },
      { ...validPut, expectedVersion: 0 },
      { ...validPut, expectedVersion: "1" },
      { ...validPut, consentVersion: "host-bio-consent-v0" },
      [validPut],
    ]) expect((await put(body)).status).toBe(400);
    expect((await putHostBio(request("PUT", undefined, "/host/api/host-bio", "{not json"))).status).toBe(400);
    const textPlain = new Request("https://experience.example.test/host/api/host-bio", { method: "PUT", headers: { "content-type": "text/plain" }, body: JSON.stringify(validPut) });
    expect((await putHostBio(textPlain)).status).toBe(400);
    expect((await put({ ...validPut, bioJa: "あ".repeat(20_000) })).status).toBe(413);
    expect(mocks.repository.save).toHaveBeenCalledTimes(1);
  });

  it("requires same-origin writes", async () => {
    mocks.mutationAllowed.mockReturnValue(false);
    expect((await put(validPut)).status).toBe(403);
    expect((await deleteHostBio(request("DELETE", { expectedVersion: 1 }))).status).toBe(403);
    expect((await translateHostBio(request("POST", { bioJa: "紹介" }, "/host/api/host-bio/translation"))).status).toBe(403);
    expect(mocks.boundary).not.toHaveBeenCalled();
  });

  it("maps Store errors: conflict 409, invalid 422, denied 403, other 503", async () => {
    for (const [caught, status, code] of [
      [new StoreConflictError("changed"), 409, "VERSION_CONFLICT"],
      [new StoreValidationError("bad"), 422, "INVALID_INPUT"],
      [new StoreAccessDeniedError(), 403, "FORBIDDEN"],
      [new Error("db down"), 503, "UNAVAILABLE"],
    ] as const) {
      mocks.repository.save.mockRejectedValueOnce(caught);
      const response = await put(validPut);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: { code } });
    }
  });

  it("withdraws with an exact positive expectedVersion", async () => {
    expect((await deleteHostBio(request("DELETE", { expectedVersion: 2 }))).status).toBe(200);
    expect(mocks.repository.withdraw).toHaveBeenCalledWith(actor, 2);
    expect((await deleteHostBio(request("DELETE", { expectedVersion: 0 }))).status).toBe(400);
    expect((await deleteHostBio(request("DELETE", { expectedVersion: 2, bioJa: "x" }))).status).toBe(400);
    mocks.repository.withdraw.mockRejectedValueOnce(new StoreConflictError("changed"));
    expect((await deleteHostBio(request("DELETE", { expectedVersion: 2 }))).status).toBe(409);
  });
});

describe("host bio translation", () => {
  const translate = (body: unknown) => translateHostBio(request("POST", body, "/host/api/host-bio/translation"));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.boundary.mockResolvedValue({ ok: true, value: { actor } });
    mocks.mutationAllowed.mockReturnValue(true);
    mocks.repository.getForOwner.mockResolvedValue(empty);
    mocks.translator = vi.fn();
  });

  it("returns a normalized English draft after the OWNER check and saves nothing", async () => {
    mocks.translator!.mockResolvedValue({ ok: true, text: "I teach tea ceremony in Kamakura.\n\n\n\nSynthetic." });
    const response = await translate({ bioJa: " 鎌倉で茶道を教えています。\r\n\r\n合成です。 " });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ bioEn: "I teach tea ceremony in Kamakura.\n\nSynthetic." });
    expect(mocks.repository.getForOwner).toHaveBeenCalledWith(actor);
    const [prompt, options] = mocks.translator!.mock.calls[0]!;
    expect(prompt.messages[0].content).toContain("鎌倉で茶道を教えています。\n\n合成です。");
    expect(options).toEqual({ maxLength: 1500 });
    expect(mocks.repository.save).not.toHaveBeenCalled();
  });

  it("rejects invalid input before calling the model", async () => {
    for (const body of [{ bioJa: "" }, { bioJa: "  " }, { bioJa: "あ".repeat(601) }, { bioJa: "タ\tブ" }, { bioJa: "紹介", bioEn: "x" }, { japanese: "紹介" }]) {
      expect((await translate(body)).status).toBe(400);
    }
    expect(mocks.translator).not.toHaveBeenCalled();
  });

  it("does not translate for a non-OWNER", async () => {
    mocks.repository.getForOwner.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect((await translate({ bioJa: "紹介" })).status).toBe(403);
    expect(mocks.translator).not.toHaveBeenCalled();
  });

  it("reports a missing, failed, empty, controlled or over-long draft as unavailable", async () => {
    mocks.translator = null;
    expect((await translate({ bioJa: "紹介" })).status).toBe(503);
    for (const result of [
      { ok: false, failure: "refused" },
      { ok: false, failure: "unusable" },
      { ok: true, text: "   " },
      { ok: true, text: "Tab\tinside" },
      { ok: true, text: "a".repeat(1501) },
    ]) {
      mocks.translator = vi.fn().mockResolvedValue(result);
      const response = await translate({ bioJa: "紹介" });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: "TRANSLATION_UNAVAILABLE" } });
    }
  });
});
