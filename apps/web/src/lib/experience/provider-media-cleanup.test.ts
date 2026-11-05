import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { cleanupProviderMedia } from "./provider-media-cleanup";

const first = {
  assetId: "00000000-0000-4000-8000-000000000001",
  objectKey: "experience-provider-media/00000000-0000-4000-8000-000000000001.jpg",
};
const second = {
  assetId: "00000000-0000-4000-8000-000000000002",
  objectKey: "experience-provider-media/00000000-0000-4000-8000-000000000002.jpg",
};

describe("provider media cleanup", () => {
  const repository = { claim: vi.fn(), complete: vi.fn() };
  const storage = { remove: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    repository.complete.mockResolvedValue(true);
    storage.remove.mockResolvedValue(undefined);
  });

  it("continues after a storage failure and deletes the failed object on a later run", async () => {
    repository.claim.mockResolvedValueOnce([first, second]).mockResolvedValueOnce([first]);
    storage.remove.mockRejectedValueOnce(new Error("synthetic storage outage"));

    expect(await cleanupProviderMedia({ repository, storage })).toEqual({ claimed: 2, deleted: 1, stale: 0, failed: 1 });
    expect(repository.complete).toHaveBeenCalledExactlyOnceWith(second);

    expect(await cleanupProviderMedia({ repository, storage })).toEqual({ claimed: 1, deleted: 1, stale: 0, failed: 0 });
    expect(repository.complete).toHaveBeenLastCalledWith(first);
  });

  it("treats an already absent object as success when storage remove is idempotent", async () => {
    repository.claim.mockResolvedValueOnce([first]);
    storage.remove.mockResolvedValueOnce(undefined);
    expect(await cleanupProviderMedia({ repository, storage })).toEqual({ claimed: 1, deleted: 1, stale: 0, failed: 0 });
  });

  it("fails closed without calling storage for a key outside the exact asset path", async () => {
    const unsafe = { ...first, objectKey: "experience-provider-media/../other-object.jpg" };
    repository.claim.mockResolvedValueOnce([unsafe]);
    expect(await cleanupProviderMedia({ repository, storage })).toEqual({ claimed: 1, deleted: 0, stale: 0, failed: 1 });
    expect(storage.remove).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it("does not mark a claim complete when eligibility changed after deletion", async () => {
    repository.claim.mockResolvedValueOnce([first]);
    repository.complete.mockResolvedValueOnce(false);
    expect(await cleanupProviderMedia({ repository, storage })).toEqual({ claimed: 1, deleted: 0, stale: 1, failed: 0 });
  });
});
