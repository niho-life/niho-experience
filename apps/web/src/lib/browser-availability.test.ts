import { afterEach, expect, it, vi } from "vitest";
import type { ExperienceApiClient } from "@niho-experience/api-client";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("shares concurrent reads and immediately retries a failed read", async () => {
  const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue(new Response(JSON.stringify({
    generatedAt: new Date().toISOString(), timeZone: "Asia/Tokyo", windowDays: 90, occurrences: [],
  }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const { readAvailability } = await import("./browser-availability");
  const first = readAvailability("test-experience", false, "https://niho.life");
  expect(readAvailability("test-experience", false, "https://niho.life")).toBe(first);
  expect(await first).toEqual({ ok: false });
  expect(await readAvailability("test-experience", false, "https://niho.life")).toEqual({ ok: true, occurrences: [] });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("reads Japanese availability for a site sale from the site's public API", async () => {
  const api = {
    getAvailability: vi.fn().mockResolvedValue({ ok: true, data: { occurrences: [] } }),
    getJapaneseAvailability: vi.fn().mockResolvedValue({ ok: false }),
  } as unknown as ExperienceApiClient;
  const { readAvailabilityFromApi } = await import("./browser-availability");
  expect(await readAvailabilityFromApi(api, "synthetic-experience", "ja", "release-v1", "offer-1", {
    kind: "site", origin: "https://experience.example.test",
  })).toEqual([]);
  expect(api.getAvailability).toHaveBeenCalledWith("synthetic-experience", { offerId: "offer-1" });
  expect(api.getJapaneseAvailability).not.toHaveBeenCalled();
});
