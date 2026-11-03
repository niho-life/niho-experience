import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), get: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/host/translate-rooms-server", () => ({
  loadSiteTranslateRoomsClient: mocks.load,
  translateRoomsJson: (body: unknown, status = 200) => Response.json(body, { status }),
  translateRoomsFailure: () => Response.json({ error: "upstream" }, { status: 502 }),
}));

import { GET } from "./route";

it("site room statusは予約所属を再検証しsite clientで読む", async () => {
  mocks.get.mockResolvedValue({ ok: true, data: { state: "waiting", participants: [], usageMinutes: 0 } });
  mocks.load.mockResolvedValue({ ok: true, client: { getSiteRoom: mocks.get } });
  const response = await GET(new Request("https://experience.example/host/api/translate/site/x"), { params: Promise.resolve({ providerId: "provider_1", bookingId: "00000000-0000-4000-8000-00000000b101", roomId: "room_1" }) });
  expect(response.status).toBe(200);
  expect(mocks.load).toHaveBeenCalledWith("provider_1", "00000000-0000-4000-8000-00000000b101", "status");
  expect(mocks.get).toHaveBeenCalledWith("provider_1", "00000000-0000-4000-8000-00000000b101", "room_1");
});
