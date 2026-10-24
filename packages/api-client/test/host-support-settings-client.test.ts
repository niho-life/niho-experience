import { describe, expect, it, vi } from "vitest";
import { createExperienceHostSupportSettingsApiClient } from "../src/host-support-settings/client.ts";
import {
  decodeExperienceHostSupportSettingsHostListResponse,
  decodeExperienceHostSupportSettingsPutRequest,
  decodeExperienceHostSupportSettingsStateResponse,
  isExperienceHostSupportSettingsPathId,
} from "../src/host-support-settings/schema.ts";

const spot = { kind: "SPOT" as const, id: "鎌倉-😀", displayName: "通常拠点" };
const provider = { kind: "EXPERIENCE_PROVIDER" as const, id: "provider-1", displayName: "外部提供者" };
const policy = { policyVersion: "2026-10-23" as const, consentVersion: "2026-10-23" as const, offTotalRateBps: 1000 as const, onTotalRateBps: 1500 as const, peopleCostPaidDirectlyByHost: true as const, processingFeesIncluded: true as const };
const setting = { enabled: true, policyVersion: "2026-10-23", consentVersion: "2026-10-23", consentedAt: "2026-10-23T01:00:00.000Z", agreementRevision: 2, sharedConsultationMemo: "合成の相談メモ", revision: 3, updatedAt: "2026-10-23T01:00:00.000Z" };
const state = { host: spot, setting, settingState: "CURRENT" as const, policy, writeCapability: { writable: true as const, reason: null } };
const list = { hosts: [spot, provider], limit: 100 as const, truncated: false };
const command = { enabled: false, consentVersion: "2026-10-23" as const, expectedRevision: 3 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

describe("Host support settings strict SDK", () => {
  it("accepts only exact selected DTOs and rejects private/PII extras", () => {
    expect(decodeExperienceHostSupportSettingsHostListResponse(list)).toEqual(list);
    expect(decodeExperienceHostSupportSettingsStateResponse(state)).toEqual(state);
    expect(decodeExperienceHostSupportSettingsPutRequest(command)).toEqual(command);
    expect(decodeExperienceHostSupportSettingsHostListResponse({ ...list, consentedByUserId: "private" })).toBeNull();
    expect(decodeExperienceHostSupportSettingsHostListResponse({ ...list, hosts: [{ ...spot, email: "guest@example.test" }] })).toBeNull();
    expect(decodeExperienceHostSupportSettingsStateResponse({ ...state, setting: { ...setting, internalMemo: "private" } })).toBeNull();
    expect(decodeExperienceHostSupportSettingsStateResponse({ ...state, host: { ...spot, phone: "000" } })).toBeNull();
    expect(decodeExperienceHostSupportSettingsPutRequest({ ...command, policyVersion: "2026-10-23" })).toBeNull();
  });

  it("keeps UNSET distinct and requires CURRENT to match the current policy", () => {
    expect(decodeExperienceHostSupportSettingsStateResponse({ ...state, setting: null, settingState: "UNSET" })).not.toBeNull();
    expect(decodeExperienceHostSupportSettingsStateResponse({ ...state, setting: null, settingState: "CURRENT" })).toBeNull();
    expect(decodeExperienceHostSupportSettingsStateResponse({ ...state, setting: { ...setting, consentVersion: "old" }, settingState: "CURRENT" })).toBeNull();
    expect(decodeExperienceHostSupportSettingsStateResponse({ ...state, setting: { ...setting, consentVersion: "old" }, settingState: "RECONSENT_REQUIRED" })).not.toBeNull();
  });

  it("counts Unicode path IDs by code point and rejects path boundaries", () => {
    expect(isExperienceHostSupportSettingsPathId("😀".repeat(200))).toBe(true);
    expect(isExperienceHostSupportSettingsPathId("😀".repeat(201))).toBe(false);
    for (const invalid of ["", ".", "..", "a/b", "a\\b", "a%2fb", "a?b", "a#b", "a\uFFFDb", "a\0b"]) expect(isExperienceHostSupportSettingsPathId(invalid)).toBe(false);
  });

  it("uses only fixed paths, Bearer, no-store and manual redirect for both host kinds", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => url.endsWith("niho-support-hosts") ? json(list) : json(url.includes("SPOT") ? state : { ...state, host: provider }));
    const client = createExperienceHostSupportSettingsApiClient({ nihoWebOrigin: "https://niho.example", idToken: "host-token", fetch: fetcher });
    expect((await client.list()).ok).toBe(true);
    expect((await client.get("SPOT", spot.id)).ok).toBe(true);
    expect((await client.get("EXPERIENCE_PROVIDER", provider.id)).ok).toBe(true);
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://niho.example/api/experience-providers/management/niho-support/SPOT/%E9%8E%8C%E5%80%89-%F0%9F%98%80");
    expect(fetcher.mock.calls[2]?.[0]).toBe("https://niho.example/api/experience-providers/management/niho-support/EXPERIENCE_PROVIDER/provider-1");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", cache: "no-store", redirect: "manual" });
    expect((fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer host-token");
  });

  it("accepts strict 200/201 saves, sends one normalized command and rejects target mismatch", async () => {
    const saved = { ...state, setting: { ...setting, enabled: false, revision: 4 } };
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => json(saved, 201));
    const client = createExperienceHostSupportSettingsApiClient({ nihoWebOrigin: "https://niho.example", idToken: "host-token", fetch: fetcher });
    expect((await client.put("SPOT", spot.id, command)).ok).toBe(true);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "PUT", body: JSON.stringify(command) });
    expect((fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    const wrong = createExperienceHostSupportSettingsApiClient({ nihoWebOrigin: "https://niho.example", idToken: "host-token", fetch: vi.fn(async () => json({ ...saved, host: provider })) });
    expect(await wrong.put("SPOT", spot.id, command)).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
  });

  it("accepts a maximum Unicode host page and rejects a body beyond the bounded cap", async () => {
    const maximum = { hosts: Array.from({ length: 100 }, (_, index) => ({ kind: "SPOT" as const, id: `${"😀".repeat(199)}${String.fromCodePoint(0x10000 + index)}`, displayName: "😀".repeat(200) })), limit: 100 as const, truncated: true };
    expect(decodeExperienceHostSupportSettingsHostListResponse({ ...list, hosts: [{ ...spot, displayName: "😀".repeat(201) }] })).toBeNull();
    const accepted = createExperienceHostSupportSettingsApiClient({ nihoWebOrigin: "https://niho.example", idToken: "host-token", fetch: vi.fn(async () => json(maximum)) });
    const result = await accepted.list();
    expect(result.ok && result.data.hosts).toHaveLength(100);
    const oversized = createExperienceHostSupportSettingsApiClient({ nihoWebOrigin: "https://niho.example", idToken: "host-token", fetch: vi.fn(async () => json({ ...list, padding: "x".repeat(270_000) })) });
    expect(await oversized.list()).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
  });

  it("rejects wrong media type, redirects and classifies known failures", async () => {
    const clientFor = (response: Response) => createExperienceHostSupportSettingsApiClient({ nihoWebOrigin: "https://niho.example", idToken: "host-token", fetch: vi.fn(async () => response) });
    expect(await clientFor(new Response(JSON.stringify(list), { headers: { "content-type": "text/plain" } })).list()).toEqual({ ok: false, kind: "unexpected_response", status: 200 });
    expect(await clientFor(json({}, 302)).list()).toEqual({ ok: false, kind: "unexpected_response", status: 302 });
    expect(await clientFor(json({}, 401)).list()).toEqual({ ok: false, kind: "rejected", status: 401 });
    expect(await clientFor(json({}, 403)).list()).toEqual({ ok: false, kind: "rejected", status: 403 });
    expect(await clientFor(json({}, 409)).put("SPOT", spot.id, command)).toEqual({ ok: false, kind: "conflict" });
    expect(await clientFor(json({}, 503)).put("SPOT", spot.id, command)).toEqual({ ok: false, kind: "unavailable", status: 503 });
  });

  it("classifies timeout/network failures without returning data", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")));
    }));
    const client = createExperienceHostSupportSettingsApiClient({ nihoWebOrigin: "https://niho.example", idToken: "host-token", timeoutMs: 1, fetch: fetcher });
    expect(await client.list()).toEqual({ ok: false, kind: "network_error" });
  });
});
