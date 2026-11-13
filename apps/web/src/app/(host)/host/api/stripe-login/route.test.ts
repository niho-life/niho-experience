import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  url: "https://stripe.com/express/synthetic-one-time-link" as string | null,
  hostStripeLoginUrl: vi.fn(async () => state.url),
}));

vi.mock("@/host/stripe-login-server", () => ({ hostStripeLoginUrl: (...args: unknown[]) => state.hostStripeLoginUrl(...args as []), hostStripeReauthHref: async () => null }));
vi.mock("@/lib/config", () => ({ config: { hostConsoleEnabled: true, apiMode: "http" } }));
vi.mock("@/lib/host/relay", () => ({
  mutationFromSameOrigin: (_method: string, headers: Headers, origin: string) => headers.get("origin") === origin && headers.get("sec-fetch-site") === "same-origin",
}));
vi.mock("@/lib/host/providers", () => ({ nihoIdOrNull: (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null }));
vi.mock("@/lib/host/server", () => ({
  hostNotFound: () => Response.json({ error: "not_found" }, { status: 404 }),
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  siteOrigin: () => "https://experience.example",
}));

import { POST } from "./route";

function formRequest(body: string, options: { sameOrigin?: boolean; contentType?: string; url?: string } = {}) {
  return new Request(options.url ?? "https://experience.example/host/api/stripe-login", {
    method: "POST",
    headers: {
      origin: options.sameOrigin === false ? "https://attacker.example" : "https://experience.example",
      "sec-fetch-site": options.sameOrigin === false ? "cross-site" : "same-origin",
      "content-type": options.contentType ?? "application/x-www-form-urlencoded",
    },
    body,
  });
}

describe("POST /host/api/stripe-login", () => {
  beforeEach(() => {
    state.url = "https://stripe.com/express/synthetic-one-time-link";
    state.hostStripeLoginUrl.mockClear();
  });

  it("redirects to a no-store, no-referrer account-specific link for a same-origin form", async () => {
    const response = await POST(formRequest("providerId=provider_synthetic"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://stripe.com/express/synthetic-one-time-link");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(state.hostStripeLoginUrl).toHaveBeenCalledWith("provider_synthetic");
  });

  it("rejects cross-origin, malformed, repeated, and query-bearing requests before issuing a link", async () => {
    expect((await POST(formRequest("providerId=provider_synthetic", { sameOrigin: false }))).status).toBe(403);
    expect((await POST(formRequest("providerId=provider_synthetic&providerId=other"))).status).toBe(400);
    expect((await POST(formRequest("providerId=bad%20id"))).status).toBe(400);
    expect((await POST(formRequest("providerId=provider_synthetic", { url: "https://experience.example/host/api/stripe-login?next=https://evil.example" }))).status).toBe(400);
    expect(state.hostStripeLoginUrl).not.toHaveBeenCalled();
  });

  it("falls back to Stripe's generic Express login if the server cannot identify one account", async () => {
    state.url = null;
    const response = await POST(formRequest("providerId=provider_synthetic"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://connect.stripe.com/express_login");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
