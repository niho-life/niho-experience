import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { apiMode: "http" as "http" | "mock", experiencePublicationsEnabled: true },
  repository: {
    listPublic: vi.fn(),
    getPublicBySlug: vi.fn(),
    getPublicMediaAsset: vi.fn(),
    getPublicProviderMediaAsset: vi.fn(),
  },
  storage: { read: vi.fn() },
}));

vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/experience/store-server", () => ({
  experiencePublicationRepository: () => mocks.repository,
}));
vi.mock("@/lib/experience/public-media-storage", () => ({
  experiencePublicMediaStorage: () => mocks.storage,
}));
vi.mock("@/lib/experience/public-http", () => ({
  publicEmpty: (status: number) => new Response(null, { status }),
  publicJson: (status: number, value: unknown) => Response.json(value, { status }),
}));

import { GET as catalog } from "@/app/api/public/experiences/route";
import { GET as detail } from "@/app/api/public/experiences/[slug]/route";
import { GET as media } from "@/app/api/public/experience-media/[assetId]/route";
import { GET as providerMedia } from "@/app/api/public/experience-provider-media/[assetId]/route";

const publication = {
  slug: "synthetic-experience",
  publicTitle: "Synthetic experience",
  currency: "JPY",
  unitAmount: 8_000,
  photos: [{ src: "/api/public/experience-media/00000000-0000-4000-8000-000000000451", alt: "Synthetic photo", credit: null }],
  offers: [],
};
const assetId = "00000000-0000-4000-8000-000000000451";

describe("Experience public publication routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.apiMode = "http";
    mocks.config.experiencePublicationsEnabled = true;
    mocks.repository.listPublic.mockResolvedValue([publication]);
    mocks.repository.getPublicBySlug.mockResolvedValue(publication);
    mocks.repository.getPublicMediaAsset.mockResolvedValue({ objectKey: `experience-products/${assetId}.jpg`, byteSize: 4 });
    mocks.repository.getPublicProviderMediaAsset.mockResolvedValue({ objectKey: `experience-provider-media/${assetId}.jpg`, byteSize: 4 });
    mocks.storage.read.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });

  it("serves the Experience catalog in HTTP mode regardless of the old publication switch", async () => {
    const response = await catalog();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ experiences: [publication] });
    expect(mocks.repository.listPublic).toHaveBeenCalledOnce();

    mocks.config.experiencePublicationsEnabled = false;
    expect((await catalog()).status).toBe(200);
    expect(mocks.repository.listPublic).toHaveBeenCalledTimes(2);
    mocks.config.apiMode = "mock";
    expect((await catalog()).status).toBe(404);
  });

  it("serves only currently public details and hides unavailable slugs uniformly", async () => {
    const context = { params: Promise.resolve({ slug: publication.slug }) };
    const response = await detail(new Request(`https://experience.example/api/public/experiences/${publication.slug}`), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ experience: publication });
    expect(mocks.repository.getPublicBySlug).toHaveBeenCalledWith(publication.slug);

    mocks.repository.getPublicBySlug.mockResolvedValue(null);
    const hidden = await detail(new Request("https://experience.example/api/public/experiences/stopped"), {
      params: Promise.resolve({ slug: "stopped" }),
    });
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).toBe("");
  });

  it("relays only active rights-confirmed JPEG media and never exposes the storage key", async () => {
    const response = await media(new Request(`https://experience.example/api/public/experience-media/${assetId}`), {
      params: Promise.resolve({ assetId }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.arrayBuffer()).toEqual(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer);
    expect(mocks.repository.getPublicMediaAsset).toHaveBeenCalledWith(assetId);
    expect(mocks.storage.read).toHaveBeenCalledWith(`experience-products/${assetId}.jpg`);

    mocks.repository.getPublicMediaAsset.mockResolvedValue(null);
    expect((await media(new Request(`https://experience.example/api/public/experience-media/${assetId}`), {
      params: Promise.resolve({ assetId }),
    })).status).toBe(404);
  });

  it("relays a seller profile image only while selected and public", async () => {
    const response = await providerMedia(new Request(`https://experience.example/api/public/experience-provider-media/${assetId}`), {
      params: Promise.resolve({ assetId }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.arrayBuffer()).toEqual(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer);
    expect(mocks.repository.getPublicProviderMediaAsset).toHaveBeenCalledWith(assetId);
    expect(mocks.storage.read).toHaveBeenCalledWith(`experience-provider-media/${assetId}.jpg`);

    mocks.repository.getPublicProviderMediaAsset.mockResolvedValue(null);
    expect((await providerMedia(new Request(`https://experience.example/api/public/experience-provider-media/${assetId}`), {
      params: Promise.resolve({ assetId }),
    })).status).toBe(404);
  });

  it("rejects malformed media ids and byte lengths without serving content", async () => {
    expect((await media(new Request("https://experience.example/api/public/experience-media/not-a-uuid"), {
      params: Promise.resolve({ assetId: "not-a-uuid" }),
    })).status).toBe(404);
    mocks.storage.read.mockResolvedValue(Buffer.from([0xff, 0xd8]));
    expect((await media(new Request(`https://experience.example/api/public/experience-media/${assetId}`), {
      params: Promise.resolve({ assetId }),
    })).status).toBe(503);
  });
});
