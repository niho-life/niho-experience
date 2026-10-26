import { describe, expect, it } from "vitest";
import { createMockHostFetch, hostMockScenario, MOCK_ID_TOKEN_PREFIX } from "./mock-niho";
import { mutationFromSameOrigin, relayRequestHeaders, relayResponseHeaders, relayUpstreamPath } from "./relay";
import { HOST_MOCK_SCENARIOS, type HostMockScenario } from "./session";

const SITE = "https://experience.example.test";

describe("relay path allowlist", () => {
  it("passes only the selected provider routes and GET auth/me", () => {
    expect(relayUpstreamPath("GET", ["experience-providers"])).toBe("/api/experience-providers");
    expect(relayUpstreamPath("PATCH", ["experience-providers", "p_1", "pages", "page-2"])).toBe("/api/experience-providers/p_1/pages/page-2");
    expect(relayUpstreamPath("POST", ["experience-providers", "p_1", "uploads", "policies"])).toBe("/api/experience-providers/p_1/uploads/policies");
    expect(relayUpstreamPath("DELETE", ["experience-providers", "p_1", "photos", "a.jpg"])).toBeNull();
    expect(relayUpstreamPath("GET", ["experience-providers", "p_1", "members"])).toBeNull();
    expect(relayUpstreamPath("GET", ["experience-providers", "p_1", "bookings"])).toBeNull();
    expect(relayUpstreamPath("GET", ["auth", "me"])).toBe("/api/auth/me");
  });

  it("compares whole segments, never prefixes", () => {
    expect(relayUpstreamPath("GET", ["experience-providers-admin"])).toBeNull();
    expect(relayUpstreamPath("GET", ["experience-provider"])).toBeNull();
    expect(relayUpstreamPath("GET", ["auth", "me", "sessions"])).toBeNull();
    expect(relayUpstreamPath("GET", ["auth", "mex"])).toBeNull();
    expect(relayUpstreamPath("GET", ["auth"])).toBeNull();
  });

  it("refuses other NIHO APIs and non-GET auth/me", () => {
    expect(relayUpstreamPath("GET", ["users"])).toBeNull();
    expect(relayUpstreamPath("GET", ["auth", "app-connections", "c1"])).toBeNull();
    expect(relayUpstreamPath("POST", ["auth", "me"])).toBeNull();
    expect(relayUpstreamPath("DELETE", ["auth", "me"])).toBeNull();
    expect(relayUpstreamPath("GET", [])).toBeNull();
  });

  it("refuses dot segments, encoded separators and odd characters", () => {
    expect(relayUpstreamPath("GET", ["experience-providers", "..", "users"])).toBeNull();
    expect(relayUpstreamPath("GET", ["experience-providers", "."])).toBeNull();
    expect(relayUpstreamPath("GET", ["experience-providers", "a/b"])).toBeNull();
    expect(relayUpstreamPath("GET", ["experience-providers", "a%2Fb"])).toBeNull();
    expect(relayUpstreamPath("GET", ["experience-providers", "a\\b"])).toBeNull();
    expect(relayUpstreamPath("GET", ["experience-providers", ""])).toBeNull();
    expect(relayUpstreamPath("GET", ["experience-providers", ...Array<string>(12).fill("x")])).toBeNull();
  });
});

describe("same-origin check for changes", () => {
  const headers = (values: Record<string, string>) => new Headers(values);

  it("does not restrict reads", () => {
    expect(mutationFromSameOrigin("GET", headers({}), SITE)).toBe(true);
  });

  it("accepts a change only with this origin and Sec-Fetch-Site: same-origin", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(mutationFromSameOrigin(method, headers({ origin: SITE, "sec-fetch-site": "same-origin" }), SITE)).toBe(true);
      expect(mutationFromSameOrigin(method, headers({ origin: SITE, "sec-fetch-site": "same-site" }), SITE)).toBe(false);
      expect(mutationFromSameOrigin(method, headers({ origin: SITE }), SITE)).toBe(false);
      expect(mutationFromSameOrigin(method, headers({ "sec-fetch-site": "same-origin" }), SITE)).toBe(false);
      expect(mutationFromSameOrigin(method, headers({ origin: "https://evil.example.test", "sec-fetch-site": "same-origin" }), SITE)).toBe(false);
      expect(mutationFromSameOrigin(method, headers({ origin: "null", "sec-fetch-site": "same-origin" }), SITE)).toBe(false);
      expect(mutationFromSameOrigin(method, headers({ origin: `${SITE}.evil.test`, "sec-fetch-site": "same-origin" }), SITE)).toBe(false);
    }
  });
});

describe("relay headers", () => {
  it("sends only API headers plus the Bearer token", () => {
    const incoming = new Headers({
      cookie: "__Secure-niho_host_session=secret",
      authorization: "Bearer from-the-browser",
      connection: "keep-alive",
      host: "experience.example.test",
      "x-forwarded-for": "203.0.113.1",
      "content-type": "application/json",
      accept: "application/json",
      "x-niho-page-updated-at": "2026-10-21T03:00:00.000Z",
    });
    const sent = relayRequestHeaders(incoming, "synthetic-id-token");
    expect(Object.fromEntries(sent)).toEqual({
      accept: "application/json",
      authorization: "Bearer synthetic-id-token",
      "content-type": "application/json",
      "x-niho-page-updated-at": "2026-10-21T03:00:00.000Z",
    });
  });

  it("never passes NIHO cookies or encodings back, and is never cached", () => {
    const upstream = new Headers({ "set-cookie": "session=1", "content-encoding": "gzip", "content-length": "10", "content-type": "application/json", "x-niho-page-updated-at": "t", "cache-control": "public, max-age=60" });
    expect(Object.fromEntries(relayResponseHeaders(upstream))).toEqual({ "cache-control": "private, no-store", "content-type": "application/json", "x-niho-page-updated-at": "t" });
  });
});

describe("synthetic provider API", () => {
  const auth = { headers: { authorization: `Bearer ${MOCK_ID_TOKEN_PREFIX}abc` } };

  it("requires the Bearer token the relay adds", async () => {
    expect((await createMockHostFetch("default")("https://niho.example.test/api/experience-providers")).status).toBe(401);
  });

  it("returns two providers by default and none for the empty scenario", async () => {
    const two = await (await createMockHostFetch("default")("https://niho.example.test/api/experience-providers", auth)).json();
    const none = await (await createMockHostFetch("empty")("https://niho.example.test/api/experience-providers", auth)).json();
    expect(two.providers).toHaveLength(2);
    expect(none.providers).toEqual([]);
    expect((await createMockHostFetch("default")("https://niho.example.test/api/auth/me", auth)).status).toBe(200);
  });

  it("maps the console's scenarios to the contract mock's", async () => {
    const ids = async (scenario: HostMockScenario) =>
      ((await (await createMockHostFetch(scenario)("https://niho.example.test/api/experience-providers", auth)).json()) as { providers: { id: string; memberRole: string }[] }).providers.map(({ id, memberRole }) => `${id}:${memberRole}`);
    expect(await ids("default")).toEqual(["sample-provider-kitchen:OWNER", "sample-provider-studio:EDITOR"]);
    expect(await ids("payments-pending")).toEqual(["sample-provider-garden:OWNER"]);
    expect(await ids("calendar-revoked")).toEqual(["sample-provider-kitchen:OWNER", "sample-provider-studio:EDITOR"]);
    expect(await ids("cohost")).toEqual(["sample-provider-kitchen:COHOST", "sample-provider-studio:EDITOR"]);
    expect(HOST_MOCK_SCENARIOS.map(hostMockScenario)).toEqual(HOST_MOCK_SCENARIOS);
    expect(hostMockScenario("two-providers")).toBe("default");
  });

  it("keeps writes within one fetch, and answers in the contract's error shape", async () => {
    const mock = createMockHostFetch("empty");
    const post = (body: unknown) => mock("https://niho.example.test/api/experience-providers", { method: "POST", headers: { ...auth.headers, "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer });
    const invalid = await post({});
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", details: {} } });
    const created = await post({ kind: "INDIVIDUAL", displayName: "合成の台所", bio: "", sellerDisclosureUrl: null, consentVersion: "sample-provider-consent-1" });
    expect(created.status).toBe(201);
    expect(((await (await mock("https://niho.example.test/api/experience-providers", auth)).json()) as { providers: unknown[] }).providers).toHaveLength(1);
  });
});
