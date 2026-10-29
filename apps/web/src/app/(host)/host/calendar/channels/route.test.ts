import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), statuses: vi.fn(), enabled: true }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { hostConsoleEnabled: true } }));
vi.mock("@/lib/experience/channel-runtime", () => ({
  channelManagerEnabled: () => mocks.enabled,
  channelJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));
vi.mock("@/lib/experience/calendar-actor", () => ({ calendarActor: mocks.actor }));
vi.mock("@/lib/experience/store-server", () => ({ channelRuntime: () => ({ hostStatuses: mocks.statuses }) }));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks(); mocks.enabled = true;
  mocks.actor.mockResolvedValue({ actor: { providerId: "provider-a", nihoUserId: "host-a" }, nihoRole: "OWNER" });
  mocks.statuses.mockResolvedValue([{ occurrenceId: "rule@2099-01-01", site: "Airbnb", desired: "CLOSED", label: "PENDING", externalAccountId: "must-not-leak" }]);
});

describe("host channel status", () => {
  it("uses the established HostActor scope and returns no external target identifiers", async () => {
    const response = await GET(new Request("https://experience.example/host/calendar/channels?providerId=provider-a"));
    expect(response.status).toBe(200);
    expect(mocks.statuses).toHaveBeenCalledWith({ providerId: "provider-a", nihoUserId: "host-a" });
    expect(JSON.stringify(await response.json())).not.toContain("must-not-leak");
  });

  it("rejects query widening before establishing an actor", async () => {
    expect((await GET(new Request("https://experience.example/host/calendar/channels?providerId=provider-a&productOperator=true"))).status).toBe(400);
    expect(mocks.actor).not.toHaveBeenCalled();
  });
});
