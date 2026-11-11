import { expect, it, vi } from "vitest";
import { resolveConfig } from "@/lib/resolve-config";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  repository: { getCompensation: vi.fn(), calculateCompensation: vi.fn() },
}));

vi.mock("@/lib/config", () => ({
  get config() { return resolveConfig(process.env); },
}));
vi.mock("@/lib/admin/server", () => ({
  isAdminHttp: () => true,
  adminMutationAllowed: () => true,
  loadAdminHttpSession: mocks.load,
  adminJson: (body: unknown, status = 200) => Response.json(body, { status }),
}));
vi.mock("@/lib/experience/store-server", () => ({
  managedExperienceSalesRepository: () => mocks.repository,
}));

import { GET, POST } from "./route";

it("allows an authenticated admin to settle an accepted booking after new sales stop", async () => {
  const bookingId = "00000000-0000-4000-8000-000000000221";
  const commandId = "00000000-0000-4000-8000-000000000222";
  const url = `https://experience.example/admin/api/site-bookings/managed-compensation/${bookingId}`;
  const context = { params: Promise.resolve({ publicBookingId: bookingId }) };
  const post = () => new Request(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "CALCULATE", commandId }),
  });
  vi.stubEnv("EXPERIENCE_API_MODE", "http");
  vi.stubEnv("EXPERIENCE_MANAGED_SALES_ENABLED", "false");
  try {
    vi.stubEnv("EXPERIENCE_MANAGED_SALES_WEBHOOKS_ENABLED", "false");
    expect((await GET(new Request(url), context)).status).toBe(404);
    expect(mocks.load).not.toHaveBeenCalled();

    vi.stubEnv("EXPERIENCE_MANAGED_SALES_WEBHOOKS_ENABLED", "true");
    mocks.load.mockResolvedValueOnce({ status: "rejected" });
    expect((await POST(post(), context)).status).toBe(401);
    expect(mocks.repository.calculateCompensation).not.toHaveBeenCalled();

    mocks.load.mockResolvedValue({ status: "ok", actor: { id: "admin-a" } });
    mocks.repository.getCompensation.mockResolvedValue({ status: "DUE" });
    mocks.repository.calculateCompensation.mockResolvedValue({ status: "DUE" });
    expect((await GET(new Request(url), context)).status).toBe(200);
    expect((await POST(post(), context)).status).toBe(200);
    expect(mocks.repository.getCompensation).toHaveBeenCalledWith(bookingId);
    expect(mocks.repository.calculateCompensation).toHaveBeenCalledWith({ nihoUserId: "admin-a" }, bookingId, commandId);
  } finally {
    vi.unstubAllEnvs();
  }
});
