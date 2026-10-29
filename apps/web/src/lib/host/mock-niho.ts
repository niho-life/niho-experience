import { randomBytes } from "node:crypto";
import type { MockHostScenario } from "@niho-experience/api-client/host/mock";
import { createMockTranslateRooms } from "./mock-translate-rooms";
import type { HostMockScenario } from "./session";

/**
 * NIHO's host API in mock mode (EXPERIENCE_API_MODE=mock): the synthetic,
 * contract-checked mock from `@niho-experience/api-client/host/mock` (#87),
 * loaded only when a mock session calls it. Invented data only.
 */
export const MOCK_ID_TOKEN_PREFIX = "mock-id-token.";

export function mockToken(prefix: string): string {
  return `${prefix}${randomBytes(16).toString("base64url")}`;
}

/** `?mock=` on /host/auth/mock-login → the session's scenario (anything else is the default). */
export function hostMockScenario(value: unknown): HostMockScenario {
  return value === "empty" || value === "payments-pending" || value === "calendar-revoked" || value === "cohost" ? value : "default";
}

/**
 * The console's scenario names → the api-client mock's. `default` is two providers (an OWNER and an
 * EDITOR); `calendar-revoked` is the same two, and only the console's own data differs (console-data.ts).
 */
export const HOST_MOCK_SCENARIO_MAP: Record<HostMockScenario, MockHostScenario> = {
  default: "two-providers",
  empty: "empty",
  "payments-pending": "payments-pending",
  "calendar-revoked": "two-providers",
  cohost: "cohost",
};

const loadMock = () => import("@niho-experience/api-client/host/mock");

/** The synthetic signed-in host's display name. */
export async function mockHostDisplayName(): Promise<string> {
  return (await loadMock()).MOCK_HOST_USER.displayName;
}

const unauthorized = () =>
  new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "mock: UNAUTHORIZED", details: {} } }), { status: 401, headers: { "content-type": "application/json" } });

/** 対面通訳の部屋 (#181): kept for the process, so the screen's polling and 終了 find the room it made. */
const translateRooms = createMockTranslateRooms();

/**
 * A fetch for the mock NIHO origin. Requires the synthetic Bearer token so the
 * relay's header handling is exercised. Each fetch has its own state: writes
 * (register, update, …) last only as long as this fetch. Translate rooms are the
 * exception (mock-translate-rooms.ts); they are answered before the api-client mock.
 */
export function createMockHostFetch(scenario: HostMockScenario): typeof fetch {
  let mock: Promise<(input: string, init?: RequestInit) => Promise<Response>> | null = null;
  const upstream = async () => (mock ??= loadMock().then(({ createMockExperienceHostFetch }) => createMockExperienceHostFetch({ scenario: HOST_MOCK_SCENARIO_MAP[scenario] })));
  return async (input, init) => {
    const request = new Request(input, init);
    if (!request.headers.get("authorization")?.startsWith(`Bearer ${MOCK_ID_TOKEN_PREFIX}`)) return unauthorized();
    const translated = await translateRooms.route(request, {
      now: Date.now,
      providerExists: async (providerId) => (await (await upstream())(new URL(`/api/experience-providers/${encodeURIComponent(providerId)}`, request.url).href, { method: "GET", headers: request.headers })).status === 200,
    });
    if (translated) return translated;
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return (await upstream())(request.url, {
      method: request.method,
      headers: request.headers,
      ...(hasBody ? { body: await request.arrayBuffer() } : {}),
      signal: request.signal,
    });
  };
}
