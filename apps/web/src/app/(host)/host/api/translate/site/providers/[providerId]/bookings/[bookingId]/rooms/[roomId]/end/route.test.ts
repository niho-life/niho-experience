import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ allowed: vi.fn(() => true), load: vi.fn(), end: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/host/translate-rooms-server", () => ({
  translateRoomsMutationAllowed: mocks.allowed,
  readEmptyTranslateBody: async (request: Request) => (await request.text()) === "",
  loadSiteTranslateRoomsClient: mocks.load,
  translateRoomsJson: (body: unknown, status = 200) => Response.json(body, { status }),
  translateRoomsFailure: () => Response.json({ error: "upstream" }, { status: 502 }),
}));

import { POST } from "./route";

it("site room endは取消後も所属を再検証し、実APIの終了DTOからbrowser DTOだけ返す", async () => {
  mocks.end.mockResolvedValue({ ok: true, data: { roomId: "room_1", state: "ended" } });
  mocks.load.mockResolvedValue({ ok: true, client: { endSiteRoom: mocks.end } });
  const request = new Request("https://experience.example/host/api/translate/site/x", { method: "POST" });
  const response = await POST(request, { params: Promise.resolve({ providerId: "provider_1", bookingId: "00000000-0000-4000-8000-00000000b101", roomId: "room_1" }) });
  expect(response.status).toBe(200);
  expect(mocks.load).toHaveBeenCalledWith("provider_1", "00000000-0000-4000-8000-00000000b101", "end");
  expect(await response.json()).toEqual({ state: "ended" });
});
