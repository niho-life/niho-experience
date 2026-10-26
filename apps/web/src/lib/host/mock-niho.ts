import { randomBytes } from "node:crypto";
import type { MockHostScenario } from "@niho-experience/api-client/host/mock";
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

/**
 * A fetch for the mock NIHO origin. Requires the synthetic Bearer token so the
 * relay's header handling is exercised. Each fetch has its own state: writes
 * (register, update, …) last only as long as this fetch.
 */
export function createMockHostFetch(scenario: HostMockScenario): typeof fetch {
  let mock: Promise<(input: string, init?: RequestInit) => Promise<Response>> | null = null;
  return async (input, init) => {
    const request = new Request(input, init);
    if (!request.headers.get("authorization")?.startsWith(`Bearer ${MOCK_ID_TOKEN_PREFIX}`)) return unauthorized();
    mock ??= loadMock().then(({ createMockExperienceHostFetch }) => createMockExperienceHostFetch({ scenario: HOST_MOCK_SCENARIO_MAP[scenario] }));
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return (await mock)(request.url, {
      method: request.method,
      headers: request.headers,
      ...(hasBody ? { body: await request.arrayBuffer() } : {}),
      signal: request.signal,
    });
  };
}
